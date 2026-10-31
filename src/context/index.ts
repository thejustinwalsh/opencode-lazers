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
import { createHash } from "node:crypto"
import { isAbsolute, join, relative } from "node:path"
import { spawnSync } from "node:child_process"
import ignore from "ignore"
import type { Ignore } from "ignore"
import { fingerprint } from "../identity.ts"
import type { TaskRepository } from "../storage.ts"
import type { TaskProposal } from "../task.ts"

type FileRecord = { path: string; hash: string; content: string; outline: string; bytes: number }
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
const digest = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex")
const maxFile = 512 * 1024
const maxResponse = 16 * 1024
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
        `CREATE TABLE IF NOT EXISTS context_receipts(id TEXT PRIMARY KEY,project_directory TEXT NOT NULL,workspace TEXT NOT NULL,session_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,sources TEXT NOT NULL,created_at INTEGER NOT NULL);`,
      ),
    )
  }
  private async tokenizer() {
    if (!this.counter) {
      const { TokenCounter } = await import("repomix")
      this.counter = new TokenCounter("o200k_base")
      await this.counter.init()
    }
    return this.counter
  }
  private async bounded<T>(value: T): Promise<T> {
    const text = JSON.stringify(value)
    if (Buffer.byteLength(text) > maxResponse || (await this.tokenizer()).countTokens(text) > 4000)
      throw new Error("Response exceeds 16 KiB/4,000 tokens; narrow paths or line range")
    return value
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
    const selected: { path: string; content: string; hash: string; bytes: number }[] = []
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
          selected.push({ path: name, content, hash: digest(content), bytes })
        }
      } finally {
        directory.closeSync()
      }
    }
    await walk("")
    selected.sort((a, b) => a.path.localeCompare(b.path))
    const identity = fingerprint({
      workspace: this.root,
      files: selected.map(({ path, hash }) => ({ path, hash })),
      repomix: "1.18.1",
      recipe: "outline/2",
      ignorePolicy: "repomix-default+git+secret/1",
    })
    const cache = join(
      this.cacheDirectory,
      `${digest(this.root).slice(0, 24)}-${identity}-${fingerprint([...selection].sort()).slice(0, 16)}.json`,
    )
    if (existsSync(cache)) {
      if (statSync(cache).size > 64 * 1024 * 1024) throw new Error("Invalid cached snapshot size")
      const stored = JSON.parse(readFileSync(cache, "utf8")) as Snapshot
      if (stored.id === identity && stored.version === 1 && stored.workspace === this.root)
        return stored
      throw new Error("Invalid cached snapshot identity")
    }
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
    this.evict()
    return snapshot
  }
  async manifest(principal: Principal, paths: string[] = []) {
    const snapshot = await this.snapshot(principal, paths)
    const matches = snapshot.files
      .filter((f) => !paths.length || paths.some((p) => matchesPath(p, f.path)))
      .slice(0, 100)
    return this.bounded({
      snapshotID: snapshot.id,
      workspace: this.root,
      repomix: snapshot.repomix,
      encoding: snapshot.encoding,
      totalFiles: snapshot.files.length,
      packedTokens: snapshot.tokens,
      files: matches.map(({ path, hash, bytes }) => ({ path, hash, bytes })),
      truncated: snapshot.files.length > matches.length,
    })
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
        revision: f.hash,
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
    const id = crypto.randomUUID()
    const response = await this.bounded({
      snapshotID: snapshot.id,
      receipt: sources.some((s) => s.text) ? `lazers-evidence:${id}` : null,
      encoding: snapshot.encoding,
      sources,
      truncated: matches.length === 50,
    })
    if (response.receipt)
      this.repository.atomic((db) =>
        db
          .query("INSERT INTO context_receipts VALUES(?,?,?,?,?,?,?)")
          .run(
            id,
            this.repository.projectDirectory,
            this.root,
            principal.sessionID,
            snapshot.id,
            JSON.stringify(sources.map(({ path, revision }) => ({ path, revision }))),
            Date.now(),
          ),
      )
    return response
  }
  async validateReceipt(principal: Principal, proposal: TaskProposal) {
    const refs = proposal.context.filter((c) => c.reference.startsWith("lazers-evidence:"))
    if (!refs.length)
      throw new Error("Architect requires focused project evidence before task submission")
    const snapshot = await this.snapshot(principal)
    for (const ref of refs) {
      const row = this.repository.atomic((db) =>
        db
          .query<{ snapshot_id: string; sources: string }, [string, string, string, string]>(
            "SELECT snapshot_id,sources FROM context_receipts WHERE id=? AND project_directory=? AND workspace=? AND session_id=?",
          )
          .get(
            ref.reference.slice("lazers-evidence:".length),
            this.repository.projectDirectory,
            this.root,
            principal.sessionID,
          ),
      )
      if (!row || row.snapshot_id !== snapshot.id || ref.revision !== snapshot.id)
        throw new Error(
          "Project evidence is stale, foreign or unavailable; refresh focused evidence",
        )
      const sources = JSON.parse(row.sources) as { path: string; revision: string }[]
      if (
        !sources.length ||
        sources.some((s) => !snapshot.files.some((f) => f.path === s.path && f.hash === s.revision))
      )
        throw new Error("Evidence no longer matches permitted source")
    }
  }

  async packet(
    principal: Principal,
    proposal: TaskProposal,
    skills: { id: string; path: string; content: string; revision: string }[],
    source: string,
  ) {
    const snapshot = await this.snapshot(principal)
    const references = new Set(
      proposal.context.flatMap((ref) =>
        ref.reference.startsWith("lazers-evidence:")
          ? []
          : (ref.reference.match(
              /(?:\.?[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:md|tsx?|json|yaml|yml)/g,
            ) ?? []),
      ),
    )
    const required = ["AGENTS.md", "README.md"].filter((path) => existsSync(join(this.root, path)))
    const missing = required.filter((path) => !snapshot.files.some((file) => file.path === path))
    for (const path of references)
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
    const entries: { path: string; revision: string; level: "full" | "outline"; text: string }[] =
      []
    const counter = await this.tokenizer()
    const base = {
      task: proposal,
      skills,
      source,
      snapshotID: snapshot.id,
      recipe: "task-context/1",
      entries,
    }
    const limit = Math.min(24000, Math.floor(proposal.limits.maxTokens / 2))
    for (const file of candidates) {
      const mandatory = required.includes(file.path) || references.has(file.path)
      const full = mandatory || /(?:test|spec)\./.test(file.path) || file.path.endsWith(".md")
      const entry = {
        path: file.path,
        revision: file.hash,
        level: full ? ("full" as const) : ("outline" as const),
        text: full ? file.content : file.outline,
      }
      entries.push(entry)
      if (counter.countTokens(JSON.stringify(base)) > limit) {
        entries.pop()
        if (mandatory)
          throw new Error(`Mandatory context exceeds reserved ${limit} tokens: ${file.path}`)
      }
    }
    const text = JSON.stringify(base)
    return {
      text,
      metadata: {
        snapshotID: snapshot.id,
        source,
        recipe: "task-context/1",
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
