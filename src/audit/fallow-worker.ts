import { readdir, realpath } from "node:fs/promises"
import { join, sep } from "node:path"
import { parentPort } from "node:worker_threads"
import { wasmURL } from "../worker-url.ts"
import { initSync, lastPanic, Project } from "./wasm/fallow.js"

/**
 * Serves Fallow analysis from the WebAssembly module. The module has no filesystem, so this
 * worker lists and reads files, refuses any path that resolves outside the root, and hands paths
 * and contents to a `Project`. One request runs at a time.
 */
export type FallowWorkerRequest = {
  id: number
  kind: "complexity" | "duplication"
  root: string
  /** Complexity: restrict to these files. Relative to `root`. */
  files?: string[]
  /** Duplication: keep clone groups that touch these files; the whole root stays the corpus. */
  changed?: string[]
  configName?: string
  configText?: string
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
const MAX_FILE_BYTES = 4 * 1024 * 1024

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

/** Reads `relative` only when its real path stays under the real root. */
async function readInside(realRoot: string, root: string, relative: string) {
  try {
    const real = await realpath(join(root, relative))
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return undefined
    const file = Bun.file(real)
    return file.size > MAX_FILE_BYTES ? undefined : await file.text()
  } catch {
    return undefined
  }
}

async function load(root: string, wanted: readonly string[] | undefined) {
  const realRoot = await realpath(root)
  const candidates = wanted ? wanted.filter(isSource) : await enumerate(root)
  const rows = await Promise.all(
    candidates.map(async (path) => [path, await readInside(realRoot, root, path)] as const),
  )
  const present = rows.filter((row): row is readonly [string, string] => row[1] !== undefined)
  return { paths: present.map(([path]) => path), contents: present.map(([, text]) => text) }
}

type Envelope = { error?: { code: string; message: string } } & Record<string, unknown>

function unwrap(json: string): Record<string, unknown> {
  const parsed = JSON.parse(json) as Envelope
  if (parsed.error) throw new WorkerError(parsed.error.code, parsed.error.message)
  return parsed
}

function execute(request: FallowWorkerRequest, project: Project): string {
  return request.kind === "complexity"
    ? project.complexity(request.files ?? [])
    : project.duplication(request.changed ?? [], JSON.stringify(request.options ?? {}))
}

async function run(request: FallowWorkerRequest): Promise<Record<string, unknown>> {
  // Complexity reads only the requested files; duplication needs the whole root as its corpus.
  const wanted = request.kind === "complexity" ? request.files : undefined
  if (wanted?.length === 0) return { ok: true, functions: [] }
  const { paths, contents } = await load(request.root, wanted)
  const project = new Project(
    request.root,
    paths,
    contents,
    request.configName ?? "",
    request.configText ?? "",
  )
  try {
    return unwrap(execute(request, project))
  } catch (error) {
    if (error instanceof WorkerError) throw error
    throw new WorkerError("analyzer-panic", lastPanic() || String(error))
  } finally {
    project.free()
  }
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
initSync({ module: await Bun.file(wasmURL("./wasm/fallow.wasm", import.meta.url)).arrayBuffer() })
let queue: Promise<unknown> = Promise.resolve()
port.on("message", (request: FallowWorkerRequest) => {
  queue = queue.then(async () => port.postMessage(await handle(request)))
})
port.postMessage({ ready: true })
