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
  version: 2
  id: string
  workspace: string
  createdAt: number
  repomix: "1.18.1"
  encoding: "o200k_base"
  tokens: number
  files: FileRecord[]
}
type Principal = { sessionID: string; agent: string }
type Permission = (path: string, principal: Principal, workspace: string) => Promise<boolean>
export type ContextSession = {
  id: string
  parentID?: string
  projectID: string
  directory: string
  agent?: string
}
export type ContextHost = {
  projectID: string
  session: (id: string) => Promise<ContextSession | null>
}
type Packed = { files: { path: string; content: string }[]; denied: string[]; tokens: number }
export type Focus = {
  paths?: string[]
  search?: string
  level?: "full" | "outline" | "structure"
  startLine?: number
  endLine?: number
}
const maxFile = 512 * 1024
const maxCache = 256 * 1024 * 1024
const orphanGraceMs = 60_000
const workspaceSelection = "$workspace"
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const snapshotFilename =
  /^[a-f0-9]{32}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/
const matchesPath = (pattern: string, path: string) =>
  new Bun.Glob(pattern).match(path) || path.startsWith(`${pattern.replace(/\/$/, "")}/`)
const secret = (path: string) =>
  /(^|\/)(?:\.env(?:\..*)?|[^/]*\.(?:pem|key|p12|pfx)|id_(?:rsa|ed25519)|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?)$/i.test(
    path,
  ) && !/(?:^|\/)\.env\.example$/.test(path)

function validSourcePath(path: string) {
  return (
    path.length <= 1024 &&
    !isAbsolute(path) &&
    !path.split("/").some((part) => part === ".." || part === ".") &&
    !secret(path)
  )
}

export class WorkspaceIndexUnavailable extends Error {
  constructor() {
    super("Workspace index is unavailable; Architect must refresh it before it can be read")
  }
}

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
  private readonly projectID: string
  private readonly projectDirectory: string
  private counter?: import("repomix").TokenCounter
  constructor(
    readonly root: string,
    readonly cacheDirectory: string,
    readonly repository: TaskRepository,
    readonly allow: Permission,
    private readonly host?: ContextHost,
  ) {
    this.root = realpathSync(root)
    this.projectID = host?.projectID ?? repository.projectDirectory
    this.projectDirectory = repository.projectDirectory
    mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 })
    repository.atomic((db) =>
      db.exec(
        `CREATE TABLE IF NOT EXISTS context_workspaces(workspace TEXT PRIMARY KEY,id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS context_cache(workspace TEXT NOT NULL,selection TEXT NOT NULL,stamp TEXT NOT NULL,file TEXT NOT NULL,PRIMARY KEY(workspace,selection)); CREATE TABLE IF NOT EXISTS context_publications(project_id TEXT NOT NULL,project_directory TEXT NOT NULL,owner_session TEXT NOT NULL,workspace TEXT NOT NULL,snapshot_id TEXT NOT NULL,PRIMARY KEY(project_id,project_directory,owner_session));`,
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
    // Coordinate with readers across processes. Age alone cannot prove that a
    // superseded immutable file is no longer selected by a reader.
    this.repository.atomic((db) => {
      const active = new Set([
        ...db
          .query<{ file: string }, [string]>("SELECT file FROM context_cache WHERE selection=?")
          .all(workspaceSelection)
          .map(({ file }) => file),
        ...db
          .query<{ file: string }, []>(
            `SELECT w.id || '-' || p.snapshot_id || '.json' AS file
               FROM context_publications p JOIN context_workspaces w ON w.workspace=p.workspace`,
          )
          .all()
          .map(({ file }) => file),
      ])
      const now = Date.now()
      const orphans = readdirSync(this.cacheDirectory).filter((name) => {
        if (!name.endsWith(".json") || active.has(name)) return false
        return now - statSync(join(this.cacheDirectory, name)).mtimeMs > orphanGraceMs
      })
      for (const name of orphans) unlinkSync(join(this.cacheDirectory, name))
    })
  }

  private assertCacheCapacity(size: number, filename: string) {
    let bytes = size
    for (const name of readdirSync(this.cacheDirectory))
      if (name.endsWith(".json") && name !== filename)
        bytes += statSync(join(this.cacheDirectory, name)).size
    if (bytes > maxCache) throw new Error("Workspace snapshot cache exceeds 256 MiB")
  }
  private activeRefresh?: Promise<Snapshot>

  async refresh(principal: Principal): Promise<Snapshot> {
    if (principal.agent !== "architect")
      throw new Error("Only Architect may refresh the workspace index")
    if (this.host) {
      const publisher = await this.host.session(principal.sessionID)
      if (!this.sameSession(publisher, principal.sessionID, "architect", this.root))
        throw new Error("Only the Architect session for this workspace may refresh the index")
    }
    const previous = this.activeRefresh
    const promise = (async () => {
      if (previous) await previous.catch(() => {})
      return await this.publish(principal)
    })()
    this.activeRefresh = promise
    try {
      return await promise
    } finally {
      if (this.activeRefresh === promise) this.activeRefresh = undefined
    }
  }

  private async publish(principal: Principal): Promise<Snapshot> {
    const snapshot = await this.collectWorkspace(principal)
    const filename = `${this.cacheID}-${snapshot.id}.json`
    const cache = join(this.cacheDirectory, filename)
    const temporary = `${cache}.${crypto.randomUUID()}.tmp`
    try {
      const text = JSON.stringify(snapshot)
      const size = Buffer.byteLength(text)
      if (size > 64 * 1024 * 1024) throw new Error("Snapshot exceeds 64 MiB")
      writeFileSync(temporary, text, { flag: "wx", mode: 0o600 })
      renameSync(temporary, cache)
      this.evict()
      this.assertCacheCapacity(size, filename)
      this.repository.atomic((db) => {
        db.query("DELETE FROM context_cache WHERE workspace=? AND selection<>?").run(
          this.root,
          workspaceSelection,
        )
        db.query(
          "INSERT INTO context_cache VALUES(?,?,?,?) ON CONFLICT(workspace,selection) DO UPDATE SET stamp=excluded.stamp,file=excluded.file",
        ).run(
          this.root,
          workspaceSelection,
          JSON.stringify(snapshot.files.map(({ path, stamp }) => [path, stamp])),
          filename,
        )
        if (this.host)
          db.query(
            `INSERT INTO context_publications(project_id,project_directory,owner_session,workspace,snapshot_id)
             VALUES(?,?,?,?,?)
             ON CONFLICT(project_id,project_directory,owner_session) DO UPDATE SET
             workspace=excluded.workspace,snapshot_id=excluded.snapshot_id`,
          ).run(
            this.projectID,
            this.projectDirectory,
            principal.sessionID,
            snapshot.workspace,
            snapshot.id,
          )
      })
    } catch (error) {
      try {
        unlinkSync(temporary)
      } catch {
        // A failed refresh must not hide the original publish error.
      }
      try {
        unlinkSync(cache)
      } catch {
        // The new snapshot may not have been written to disk.
      }
      throw error
    }
    try {
      this.evict()
    } catch {
      // Eviction is best-effort and must not turn a successfully published snapshot into a failure.
    }
    return snapshot
  }

  private async collectWorkspace(principal: Principal): Promise<Snapshot> {
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
          if (!(await this.allow(name, principal, this.root)))
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
          if (!entry.isFile() || !(await this.allow(name, principal, this.root))) continue
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
    const packed = await this.processWorkspace(
      selected.map(({ path, content }) => ({
        path,
        content,
        level: /\.(?:[cm]?[jt]sx?|py|rs|go|java|rb|c|cpp|h|cs|swift|kt)$/.test(path)
          ? ("compress" as const)
          : ("directory-only" as const),
      })),
      started,
    )
    const denied = new Set(packed.denied)
    const outline = new Map(packed.files.map((f) => [f.path, f.content]))
    const snapshot: Snapshot = {
      version: 2,
      id: crypto.randomUUID(),
      workspace: this.root,
      createdAt: Date.now(),
      repomix: "1.18.1",
      encoding: "o200k_base",
      tokens: packed.tokens,
      files: selected
        .filter((f) => !denied.has(f.path))
        .map((f) => ({ ...f, outline: outline.get(f.path) ?? "" })),
    }
    return snapshot
  }

  private async processWorkspace(
    files: { path: string; content: string; level: "compress" | "directory-only" }[],
    started: number,
  ): Promise<Packed> {
    return await new Promise<Packed>((resolve, reject) => {
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
      worker.postMessage({ root: this.root, files })
    })
  }

  private loadSnapshot(publication?: { ownerSessionID: string; workspace: string }): Snapshot {
    // The immediate transaction is a lock, not a snapshot write. Hold it until
    // the immutable bytes are read so another process cannot evict that file.
    const { file, workspace, cacheID, expectedSnapshotID, text } = this.repository.atomic((db) => {
      let file: string,
        workspace = this.root,
        cacheID = this.cacheID,
        expectedSnapshotID: string | undefined
      if (publication) {
        const row = db
          .query<{ workspace: string; snapshot_id: string }, [string, string, string]>(
            "SELECT workspace,snapshot_id FROM context_publications WHERE project_id=? AND project_directory=? AND owner_session=?",
          )
          .get(this.projectID, this.projectDirectory, publication.ownerSessionID)
        if (!row || row.workspace !== publication.workspace) throw new WorkspaceIndexUnavailable()
        workspace = row.workspace
        expectedSnapshotID = row.snapshot_id
        const identity = db
          .query<{ id: string }, [string]>("SELECT id FROM context_workspaces WHERE workspace=?")
          .get(workspace)
        if (!identity) throw new WorkspaceIndexUnavailable()
        cacheID = identity.id
        file = `${identity.id}-${expectedSnapshotID}.json`
      } else {
        const row = db
          .query<{ file: string }, [string, string]>(
            "SELECT file FROM context_cache WHERE workspace=? AND selection=?",
          )
          .get(this.root, workspaceSelection)
        if (!row) throw new WorkspaceIndexUnavailable()
        file = row.file
      }
      if (!snapshotFilename.test(file)) throw new Error("Invalid cached snapshot path")
      const cache = join(this.cacheDirectory, file)
      if (!existsSync(cache)) throw new WorkspaceIndexUnavailable()
      if (statSync(cache).size > 64 * 1024 * 1024) throw new Error("Invalid cached snapshot size")
      return { file, workspace, cacheID, expectedSnapshotID, text: readFileSync(cache, "utf8") }
    })
    const stored = JSON.parse(text) as Snapshot
    if (
      stored.version !== 2 ||
      !uuidPattern.test(stored.id) ||
      file !== `${cacheID}-${stored.id}.json` ||
      (expectedSnapshotID !== undefined && stored.id !== expectedSnapshotID) ||
      stored.workspace !== workspace ||
      !Number.isInteger(stored.createdAt) ||
      stored.repomix !== "1.18.1" ||
      stored.encoding !== "o200k_base" ||
      !Number.isInteger(stored.tokens) ||
      stored.tokens < 0 ||
      !Array.isArray(stored.files) ||
      stored.files.some(
        (file) =>
          !file ||
          !validSourcePath(file.path) ||
          typeof file.content !== "string" ||
          typeof file.outline !== "string" ||
          !Number.isInteger(file.bytes) ||
          file.bytes !== Buffer.byteLength(file.content),
      )
    )
      throw new Error("Invalid cached snapshot identity")
    return stored
  }

  private sameSession(
    session: ContextSession | null,
    id: string,
    agent: string,
    directory?: string,
  ) {
    if (
      !session ||
      session.id !== id ||
      session.projectID !== this.projectID ||
      session.agent !== agent
    )
      return false
    try {
      const actual = realpathSync(session.directory)
      return directory === undefined || actual === directory
    } catch {
      return false
    }
  }

  private async publicationFor(principal: Principal) {
    if (!this.host || principal.agent !== "lazers-implementor") return undefined
    try {
      const worker = await this.host.session(principal.sessionID)
      if (
        !worker ||
        !this.sameSession(worker, principal.sessionID, "lazers-implementor", this.root) ||
        !worker.parentID
      )
        return undefined
      const architect = await this.host.session(worker.parentID)
      if (!architect || !this.sameSession(architect, worker.parentID, "architect")) return undefined
      const workspace = realpathSync(architect.directory)
      return { ownerSessionID: architect.id, workspace }
    } catch {
      // Published context is optional; native session lookup failures must not
      // prevent ordinary workspace reads or cause an implicit refresh.
      return undefined
    }
  }

  private async snapshotFor(principal: Principal) {
    const publication = await this.publicationFor(principal)
    if (publication) {
      try {
        return this.loadSnapshot(publication)
      } catch (error) {
        if (!(error instanceof WorkspaceIndexUnavailable)) throw error
      }
    }
    return this.loadSnapshot()
  }

  private async permittedFiles(snapshot: Snapshot, principal: Principal) {
    const files: FileRecord[] = []
    for (const file of snapshot.files)
      if (
        validSourcePath(file.path) &&
        (await this.allow(file.path, principal, snapshot.workspace))
      )
        files.push(file)
    return files
  }

  async manifest(principal: Principal, paths: string[] = []) {
    const snapshot = await this.snapshotFor(principal)
    const visible = await this.permittedFiles(snapshot, principal)
    const allMatches = visible.filter(
      (f) => !paths.length || paths.some((p) => matchesPath(p, f.path)),
    )
    const matches = allMatches.slice(0, 100)
    return {
      snapshotID: snapshot.id,
      freshness: "as-of-refresh" as const,
      refreshedAt: snapshot.createdAt,
      workspace: snapshot.workspace,
      repomix: snapshot.repomix,
      encoding: snapshot.encoding,
      totalFiles: visible.length,
      packedTokens: snapshot.tokens,
      files: matches.map(({ path, bytes }) => ({ path, bytes })),
      truncated: allMatches.length > matches.length,
    }
  }
  async evidence(principal: Principal, focus: Focus) {
    const snapshot = await this.snapshotFor(principal)
    const paths = focus.paths ?? []
    const visible = await this.permittedFiles(snapshot, principal)
    const allMatches = visible.filter(
      (f) =>
        (!paths.length || paths.some((p) => matchesPath(p, f.path))) &&
        (!focus.search || f.content.toLowerCase().includes(focus.search.toLowerCase())),
    )
    const matches = allMatches.slice(0, 50)
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
      freshness: "as-of-refresh" as const,
      refreshedAt: snapshot.createdAt,
      workspace: snapshot.workspace,
      encoding: snapshot.encoding,
      sources,
      truncated: allMatches.length > matches.length,
    }
  }

  async packet(
    principal: Principal,
    proposal: TaskProposal,
    skills: { id: string; path: string; content: string; revision: string }[],
    source: string,
  ) {
    const snapshot = this.loadSnapshot()
    const visible = await this.permittedFiles(snapshot, principal)
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
    const missing = required.filter((path) => !visible.some((file) => file.path === path))
    for (const path of references.keys())
      if (existsSync(join(this.root, path)) && !visible.some((file) => file.path === path))
        missing.push(path)
    if (missing.length) throw new Error(`Mandatory context unavailable: ${missing.join(", ")}`)
    const scopes = proposal.writeScope.map((pattern) => new Bun.Glob(pattern))
    const candidates = visible.filter(
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
      freshness: "as-of-refresh",
      refreshedAt: snapshot.createdAt,
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
        freshness: "as-of-refresh",
        refreshedAt: snapshot.createdAt,
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
