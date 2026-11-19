import { readdir, realpath } from "node:fs/promises"
import { dirname, join, sep } from "node:path"
import { parentPort } from "node:worker_threads"
import { wasmURL } from "../worker-url.ts"
import { runFallowModule, WasiTrap } from "./fallow-wasi.ts"

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
}

export type FallowWorkerResponse =
  | { id: number; ok: true; report: Record<string, unknown> }
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

const module = new WebAssembly.Module(
  await Bun.file(wasmURL("./wasm/fallow.wasm", import.meta.url)).arrayBuffer(),
)

/** The host preopens real paths, so the root and the config are resolved before the module sees them. */
async function resolved(request: FallowWorkerRequest): Promise<FallowWorkerRequest> {
  const root = await realpath(request.root)
  const configPath = request.configPath
    ? await realpath(request.configPath).catch(() => request.configPath)
    : undefined
  return { ...request, root, ...(configPath ? { configPath } : {}) }
}

async function run(raw: FallowWorkerRequest): Promise<Record<string, unknown>> {
  const request = await resolved(raw)
  const inMemory = request.kind === "complexity" || request.kind === "duplication"
  const files = request.kind === "duplication" ? request.changed : request.files
  if (request.kind === "complexity" && request.files?.length === 0) return { functions: [] }
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
    options: { threads: 1, ...request.options, files: request.files ?? [] },
  }
  let stdout: string
  try {
    stdout = runFallowModule(module, wasmRequest, { extraRoots: extraRoots(request) }).stdout
  } catch (error) {
    if (error instanceof WasiTrap)
      throw new WorkerError("analyzer-panic", error.stderr.trim().slice(-2000) || error.message)
    throw error
  }
  const parsed = JSON.parse(stdout) as Envelope
  if (parsed.error) throw new WorkerError(parsed.error.code, parsed.error.message)
  return parsed.report ?? {}
}

async function handle(request: FallowWorkerRequest): Promise<FallowWorkerResponse> {
  try {
    return { id: request.id, ok: true, report: await run(request) }
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
