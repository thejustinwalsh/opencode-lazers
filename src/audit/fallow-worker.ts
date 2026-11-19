import { readdir, realpath } from "node:fs/promises"
import { dirname, join, sep } from "node:path"
import { parentPort } from "node:worker_threads"
import { wasmURL } from "../worker-url.ts"
import { FallowModules, sharedMemoryAvailable, type FallowThreads } from "./fallow-threads.ts"
import { memoryExhausted, runFallowModule, ThreadPool, WasiTrap } from "./fallow-wasi.ts"

/**
 * Serves Fallow analysis from the WebAssembly module on a worker thread, so the CPU work stays
 * off the service event loop. The module reads the project through the WASI host in
 * `fallow-wasi.ts`; this worker lists the files for the whole-file operations, runs one request
 * at a time and turns a trap into a typed error. Terminating the worker is the only cancel.
 */
export type FallowWorkerKind =
  /** Per-function complexity over the files given (or all). */
  | "complexity"
  /** Clone groups; `changed` keeps the groups that touch those files. */
  | "duplication"
  | "deadCode"
  | "cycles"
  /** The report sections `lz-fallow-report` stores. */
  | "health"
  | "duplicationReport"
  | "architecture"
  | "featureFlagReport"

export type FallowWorkerRequest = {
  id: number
  kind: FallowWorkerKind
  root: string
  /** Complexity: restrict to these files. Dead code and cycles: restrict findings to these. */
  files?: string[]
  /** Duplication: keep clone groups that touch these files; the whole root stays the corpus. */
  changed?: string[]
  /** Absolute path of the Fallow config. Local `extends` resolve through the filesystem. */
  configPath?: string
  options?: Record<string, unknown>
  /** "on" (default) runs on the threaded module when it works, "off" never loads it. */
  threads?: FallowThreads
}

export type FallowWorkerResponse =
  | {
      id: number
      ok: true
      report: Record<string, unknown>
      /** Why this call ran on the single-threaded module although threads were on. */
      fallback?: string
    }
  | { id: number; error: { code: string; message: string } }

const SOURCE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "gts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "gjs",
  "vue",
  "svelte",
  "astro",
  "mdx",
  "css",
  "scss",
  "sass",
  "less",
  "html",
  "graphql",
  "gql",
])

class WorkerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const isSource = (path: string) => SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf(".") + 1))

async function walk(root: string, directory = ""): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relative = directory ? `${directory}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") return []
        return walk(root, relative)
      }
      return entry.isFile() ? [relative] : []
    }),
  )
  return nested.flat()
}

/** Files under `root`: tracked and untracked-unignored in a git work tree, else a directory walk. */
async function enumerate(root: string): Promise<string[]> {
  const listed = await Bun.$`git -C ${root} ls-files -z --cached --others --exclude-standard`
    .quiet()
    .nothrow()
  const paths = listed.exitCode === 0 ? listed.text().split("\0").filter(Boolean) : await walk(root)
  return paths.filter(isSource)
}

type Envelope = { ok?: boolean; report?: Record<string, unknown> } & {
  error?: { code: string; message: string }
}

/** Directories to preopen besides the root: the config's, when it lives outside the root. */
function extraRoots(request: FallowWorkerRequest): string[] {
  const config = request.configPath
  if (!config) return []
  const directory = dirname(config)
  return directory === request.root || directory.startsWith(request.root + sep) ? [] : [directory]
}

const load = async (name: string) =>
  new WebAssembly.Module(await Bun.file(wasmURL(`./wasm/${name}`, import.meta.url)).arrayBuffer())

/** Helper workers of the threaded module, kept for the life of this worker and reused. */
const threadPool = new ThreadPool()

const modules = new FallowModules(
  () => load("fallow.wasm"),
  async () => {
    if (!sharedMemoryAvailable()) throw new Error("shared memory is unavailable in this runtime")
    return load("fallow-threads.wasm")
  },
)

/** The host preopens real paths, so the root and the config are resolved before the module sees them. */
async function resolved(request: FallowWorkerRequest): Promise<FallowWorkerRequest> {
  const root = await realpath(request.root)
  const configPath = request.configPath
    ? await realpath(request.configPath).catch(() => request.configPath)
    : undefined
  return { ...request, root, ...(configPath ? { configPath } : {}) }
}

async function run(
  raw: FallowWorkerRequest,
): Promise<{ report: Record<string, unknown>; fallback?: string }> {
  const request = await resolved(raw)
  const inMemory = request.kind === "complexity" || request.kind === "duplication"
  const files = request.kind === "duplication" ? request.changed : request.files
  if (request.kind === "complexity" && request.files?.length === 0)
    return { report: { functions: [] } }
  // Complexity reads only the requested files; duplication needs the whole root as its corpus.
  const paths = !inMemory
    ? undefined
    : request.kind === "complexity" && request.files
      ? request.files.filter(isSource)
      : await enumerate(request.root)
  const wasmRequest = {
    op: request.kind,
    root: request.root,
    configPath: request.configPath ?? "",
    ...(paths ? { paths } : {}),
    files: files ?? [],
    options: { ...request.options, files: request.files ?? [] },
  }
  let executed
  try {
    executed = await modules.execute(request.threads ?? "on", (module, threads) =>
      runFallowModule(
        module,
        { ...wasmRequest, options: { ...wasmRequest.options, threads } },
        { extraRoots: extraRoots(request), maxThreads: threads, threadPool },
      ),
    )
  } catch (error) {
    if (error instanceof WasiTrap && memoryExhausted(error.stderr) !== undefined)
      throw new WorkerError(
        "analyzer-memory",
        `the project is too large for analysis: the analyzer ran out of memory (a ${memoryExhausted(error.stderr)} byte allocation failed; a WebAssembly module has 4 GiB)`,
      )
    if (error instanceof WasiTrap)
      throw new WorkerError("analyzer-panic", error.stderr.trim().slice(-2000) || error.message)
    throw error
  }
  const parsed = JSON.parse(executed.result.stdout) as Envelope
  if (parsed.error) throw new WorkerError(parsed.error.code, parsed.error.message)
  return {
    report: parsed.report ?? {},
    ...(executed.fallback ? { fallback: executed.fallback } : {}),
  }
}

async function handle(request: FallowWorkerRequest): Promise<FallowWorkerResponse> {
  try {
    return { id: request.id, ok: true, ...(await run(request)) }
  } catch (error) {
    if (error instanceof WorkerError)
      return { id: request.id, error: { code: error.code, message: error.message } }
    const message = error instanceof Error ? error.message : String(error)
    return { id: request.id, error: { code: "analyzer-unavailable", message } }
  }
}

const port = parentPort
if (!port) throw new Error("fallow-worker must run in a worker thread")
let queue: Promise<unknown> = Promise.resolve()
port.on("message", (request: FallowWorkerRequest) => {
  queue = queue.then(async () => port.postMessage(await handle(request)))
})
port.postMessage({ ready: true })
