import { workerURL } from "../worker-url.ts"
import { constants, existsSync, realpathSync } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import { Worker } from "node:worker_threads"
import type { TaskRepository } from "../storage.ts"
import type { TaskProposal } from "../task.ts"
import {
  RepositorySnapshotStore,
  type RepositorySnapshotWorker,
  type RepositorySnapshotRequest,
} from "./repository-snapshots.ts"
import { trackedFiles } from "./repo-map.ts"

type Principal = { sessionID: string; agent: string; signal?: AbortSignal }
type Permission = (path: string, principal: Principal, workspace: string) => Promise<boolean>
type Compressed = { files: { path: string; content: string }[]; denied: string[] }

const maxFile = 512 * 1024
/** Prompt budget for the named files' source context; paths past it are listed, not dropped. */
const sourceContextTokens = 24_000
const matchesPath = (pattern: string, path: string) =>
  new Bun.Glob(pattern).match(path) || path.startsWith(`${pattern.replace(/\/$/, "")}/`)
const secret = (path: string) =>
  /(^|\/)(?:\.env(?:\..*)?|[^/]*\.(?:pem|key|p12|pfx)|id_(?:rsa|ed25519)|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?)$/i.test(
    path,
  ) && !/(?:^|\/)\.env\.example$/.test(path)
const compressible = /\.(?:[cm]?[jt]sx?|py|rs|go|java|rb|c|cpp|h|cs|swift|kt)$/

function validSourcePath(path: string) {
  return (
    path.length <= 1024 &&
    !isAbsolute(path) &&
    !path.split("/").some((part) => part === ".." || part === ".") &&
    !secret(path)
  )
}

/** Reads at most maxFile+1 bytes. Rejects symlinks and changed inode/metadata. */
async function readSource(root: string, path: string): Promise<string> {
  if (isAbsolute(path) || path.split("/").some((p) => p === ".." || p === "."))
    throw new Error("Invalid source path")
  let parent = root
  for (const part of path.split("/")) {
    parent = join(parent, part)
    if ((await lstat(parent)).isSymbolicLink()) throw new Error("Symlink source is excluded")
  }
  const absolute = join(root, path)
  const actual = await realpath(absolute)
  if (relative(root, actual).startsWith("..") || isAbsolute(relative(root, actual)))
    throw new Error("Source escaped workspace")
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > maxFile) throw new Error("Source exceeds per-file bound")
    const bytes = Buffer.alloc(Math.min(maxFile + 1, before.size + 1))
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null)
      if (!bytesRead) break
      offset += bytesRead
    }
    const after = await handle.stat(),
      linked = await lstat(absolute)
    if (
      offset > maxFile ||
      after.size !== offset ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== linked.ino ||
      before.dev !== linked.dev ||
      (await realpath(absolute)) !== actual
    )
      throw new Error("Source changed while collecting")
    const value = bytes.subarray(0, offset)
    if (value.includes(0)) throw new Error("Binary source is excluded")
    return new TextDecoder("utf-8", { fatal: true }).decode(value)
  } finally {
    await handle.close()
  }
}

/** Tree-sitter outlines of a few named files, computed in a worker thread. */
async function compress(
  root: string,
  files: { path: string; content: string }[],
  signal?: AbortSignal,
): Promise<Compressed> {
  const worker = new Worker(workerURL("./processor", import.meta.url))
  try {
    return await new Promise<Compressed>((resolve, reject) => {
      const abort = () => reject(signal?.reason ?? new Error("Aborted"))
      signal?.addEventListener("abort", abort, { once: true })
      worker.once("error", reject)
      worker.once("message", (data: { ok: boolean; error?: string } & Compressed) =>
        data.ok ? resolve(data) : reject(new Error(data.error)),
      )
      worker.postMessage({
        root,
        files: files.map((file) => ({
          ...file,
          level: compressible.test(file.path) ? ("compress" as const) : ("directory-only" as const),
        })),
      })
    })
  } finally {
    void worker.terminate()
  }
}

/**
 * Source context for a task, and remote repository snapshots. Local orientation is the
 * repository map; this class only reads the files a task names.
 */
export class ProjectIndex {
  private readonly repositorySnapshots: RepositorySnapshotStore
  private counter?: import("repomix").TokenCounter
  constructor(
    readonly root: string,
    readonly cacheDirectory: string,
    repository: TaskRepository,
    readonly allow: Permission,
    repositoryWorker?: RepositorySnapshotWorker,
  ) {
    this.root = realpathSync(root)
    this.repositorySnapshots = new RepositorySnapshotStore(
      join(cacheDirectory, "repositories"),
      repository,
      repositoryWorker,
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

  /**
   * The source the task names (referenced paths and line ranges, else its write scope), read from
   * the checkout now: compressed outlines for code, full text otherwise or with line ranges.
   */
  async taskContext(principal: Principal, proposal: TaskProposal, findings: string[] = []) {
    const references = new Map<string, { start: number; end: number }[]>()
    for (const text of [
      ...proposal.context.map((ref) => ref.reference),
      proposal.guidance ?? "",
      ...findings,
    ]) {
      for (const match of text.matchAll(
        /((?:[a-zA-Z0-9_.@-]+\/)*[a-zA-Z0-9_.@-]+\.[a-zA-Z][a-zA-Z0-9]*)(?::(\d+)(?:-(\d+))?)?/g,
      )) {
        const path = match[1]!
        if (!validSourcePath(path) || !existsSync(join(this.root, path))) continue
        const ranges = references.get(path) ?? []
        if (match[2]) {
          const start = Number(match[2]),
            end = Number(match[3] ?? match[2])
          if (start > 0 && end >= start) ranges.push({ start, end })
        }
        references.set(path, ranges)
      }
    }
    const candidates = references.size
      ? [...references.keys()].sort()
      : (await trackedFiles(this.root)).filter(
          (path) =>
            validSourcePath(path) && proposal.writeScope.some((scope) => matchesPath(scope, path)),
        )
    const sources: { path: string; content: string }[] = []
    for (const path of candidates) {
      principal.signal?.throwIfAborted()
      if (!(await this.allow(path, principal, this.root))) continue
      try {
        sources.push({ path, content: await readSource(this.root, path) })
      } catch {
        // Unreadable, binary, oversized or changing files are not named as context.
      }
    }
    const outlines = new Map<string, string>()
    if (sources.length) {
      const packed = await compress(this.root, sources, principal.signal)
      for (const file of packed.files) outlines.set(file.path, file.content)
    }
    const counter = await this.tokenizer()
    const deferred: string[] = []
    const entries: { path: string; level: "full" | "outline"; text: string }[] = []
    let tokens = 0
    for (const file of sources) {
      const ranges = references.get(file.path) ?? []
      const lines = file.content.split("\n")
      const outline = ranges.length === 0 && Boolean(outlines.get(file.path))
      const text = ranges.length
        ? ranges
            .map(
              ({ start, end }) =>
                `[Lines ${start}-${Math.min(end, lines.length)}]\n${lines.slice(start - 1, end).join("\n")}`,
            )
            .join("\n")
        : outline
          ? outlines.get(file.path)!
          : file.content
      const cost = counter.countTokens(file.path + text)
      if (tokens + cost > sourceContextTokens) {
        deferred.push(file.path)
        continue
      }
      tokens += cost
      entries.push({ path: file.path, level: outline ? "outline" : "full", text })
    }
    return { workspace: this.root, tokens, entries, deferred }
  }
  async repositorySnapshot(principal: Principal, input: RepositorySnapshotRequest) {
    principal.signal?.throwIfAborted()
    return await this.repositorySnapshots.create(input, principal.signal)
  }
  repositorySnapshotRead(snapshotID: string, principal: Principal) {
    principal.signal?.throwIfAborted()
    return this.repositorySnapshots.read(snapshotID, principal.signal)
  }
  close() {
    this.counter?.free()
    this.counter = undefined
    this.repositorySnapshots.close()
  }
}
