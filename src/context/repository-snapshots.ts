import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join, posix, relative } from "node:path"
import { Worker } from "node:worker_threads"
import type { TaskRepository } from "../storage.ts"
import type { RepoProcessingInput, RepositorySnapshotMetadata } from "./repo-processor.ts"

export type RepositorySnapshotRequest = {
  repository: string
  ref?: string
  include: string[]
  exclude: string[]
}

export type RepositorySnapshotResponse = {
  snapshotID: string
  snapshotFile: string
  repository: string
  requestedRef: string | null
  refSelection: "argument" | "repository-url" | "default"
  resolvedRevision: string | null
  fetchedAt: number
  repomix: "1.18.1"
  compression: "Tree-sitter"
  encoding: "o200k_base"
  selection: {
    include: string[]
    exclude: string[]
    defaultIgnorePatterns: true
    repositoryIgnoreFiles: true
    includeTruncated: boolean
    excludeTruncated: boolean
    files: string[]
    totalFiles: number
    filesTruncated: boolean
    omittedFiles: { path: string; reason: string }[]
    totalOmittedFiles: number
    omittedFilesTruncated: boolean
  }
  metrics: { files: number; characters: number; tokens: number }
  source: string
  sourceBytes: number
  sourceTruncated: boolean
  reused: boolean
}

export type RepositorySnapshotWorker = (
  input: RepoProcessingInput,
  signal?: AbortSignal,
  workers?: Set<Worker>,
) => Promise<void>
export type RepositoryWorkerOptions = { workerURL?: URL; timeoutMs?: number }
type SnapshotFile = { metadata: RepositorySnapshotMetadata; bodyOffset: number; bytes: number }

const cacheTargetBytes = 256 * 1024 * 1024
const maxResponseSourceBytes = 128 * 1024
const maxResponseListItems = 100
const orphanGraceMs = 60_000
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const artifactHeader = Buffer.from("<!-- LAZERS repository source snapshot v1\n")
const artifactHeaderEnd = Buffer.from("\n-->\n")

function removeIfPresent(path: string) {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

function workerEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (
      name.startsWith("GIT_CONFIG_") ||
      [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_EXEC_PATH",
        "GIT_ASKPASS",
        "GIT_SSH",
        "GIT_SSH_COMMAND",
        "SSH_ASKPASS",
        "REPOMIX_REMOTE_TRUST_CONFIG",
      ].includes(name)
    )
      delete env[name]
  }
  env.REPOMIX_REMOTE_TRUST_CONFIG = "false"
  env.GIT_CONFIG_NOSYSTEM = "1"
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null"
  env.GIT_TERMINAL_PROMPT = "0"
  env.GIT_SSH_COMMAND = process.platform === "win32" ? "ssh -F NUL" : "ssh -F /dev/null"
  return env
}

export function runRepositoryWorker(
  input: RepoProcessingInput,
  signal?: AbortSignal,
  workers?: Set<Worker>,
  options: RepositoryWorkerOptions = {},
) {
  signal?.throwIfAborted()
  const timeoutMs = options.timeoutMs ?? 180_000
  const worker = new Worker(options.workerURL ?? new URL("./repo-worker.ts", import.meta.url), {
    env: workerEnvironment(),
    resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 128, stackSizeMb: 8 },
  })
  workers?.add(worker)
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(
      () =>
        fail(
          new Error(
            options.timeoutMs === undefined
              ? "Remote Repomix research exceeded 180 seconds"
              : `Remote Repomix research exceeded ${timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    )
    const finish = () => {
      if (settled) return false
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", aborted)
      return true
    }
    const fail = (error: Error) => {
      if (!finish()) return
      void worker.terminate().then(
        () => reject(error),
        () => reject(error),
      )
    }
    const succeed = () => {
      if (!finish()) return
      void worker.terminate().then(
        () => resolve(),
        () => resolve(),
      )
    }
    const aborted = () => {
      const reason = signal?.reason
      fail(reason instanceof Error ? reason : new Error("Remote repository research was cancelled"))
    }
    worker.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || !("ok" in message)) {
        fail(new Error("Remote Repomix worker returned an invalid result"))
        return
      }
      if (message.ok === true) succeed()
      else
        fail(
          new Error(
            "error" in message && typeof message.error === "string"
              ? message.error
              : "Remote Repomix worker failed",
          ),
        )
    })
    worker.once("error", (error) => fail(error instanceof Error ? error : new Error(String(error))))
    worker.once("exit", (code) => {
      if (!settled) fail(new Error(`Remote Repomix worker exited unexpectedly (${code})`))
    })
    signal?.addEventListener("abort", aborted, { once: true })
    if (signal?.aborted) {
      aborted()
      return
    }
    try {
      worker.postMessage(input)
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  }).finally(() => workers?.delete(worker))
}

function validRepositoryMetadataPath(path: string) {
  return (
    path.length > 0 &&
    !posix.isAbsolute(path) &&
    !path.split("/").some((part) => part === ".." || part === "." || part.length === 0)
  )
}

function validMetadata(value: unknown, snapshotID: string): value is RepositorySnapshotMetadata {
  if (!value || typeof value !== "object") return false
  const metadata = value as Partial<RepositorySnapshotMetadata>
  return (
    metadata.schemaVersion === 1 &&
    metadata.snapshotID === snapshotID &&
    typeof metadata.repository === "string" &&
    (metadata.requestedRef === null || typeof metadata.requestedRef === "string") &&
    ["argument", "repository-url", "default"].includes(metadata.refSelection ?? "") &&
    metadata.resolvedRevision === null &&
    Number.isSafeInteger(metadata.requestedAt) &&
    Number.isSafeInteger(metadata.fetchedAt) &&
    Number.isSafeInteger(metadata.durationMs) &&
    metadata.repomix === "1.18.1" &&
    metadata.compression === "Tree-sitter" &&
    metadata.encoding === "o200k_base" &&
    Number.isSafeInteger(metadata.sourceBytes) &&
    (metadata.sourceBytes ?? -1) >= 0 &&
    Array.isArray(metadata.selection?.include) &&
    Array.isArray(metadata.selection?.exclude) &&
    metadata.selection.defaultIgnorePatterns === true &&
    metadata.selection.repositoryIgnoreFiles === true &&
    Array.isArray(metadata.selection.files) &&
    metadata.selection.files.every(
      (path) => typeof path === "string" && validRepositoryMetadataPath(path),
    ) &&
    Array.isArray(metadata.selection.skippedFiles) &&
    metadata.selection.skippedFiles.every(
      (file) =>
        file &&
        typeof file.path === "string" &&
        validRepositoryMetadataPath(file.path) &&
        typeof file.reason === "string",
    ) &&
    Number.isSafeInteger(metadata.metrics?.files) &&
    Number.isSafeInteger(metadata.metrics?.characters) &&
    Number.isSafeInteger(metadata.metrics?.tokens)
  )
}

function readArtifact(fd: number, fileSize: number, snapshotID: string): SnapshotFile {
  const prefix = Buffer.alloc(artifactHeader.length)
  const prefixBytes = readSync(fd, prefix, 0, prefix.length, 0)
  if (prefixBytes !== prefix.length || !prefix.equals(artifactHeader))
    throw new Error("Invalid repository snapshot header")

  const headerParts: Buffer[] = []
  let pending = Buffer.alloc(0)
  const chunkSize = 64 * 1024
  const buffer = Buffer.alloc(chunkSize)
  let offset = artifactHeader.length
  let bodyOffset = 0
  let found = false
  while (offset < fileSize) {
    const read = readSync(fd, buffer, 0, Math.min(buffer.length, fileSize - offset), offset)
    if (read === 0) break
    const chunk = buffer.subarray(0, read)
    const combined = pending.length ? Buffer.concat([pending, chunk]) : chunk
    const suffixIndex = combined.indexOf(artifactHeaderEnd)
    if (suffixIndex !== -1) {
      headerParts.push(Buffer.from(combined.subarray(0, suffixIndex)))
      bodyOffset = offset - pending.length + suffixIndex + artifactHeaderEnd.length
      found = true
      break
    }
    const safeLength = Math.max(0, combined.length - artifactHeaderEnd.length + 1)
    if (safeLength) headerParts.push(Buffer.from(combined.subarray(0, safeLength)))
    pending = Buffer.from(combined.subarray(safeLength))
    offset += read
  }
  if (!found) throw new Error("Repository snapshot provenance header is incomplete")

  const headerBuffer = Buffer.concat(headerParts)
  const metadata: unknown = JSON.parse(headerBuffer.toString("utf8"))
  if (!validMetadata(metadata, snapshotID))
    throw new Error("Invalid repository snapshot provenance")
  if (fileSize - bodyOffset !== metadata.sourceBytes)
    throw new Error("Repository snapshot source length does not match its provenance")
  return { metadata, bodyOffset, bytes: fileSize }
}

function readSourcePreview(fd: number, bodyOffset: number, sourceBytes: number) {
  const length = Math.min(sourceBytes, maxResponseSourceBytes)
  const bytes = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const count = readSync(fd, bytes, read, length - read, bodyOffset + read)
    if (!count) break
    read += count
  }
  let end = read
  while (end > 0) {
    try {
      const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end))
      return { source, sourceTruncated: sourceBytes > end }
    } catch {
      end--
    }
  }
  return { source: "", sourceTruncated: sourceBytes > 0 }
}

export class RepositorySnapshotStore {
  readonly cacheDirectory: string
  private readonly workers = new Set<Worker>()

  constructor(
    cacheDirectory: string,
    private readonly repository: TaskRepository,
    private readonly worker: RepositorySnapshotWorker = runRepositoryWorker,
    private readonly cacheLimitBytes = cacheTargetBytes,
  ) {
    const parent = dirname(cacheDirectory)
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    this.cacheDirectory = join(realpathSync(parent), basename(cacheDirectory))
    try {
      this.assertCacheDirectory()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    repository.atomic((db) =>
      db.exec(
        `CREATE TABLE IF NOT EXISTS context_repo_snapshots(snapshot_id TEXT PRIMARY KEY,file TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,bytes INTEGER NOT NULL);`,
      ),
    )
  }

  private assertCacheDirectory() {
    const stat = lstatSync(this.cacheDirectory)
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("Repository snapshot storage must be a real plugin-owned directory")
    if (realpathSync(this.cacheDirectory) !== this.cacheDirectory)
      throw new Error("Repository snapshot storage escaped context storage")
  }

  private ensureCacheDirectory() {
    try {
      this.assertCacheDirectory()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      mkdirSync(this.cacheDirectory, { mode: 0o700 })
      this.assertCacheDirectory()
    }
  }

  private artifactFile(snapshotID: string) {
    if (!idPattern.test(snapshotID)) throw new Error("Invalid repository snapshot ID")
    return join(this.cacheDirectory, `repo-${snapshotID}.json.md`)
  }

  private openArtifact(path: string, snapshotID: string) {
    if (lstatSync(path).isSymbolicLink()) throw new Error("Invalid repository snapshot file")
    const absolute = realpathSync(path)
    const rel = relative(this.cacheDirectory, absolute)
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("Repository snapshot escaped context storage")
    const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile()) throw new Error("Invalid repository snapshot artifact")
      return { ...readArtifact(fd, stat.size, snapshotID), fd }
    } catch (error) {
      closeSync(fd)
      throw error
    }
  }

  private registerSnapshot(snapshotID: string, filename: string, createdAt: number, bytes: number) {
    const evictedFiles = this.repository.atomic((db) => {
      db.query("INSERT INTO context_repo_snapshots VALUES(?,?,?,?)").run(
        snapshotID,
        filename,
        createdAt,
        bytes,
      )
      const snapshots = db
        .query<{ snapshot_id: string; file: string; bytes: number }, []>(
          "SELECT snapshot_id,file,bytes FROM context_repo_snapshots ORDER BY created_at ASC,rowid ASC",
        )
        .all()
      let total = snapshots.reduce((sum, snapshot) => sum + snapshot.bytes, 0)
      const evicted: string[] = []
      for (const snapshot of snapshots) {
        if (total <= this.cacheLimitBytes) break
        if (
          snapshot.snapshot_id === snapshotID ||
          !idPattern.test(snapshot.snapshot_id) ||
          snapshot.file !== `repo-${snapshot.snapshot_id}.json.md`
        )
          continue
        db.query("DELETE FROM context_repo_snapshots WHERE snapshot_id=?").run(snapshot.snapshot_id)
        total -= snapshot.bytes
        evicted.push(snapshot.file)
      }
      return evicted
    })
    for (const file of evictedFiles) {
      try {
        removeIfPresent(join(this.cacheDirectory, file))
      } catch {
        // A deleted registry entry is unavailable; orphan-file cleanup is best-effort.
      }
    }
  }

  private evictOrphans() {
    const active = new Set(
      this.repository.atomic((db) =>
        db
          .query<{ file: string }, []>("SELECT file FROM context_repo_snapshots")
          .all()
          .map(({ file }) => file),
      ),
    )
    const now = Date.now()
    for (const name of readdirSync(this.cacheDirectory)) {
      if (!/^repo-[a-f0-9-]{36}\.json\.md$/.test(name) || active.has(name)) continue
      const path = join(this.cacheDirectory, name)
      if (now - statSync(path).mtimeMs > orphanGraceMs) unlinkSync(path)
    }
  }

  private response(
    metadata: RepositorySnapshotMetadata,
    file: string,
    fd: number,
    bodyOffset: number,
    bytes: number,
    reused: boolean,
  ) {
    const include = metadata.selection.include.slice(0, maxResponseListItems)
    const exclude = metadata.selection.exclude.slice(0, maxResponseListItems)
    const files = metadata.selection.files.slice(0, maxResponseListItems)
    const omittedFiles = metadata.selection.skippedFiles.slice(0, maxResponseListItems)
    const source = readSourcePreview(fd, bodyOffset, metadata.sourceBytes)
    return {
      snapshotID: metadata.snapshotID,
      snapshotFile: file,
      repository: metadata.repository,
      requestedRef: metadata.requestedRef,
      refSelection: metadata.refSelection,
      resolvedRevision: metadata.resolvedRevision,
      fetchedAt: metadata.fetchedAt,
      repomix: metadata.repomix,
      compression: metadata.compression,
      encoding: metadata.encoding,
      selection: {
        include,
        exclude,
        defaultIgnorePatterns: metadata.selection.defaultIgnorePatterns,
        repositoryIgnoreFiles: metadata.selection.repositoryIgnoreFiles,
        includeTruncated: metadata.selection.include.length > include.length,
        excludeTruncated: metadata.selection.exclude.length > exclude.length,
        files,
        totalFiles: metadata.selection.files.length,
        filesTruncated: metadata.selection.files.length > files.length,
        omittedFiles,
        totalOmittedFiles: metadata.selection.skippedFiles.length,
        omittedFilesTruncated: metadata.selection.skippedFiles.length > omittedFiles.length,
      },
      metrics: metadata.metrics,
      source: source.source,
      sourceBytes: metadata.sourceBytes,
      sourceTruncated: source.sourceTruncated,
      reused,
    } satisfies RepositorySnapshotResponse
  }

  async create(input: RepositorySnapshotRequest, signal?: AbortSignal) {
    signal?.throwIfAborted()
    this.ensureCacheDirectory()
    const snapshotID = crypto.randomUUID()
    const file = this.artifactFile(snapshotID)
    const filename = `repo-${snapshotID}.json.md`
    const temporaryArtifact = join(this.cacheDirectory, `.repo-${snapshotID}.json.md.tmp`)
    const sourceFile = join(this.cacheDirectory, `.source-${snapshotID}.md`)
    const requestedAt = Date.now()
    let published = false
    try {
      await this.worker(
        {
          snapshotID,
          repository: input.repository,
          ref: input.ref,
          include: input.include,
          exclude: input.exclude,
          requestedAt,
          sourceFile,
          artifactFile: temporaryArtifact,
        },
        signal,
        this.workers,
      )
      signal?.throwIfAborted()
      const staged = this.openArtifact(temporaryArtifact, snapshotID)
      try {
        signal?.throwIfAborted()
        linkSync(temporaryArtifact, file)
        try {
          this.registerSnapshot(snapshotID, filename, staged.metadata.fetchedAt, staged.bytes)
          published = true
        } catch (error) {
          removeIfPresent(file)
          throw error
        }
        try {
          this.evictOrphans()
        } catch {
          // Snapshot publication is complete; cleanup of abandoned files is best-effort.
        }
        return this.response(
          staged.metadata,
          file,
          staged.fd,
          staged.bodyOffset,
          staged.bytes,
          false,
        )
      } finally {
        closeSync(staged.fd)
      }
    } finally {
      removeIfPresent(sourceFile)
      removeIfPresent(temporaryArtifact)
      if (!published && existsSync(file)) removeIfPresent(file)
    }
  }

  read(snapshotID: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const file = this.artifactFile(snapshotID)
    const filename = `repo-${snapshotID}.json.md`
    const result = this.repository.atomic((db) => {
      const row = db
        .query<{ file: string; bytes: number }, [string]>(
          "SELECT file,bytes FROM context_repo_snapshots WHERE snapshot_id=?",
        )
        .get(snapshotID)
      if (!row || row.file !== filename || !existsSync(file))
        throw new Error("Repository snapshot is unavailable")
      if (lstatSync(file).isSymbolicLink()) throw new Error("Invalid repository snapshot file")
      const artifact = this.openArtifact(file, snapshotID)
      if (artifact.bytes !== row.bytes) {
        closeSync(artifact.fd)
        throw new Error("Repository snapshot storage metadata changed")
      }
      return artifact
    })
    try {
      signal?.throwIfAborted()
      return this.response(result.metadata, file, result.fd, result.bodyOffset, result.bytes, true)
    } finally {
      closeSync(result.fd)
    }
  }

  close() {
    for (const worker of this.workers) void worker.terminate()
    this.workers.clear()
  }
}
