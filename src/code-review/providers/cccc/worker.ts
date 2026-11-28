import { readFileSync, realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parentPort } from "node:worker_threads"
import { runFallowModule } from "../../../audit/fallow-wasi.ts"
import { safeFunctionReport } from "./privacy.ts"
import { wasmURL } from "../../../worker-url.ts"
import type { CcccFileReport } from "./types.ts"
import type {
  CcccWorkerFailure,
  CcccWorkerRequest,
  CcccWorkerResponse,
  CcccWasmFile,
  CcccWasmOutput,
} from "./worker-protocol.ts"

const port = parentPort
if (!port) throw new Error("cccc worker requires a worker thread")

const root = realpathSync(fileURLToPath(new URL(".", import.meta.url)))
const wasmPath = wasmURL("./wasm/cccc.wasm", import.meta.url)
let modulePromise: Promise<WebAssembly.Module> | undefined

function loadModule(): Promise<WebAssembly.Module> {
  modulePromise ??= WebAssembly.compile(readFileSync(fileURLToPath(wasmPath)))
  return modulePromise
}

function parserLines(errors: readonly string[]): number[] {
  const lines = new Set<number>()
  for (const error of errors) addParserErrorLines(lines, error)
  return [...lines].sort((a, b) => a - b)
}

function addParserErrorLines(lines: Set<number>, error: string): void {
  for (const match of error.matchAll(/\bline\s+(\d+)\b/gi)) addParserLine(lines, match[1])
}

function addParserLine(lines: Set<number>, text: string | undefined): void {
  const line = Number(text)
  if (Number.isSafeInteger(line) && line > 0) lines.add(line)
}

function sanitizeReport(file: CcccWasmFile, request: CcccWorkerRequest): CcccFileReport {
  const source = request.files.find(
    (input) => input.side === file.side && input.path === file.report.path,
  )
  if (!source) throw new Error("invalid report key")
  const parseErrors = file.report.parse_errors ?? []
  const language = file.language
  if (
    ![
      "typescript",
      "javascript",
      "rust",
      "go",
      "php",
      "ruby",
      "scheme",
      "racket",
      "commonlisp",
      "emacslisp",
      "clojure",
      "kotlin",
      "python",
      "zig",
      "c",
      "cpp",
      "perl",
      "swift",
      "java",
      "dart",
      "scala",
    ].includes(language)
  )
    throw new Error("invalid report language")
  return {
    side: file.side,
    path: source.path,
    language: language as CcccFileReport["language"],
    lineCount: source.source.split("\n").length,
    cognitive: file.report.cognitive,
    cyclomatic: file.report.cyclomatic,
    functions: file.report.functions.map(safeFunctionReport),
    parseErrors: { count: parseErrors.length, lines: parserLines(parseErrors) },
  }
}

async function analyze(
  request: CcccWorkerRequest,
): Promise<CcccWorkerResponse | CcccWorkerFailure> {
  try {
    const module = await loadModule()
    return analyzeWithModule(module, request)
  } catch (error) {
    return analysisFailure(request.id, error)
  }
}

function analyzeWithModule(
  module: WebAssembly.Module,
  request: CcccWorkerRequest,
): CcccWorkerResponse | CcccWorkerFailure {
  const outcome = runFallowModule(module, { op: "cccc", root, files: request.files })
  if (outcome.exitCode !== undefined && outcome.exitCode !== 0)
    return workerFailure(request.id, "analysis-failed")
  return reportsFromOutput(outcome.stdout, request)
}

function reportsFromOutput(
  stdout: string,
  request: CcccWorkerRequest,
): CcccWorkerResponse | CcccWorkerFailure {
  const output = JSON.parse(stdout) as CcccWasmOutput
  if (!Array.isArray(output.reports)) return workerFailure(request.id, "worker-invalid-output")
  const reports = output.reports.map((file) => sanitizeReport(file, request))
  return { id: request.id, ok: true, reports }
}

function analysisFailure(id: number, error: unknown): CcccWorkerFailure {
  return workerFailure(id, failureCode(error))
}

function failureCode(error: unknown): CcccWorkerFailure["code"] {
  if (error instanceof SyntaxError) return "worker-invalid-output"
  return "analysis-failed"
}

function workerFailure(id: number, code: CcccWorkerFailure["code"]): CcccWorkerFailure {
  return { id, ok: false, code }
}

let queue = Promise.resolve()
port.on("message", (request: CcccWorkerRequest) => {
  queue = queue.then(async () => {
    try {
      const response = await analyze(request)
      port.postMessage(response)
    } catch {
      const failed: CcccWorkerFailure = {
        id: request.id,
        ok: false,
        code: "analysis-failed",
      }
      port.postMessage(failed)
    } finally {
      // WASI bindings are cleared by runFallowModule; collect any completed run's buffers.
      Bun.gc(true)
    }
  })
})
port.postMessage({ ready: true })
