import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  realpathSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import { spawnSync } from "node:child_process"
import ignore from "ignore"
import type { Ignore } from "ignore"
import type { TaskRepository } from "../storage.ts"
import type { TaskProposal } from "../task.ts"

type FileRecord = { path: string; stamp: string; content: string; outline: string; bytes: number }
type Snapshot = {
  version: 1
  id: string
  workspace: string
  createdAt: number
  repomix: "1.18.1"
  encoding: "o200k_base"
  tokens: number
  files: FileRecord[]
}
type Principal = { sessionID: string; agent: string }
type Permission = (path: string, principal: Principal) => Promise<boolean>
export type Focus = {
  paths?: string[]
  search?: string
  level?: "full" | "outline" | "structure"
  startLine?: number
  endLine?: number
}
const maxFile = 512 * 1024
const matchesPath = (pattern: string, path: string) =>
  new Bun.Glob(pattern).match(path) || path.startsWith(`${pattern.replace(/\/$/, "")}/`)
const secret = (path: string) =>
  /(^|\/)(?:\.env(?:\..*)?|[^/]*\.(?:pem|key|p12|pfx)|id_(?:rsa|ed25519)|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?)$/i.test(
    path,
  ) && !/(?:^|\/)\.env\.example$/.test(path)

/** Reads at most maxFile+1 bytes. Rejects symlinks and changed inode/metadata. */
function readSource(root: string, path: string): string {
  if (isAbsolute(path) || path.split("/").some((p) => p === ".." || p === "."))
    throw new Error("Invalid source path")
  let parent = root
  for (const part of path.split("/")) {
    parent = join(parent, part)
    if (lstatSync(parent).isSymbolicLink()) throw new Error("Symlink source is excluded")
  }
  const absolute = join(root, path)
  const actual = realpathSync(absolute)
  if (relative(root, actual).startsWith("..") || isAbsolute(relative(root, actual)))
    throw new Error("Source escaped workspace")
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size > maxFile) throw new Error("Source exceeds per-file bound")
    const bytes = Buffer.alloc(Math.min(maxFile + 1, before.size + 1))
    let offset = 0
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, null)
      if (!n) break
      offset += n
    }
    const after = fstatSync(fd),
      linked = lstatSync(absolute)
    if (
      offset > maxFile ||
      after.size !== offset ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== linked.ino ||
      before.dev !== linked.dev ||
      realpathSync(absolute) !== actual
    )
      throw new Error("Source changed while collecting")
    const value = bytes.subarray(0, offset)
    if (value.includes(0)) throw new Error("Binary source is excluded")
    return new TextDecoder("utf-8", { fatal: true }).decode(value)
  } finally {
    closeSync(fd)
  }
}

export class ProjectIndex {
  private readonly cacheID: string
  private counter?: import("repomix").TokenCounter
  private active?: Promise<Snapshot>
  constructor(
    readonly root: string,
    readonly cacheDirectory: string,
    readonly repository: TaskRepository,
    readonly allow: Permission,
  ) {
    this.root = realpathSync(root)
    mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 })
    repository.atomic((db) =>
      db.exec(
        `CREATE TABLE IF NOT EXISTS context_workspaces(workspace TEXT PRIMARY KEY,id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS context_cache(workspace TEXT NOT NULL,selection TEXT NOT NULL,stamp TEXT NOT NULL,file TEXT NOT NULL,PRIMARY KEY(workspace,selection));`,
      ),
    )
    this.cacheID = repository.atomic((db) => {
      db.query("INSERT OR IGNORE INTO context_workspaces VALUES(?,?)").run(
        this.root,
        crypto.randomUUID().replaceAll("-", ""),
      )
      return db
        .query<{ id: string }, [string]>("SELECT id FROM context_workspaces WHERE workspace=?")
        .get(this.root)!.id
    })
  }
  private async tokenizer() {
    if (!this.counter) {
      const { TokenCounter } = await import("repomix")
      this.counter = new TokenCounter("o200k_base")
      await this.counter.init()
    }
    return this.counter
  }
  private evict() {
    const snapshots = readdirSync(this.cacheDirectory)
      .filter((p) => p.endsWith(".json"))
      .map((name) => {
        const path = join(this.cacheDirectory, name)
        const stat = statSync(path)
        return { path, name, size: stat.size, mtime: stat.mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
    let bytes = 0
    const perWorkspace = new Map<string, number>()
    for (const item of snapshots) {
      const workspace = item.name.split("-")[0]!
      const count = (perWorkspace.get(workspace) ?? 0) + 1
      perWorkspace.set(workspace, count)
      if (Date.now() - item.mtime > 86400000 || count > 2 || bytes + item.size > 256 * 1024 * 1024)
        unlinkSync(item.path)
      else bytes += item.size
    }
  }
  async snapshot(principal: Principal, selection: string[] = []): Promise<Snapshot> {
    // Concurrent callers may share work only with identical authority. No cross-session permission cache.
    if (this.active) await this.active.catch(() => {})
    const promise = this.collect(principal, selection)
    this.active = promise
    try {
      return await promise
    } finally {
      if (this.active === promise) this.active = undefined
    }
  }
  private async collect(principal: Principal, selection: string[]): Promise<Snapshot> {
    this.evict()
    const started = Date.now()
    const { defaultIgnoreList } = await import("repomix")
    const ignores = defaultIgnoreList.map((pattern) => new Bun.Glob(pattern))
    const selected: { path: string; content: string; stamp: string; bytes: number }[] = []
    let visited = 0,
      total = 0
    const walk = async (path: string, inherited: { base: string; rules: Ignore }[] = []) => {
      const rules = [...inherited]
      for (const control of [".ignore", ".repomixignore"]) {
        const name = path ? `${path}/${control}` : control
        if (existsSync(join(this.root, name))) {
          if (!(await this.allow(name, principal)))
            throw new Error("Cannot establish permitted project ignore policy")
          rules.push({
            base: path ? `${path}/` : "",
            rules: ignore().add(readSource(this.root, name)),
          })
        }
      }
      const directory = opendirSync(join(this.root, path))
      try {
        while (true) {
          const entry = directory.readSync()
          if (!entry) break
          if (++visited > 20000 || Date.now() - started > 30000)
            throw new Error("Project enumeration exceeded 20,000 entries/30 seconds")
          const name = path ? `${path}/${entry.name}` : entry.name
          if (
            name.length > 1024 ||
            secret(name) ||
            entry.isSymbolicLink() ||
            ignores.some(
              (p) => p.match(name) || (entry.isDirectory() && p.match(`${name}/__entry__`)),
            )
          )
            continue
          if (
            rules.some((rule) =>
              rule.rules.ignores(name.slice(rule.base.length) + (entry.isDirectory() ? "/" : "")),
            )
          )
            continue
          const ignored = spawnSync("git", ["check-ignore", "--no-index", "--quiet", "--", name], {
            cwd: this.root,
            timeout: 1000,
            stdio: "ignore",
          })
          if (ignored.status === 0) continue
          if (ignored.status !== 1) throw new Error("Cannot establish repository ignore policy")
          if (entry.isDirectory()) {
            await walk(name, rules)
            continue
          }
          if (!entry.isFile() || !(await this.allow(name, principal))) continue
          let content: string
          try {
            content = readSource(this.root, name)
          } catch {
            continue
          }
          const bytes = Buffer.byteLength(content)
          total += bytes
          if (selected.length >= 5000 || total > 32 * 1024 * 1024)
            throw new Error("Project source exceeds 5,000 files/32 MiB; narrow indexing policy")
          const stat = statSync(join(this.root, name))
          selected.push({
            path: name,
            content,
            stamp: JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs]),
            bytes,
          })
        }
      } finally {
        directory.closeSync()
      }
    }
    await walk("")
    selected.sort((a, b) => a.path.localeCompare(b.path))
    const view = JSON.stringify([...selection].sort())
    const stamp = JSON.stringify(selected.map(({ path, stamp }) => ({ path, stamp })))
    const previous = this.repository.atomic((db) =>
      db
        .query<{ stamp: string; file: string }, [string, string]>(
          "SELECT stamp,file FROM context_cache WHERE workspace=? AND selection=?",
        )
        .get(this.root, view),
    )
    if (previous?.stamp === stamp && existsSync(join(this.cacheDirectory, previous.file))) {
      const cache = join(this.cacheDirectory, previous.file)
      if (statSync(cache).size > 64 * 1024 * 1024) throw new Error("Invalid cached snapshot size")
      const stored = JSON.parse(readFileSync(cache, "utf8")) as Snapshot
      if (stored.version === 1 && stored.workspace === this.root) return stored
      throw new Error("Invalid cached snapshot identity")
    }
    const identity = crypto.randomUUID()
    const filename = `${this.cacheID}-${identity}.json`
    const cache = join(this.cacheDirectory, filename)
    const packed = await new Promise<{
      files: { path: string; content: string }[]
      denied: string[]
      tokens: number
    }>((resolve, reject) => {
      const worker = new Worker(new URL("./processor.ts", import.meta.url).href, { type: "module" })
      const timer = setTimeout(
        () => {
          worker.terminate()
          reject(new Error("Repomix indexing exceeded 30 seconds"))
        },
        Math.max(1, 30000 - (Date.now() - started)),
      )
      worker.onmessage = (
        event: MessageEvent<{
          ok: boolean
          error?: string
          files: { path: string; content: string }[]
          denied: string[]
          tokens: number
        }>,
      ) => {
        clearTimeout(timer)
        worker.terminate()
        event.data.ok ? resolve(event.data) : reject(new Error(event.data.error))
      }
      worker.onerror = (event) => {
        clearTimeout(timer)
        worker.terminate()
        reject(new Error(event.message))
      }
      worker.postMessage({
        root: this.root,
        files: selected.map(({ path, content }) => ({
          path,
          content,
          level: (
            !selection.length
              ? /\.(?:[cm]?[jt]sx?|py|rs|go|java|rb|c|cpp|h|cs|swift|kt)$/.test(path)
              : selection.some((p) => matchesPath(p, path))
          )
            ? "compress"
            : "directory-only",
        })),
      })
    })
    const denied = new Set(packed.denied)
    const outline = new Map(packed.files.map((f) => [f.path, f.content]))
    const snapshot: Snapshot = {
      version: 1,
      id: identity,
      workspace: this.root,
      createdAt: Date.now(),
      repomix: "1.18.1",
      encoding: "o200k_base",
      tokens: packed.tokens,
      files: selected
        .filter((f) => !denied.has(f.path))
        .map((f) => ({ ...f, outline: outline.get(f.path) ?? "" })),
    }
    const text = JSON.stringify(snapshot)
    if (Buffer.byteLength(text) > 64 * 1024 * 1024) throw new Error("Snapshot exceeds 64 MiB")
    writeFileSync(`${cache}.tmp`, text, { mode: 0o600 })
    renameSync(`${cache}.tmp`, cache)
    this.repository.atomic((db) =>
      db
        .query(
          "INSERT INTO context_cache VALUES(?,?,?,?) ON CONFLICT(workspace,selection) DO UPDATE SET stamp=excluded.stamp,file=excluded.file",
        )
        .run(this.root, view, stamp, filename),
    )
    this.evict()
    return snapshot
  }
  async manifest(principal: Principal, paths: string[] = []) {
    const snapshot = await this.snapshot(principal, paths)
    const matches = snapshot.files
      .filter((f) => !paths.length || paths.some((p) => matchesPath(p, f.path)))
      .slice(0, 100)
    return {
      snapshotID: snapshot.id,
      workspace: this.root,
      repomix: snapshot.repomix,
      encoding: snapshot.encoding,
      totalFiles: snapshot.files.length,
      packedTokens: snapshot.tokens,
      files: matches.map(({ path, bytes }) => ({ path, bytes })),
      truncated: snapshot.files.length > matches.length,
    }
  }
  async evidence(principal: Principal, focus: Focus) {
    const snapshot = await this.snapshot(principal, focus.paths ?? [])
    const paths = focus.paths ?? []
    const matches = snapshot.files
      .filter(
        (f) =>
          (!paths.length || paths.some((p) => matchesPath(p, f.path))) &&
          (!focus.search || f.content.toLowerCase().includes(focus.search.toLowerCase())),
      )
      .slice(0, 50)
    const sources = matches.map((f) => {
      const lines = f.content.split("\n"),
        start = focus.startLine ?? 1,
        end = Math.min(focus.endLine ?? lines.length, lines.length)
      return {
        path: f.path,
        revision: null,
        startLine: start,
        endLine: end,
        level: focus.level ?? "full",
        text:
          focus.level === "structure"
            ? ""
            : focus.level === "outline"
              ? f.outline
              : lines.slice(start - 1, end).join("\n"),
      }
    })
    return {
      snapshotID: snapshot.id,
      encoding: snapshot.encoding,
      sources,
      truncated: matches.length === 50,
    }
  }

  async packet(
    principal: Principal,
    proposal: TaskProposal,
    skills: { id: string; path: string; content: string; revision: string }[],
    source: string,
  ) {
    const snapshot = await this.snapshot(principal)
    const references = new Map<string, { start: number; end: number }[]>()
    for (const ref of proposal.context) {
      for (const match of ref.reference.matchAll(
        /((?:\.?[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:md|tsx?|json|yaml|yml))(?::(\d+)(?:-(\d+))?)?/g,
      )) {
        const path = match[1]!
        const ranges = references.get(path) ?? []
        if (match[2]) {
          const start = Number(match[2]),
            end = Number(match[3] ?? match[2])
          if (start > 0 && end >= start) ranges.push({ start, end })
        }
        references.set(path, ranges)
      }
    }
    const required = ["AGENTS.md", "README.md"].filter((path) => existsSync(join(this.root, path)))
    const missing = required.filter((path) => !snapshot.files.some((file) => file.path === path))
    for (const path of references.keys())
      if (existsSync(join(this.root, path)) && !snapshot.files.some((file) => file.path === path))
        missing.push(path)
    if (missing.length) throw new Error(`Mandatory context unavailable: ${missing.join(", ")}`)
    const scopes = proposal.writeScope.map((pattern) => new Bun.Glob(pattern))
    const candidates = snapshot.files.filter(
      (file) =>
        required.includes(file.path) ||
        references.has(file.path) ||
        scopes.some((scope) => scope.match(file.path)),
    )
    candidates.sort(
      (a, b) =>
        Number(required.includes(b.path)) - Number(required.includes(a.path)) ||
        Number(references.has(b.path)) - Number(references.has(a.path)) ||
        Number(/(?:test|spec)\./.test(b.path)) - Number(/(?:test|spec)\./.test(a.path)) ||
        a.path.localeCompare(b.path),
    )
    const entries: {
      path: string
      revision: string | null
      level: "full" | "outline"
      text: string
    }[] = []
    const counter = await this.tokenizer()
    const deferred: string[] = []
    const base = {
      task: proposal,
      skills,
      source,
      snapshotID: snapshot.id,
      recipe: "task-context/2",
      deferred,
      entries,
    }
    const limit = 24000
    for (const file of candidates) {
      const mandatory = required.includes(file.path) || references.has(file.path)
      const full = mandatory || /(?:test|spec)\./.test(file.path) || file.path.endsWith(".md")
      const ranges = references.get(file.path) ?? []
      const lines = file.content.split("\n")
      const entry = {
        path: file.path,
        revision: null,
        level: full ? ("full" as const) : ("outline" as const),
        text: ranges.length
          ? ranges
              .map(
                ({ start, end }) =>
                  `[Lines ${start}-${Math.min(end, lines.length)}]\n${lines.slice(start - 1, end).join("\n")}`,
              )
              .join("\n")
          : full
            ? file.content
            : file.outline,
      }
      entries.push(entry)
      if (counter.countTokens(JSON.stringify(base)) > limit) {
        entries.pop()
        if (required.includes(file.path))
          throw new Error(`Repository guidance exceeds reserved ${limit} tokens: ${file.path}`)
        deferred.push(file.path)
      }
    }
    const text = JSON.stringify(base)
    if (counter.countTokens(text) > limit)
      throw new Error("Task and required guidance exceed context reservation")
    return {
      text,
      metadata: {
        snapshotID: snapshot.id,
        source,
        recipe: "task-context/2",
        deferred,
        tokens: counter.countTokens(text),
        encoding: "o200k_base",
        paths: entries.map(({ path, revision, level }) => ({ path, revision, level })),
        omitted: candidates.length - entries.length,
      },
    }
  }
  close() {
    this.counter?.free()
    this.counter = undefined
  }
}
