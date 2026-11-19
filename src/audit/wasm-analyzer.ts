import { isAbsolute, relative } from "node:path"
import { Worker } from "node:worker_threads"
import { workerURL } from "../worker-url.ts"
import type { AnalyzerScope, FallowAnalyzer } from "./analyzer.ts"
import type {
  FallowWorkerKind,
  FallowWorkerRequest,
  FallowWorkerResponse,
} from "./fallow-worker.ts"
import type {
  DeadCodeReport,
  DuplicationReport,
  HealthFinding,
  HealthReport,
} from "./fallow-types.ts"

const REQUEST_TIMEOUT_MS = 60_000

type WasmFunction = {
  file: string
  name: string
  line: number
  cyclomatic: number
  cognitive: number
  lineCount: number
}
type WasmComplexity = {
  functions: WasmFunction[]
  thresholds?: { maxCyclomatic: number; maxCognitive: number }
}
type WasmGroup = {
  tokenCount: number
  lineCount: number
  instances: { file: string; startLine: number; endLine: number }[]
}
type WasmDuplication = {
  groups: WasmGroup[]
  stats: {
    totalFiles: number
    totalLines: number
    duplicatedLines: number
    cloneGroups: number
    duplicationPercentage: number
  }
}

class AnalyzerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`)
  }
}

/**
 * Report fields the module does not produce, and what the types promise instead:
 *  - HealthFinding: `col` and `param_count` are 0, `severity` is "moderate", no `crap`,
 *    `coverage_pct` or `actions`. CRAP-only findings are absent (needs the coverage model).
 *  - HealthReport: only `findings` and `summary` thresholds are filled.
 *  - CloneInstance: `start_col` and `end_col` are 0. CloneGroup: `spread` is 0.
 *  - DuplicationStats: `files_with_clones`, `total_tokens` and `duplicated_tokens` are 0.
 * The review reads only `findings[].{path,name,cyclomatic,cognitive,line}` and
 * `clone_groups[].{token_count,instances[].{file,start_line,end_line}}`; the tools add
 * `line_count`, `duplication_percentage` and `exceeded`.
 */
function exceededBy(fn: WasmFunction, thresholds: WasmComplexity["thresholds"]): string {
  const cyclomatic = fn.cyclomatic > (thresholds?.maxCyclomatic ?? Infinity)
  const cognitive = fn.cognitive > (thresholds?.maxCognitive ?? Infinity)
  return cyclomatic && cognitive ? "both" : cyclomatic ? "cyclomatic" : "cognitive"
}

function toHealthReport(report: WasmComplexity): HealthReport {
  const findings: HealthFinding[] = report.functions.map((fn) => ({
    path: fn.file,
    name: fn.name,
    line: fn.line,
    col: 0,
    cyclomatic: fn.cyclomatic,
    cognitive: fn.cognitive,
    line_count: fn.lineCount,
    param_count: 0,
    exceeded: exceededBy(fn, report.thresholds),
    severity: "moderate",
  }))
  return {
    schema_version: 0,
    version: "wasm",
    elapsed_ms: 0,
    findings,
    summary: {
      functions_above_threshold: findings.length,
      max_cyclomatic_threshold: report.thresholds?.maxCyclomatic,
      max_cognitive_threshold: report.thresholds?.maxCognitive,
    },
  }
}

function toDuplicationReport(report: WasmDuplication): DuplicationReport {
  return {
    schema_version: 0,
    version: "wasm",
    elapsed_ms: 0,
    clone_groups: report.groups.map((group) => ({
      token_count: group.tokenCount,
      line_count: group.lineCount,
      spread: 0,
      instances: group.instances.map((i) => ({
        file: i.file,
        start_line: i.startLine,
        end_line: i.endLine,
        start_col: 0,
        end_col: 0,
      })),
    })),
    stats: {
      total_files: report.stats.totalFiles,
      files_with_clones: 0,
      total_lines: report.stats.totalLines,
      duplicated_lines: report.stats.duplicatedLines,
      total_tokens: 0,
      duplicated_tokens: 0,
      clone_groups: report.stats.cloneGroups,
      clone_instances: report.groups.reduce((sum, group) => sum + group.instances.length, 0),
      duplication_percentage: report.stats.duplicationPercentage,
    },
  }
}

type Pending = {
  resolve: (response: FallowWorkerResponse) => void
  reject: (error: Error) => void
}

/** One worker thread, spawned on first use and replaced after a terminate. */
class WorkerClient {
  private worker: Worker | undefined
  private pending: (Pending & { id: number }) | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private nextID = 1

  private spawn(): Worker {
    const worker = new Worker(workerURL("./fallow-worker", import.meta.url))
    worker.on("message", (message: FallowWorkerResponse | { ready: true }) => {
      if ("ready" in message) return
      const pending = this.pending
      if (pending?.id !== message.id) return
      this.pending = undefined
      pending.resolve(message)
    })
    worker.on("error", (error: Error) => this.fail(worker, error))
    worker.on("exit", () => this.fail(worker, new Error("worker exited")))
    // An idle analyzer must not keep its process alive: a runtime that has stopped exits.
    worker.unref()
    this.worker = worker
    return worker
  }

  private fail(worker: Worker, error: Error): void {
    // A worker that was already replaced (after an abort or timeout) reports its exit late; the
    // request now pending belongs to its successor.
    if (this.worker !== worker) return
    this.worker = undefined
    const pending = this.pending
    this.pending = undefined
    pending?.reject(new AnalyzerError("analyzer-unavailable", error.message))
  }

  /** Terminating is the only cancel; the next request starts a fresh worker. */
  private stop(reason: Error): void {
    const worker = this.worker
    this.worker = undefined
    const pending = this.pending
    this.pending = undefined
    void worker?.terminate()
    pending?.reject(reason)
  }

  private exchange(
    request: Omit<FallowWorkerRequest, "id">,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<FallowWorkerResponse> {
    return new Promise((resolve, reject) => {
      const id = this.nextID++
      const worker = this.worker ?? this.spawn()
      const timer = setTimeout(
        () => this.stop(new Error(`timeout: analyzer call exceeded ${timeoutMs}ms`)),
        timeoutMs,
      )
      const onAbort = () =>
        this.stop(new Error(`cancelled: ${String(signal?.reason ?? "aborted")}`))
      signal?.addEventListener("abort", onAbort, { once: true })
      const done = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
      }
      this.pending = {
        id,
        resolve: (response) => (done(), resolve(response)),
        reject: (error) => (done(), reject(error)),
      }
      worker.postMessage({ ...request, id })
    })
  }

  request(
    request: Omit<FallowWorkerRequest, "id">,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<FallowWorkerResponse> {
    signal?.throwIfAborted()
    const run = this.queue.then(() => {
      signal?.throwIfAborted()
      return this.exchange(request, signal, timeoutMs)
    })
    this.queue = run.catch(() => undefined)
    return run
  }
}

const client = new WorkerClient()

function relativePaths(root: string, files: readonly string[]): string[] {
  return files.map((file) => (isAbsolute(file) ? relative(root, file) : file))
}

async function call(
  kind: FallowWorkerKind,
  scope: AnalyzerScope,
  options: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const files = scope.files ? relativePaths(scope.root, scope.files) : undefined
  const response = await client.request(
    {
      kind,
      root: scope.root,
      ...(kind === "duplication" ? { changed: files } : { files }),
      ...(scope.configPath ? { configPath: scope.configPath } : {}),
      options,
    },
    scope.signal,
    scope.timeoutMs ?? REQUEST_TIMEOUT_MS,
  )
  if ("error" in response) throw new AnalyzerError(response.error.code, response.error.message)
  return response.report
}

/** The report sections `lz-fallow-report` stores, each as the native binding would return it. */
export type ReportSection = "deadCode" | "duplication" | "health" | "architecture" | "featureFlags"

const SECTION_KIND: Record<ReportSection, FallowWorkerKind> = {
  deadCode: "deadCode",
  duplication: "duplicationReport",
  health: "health",
  architecture: "architecture",
  featureFlags: "featureFlagReport",
}

/** One section of the full report: explained findings, CSS health included, one analysis thread. */
export function fallowSection(
  section: ReportSection,
  scope: AnalyzerScope,
): Promise<Record<string, unknown>> {
  return call(SECTION_KIND[section], scope, { explain: true, css: true })
}

/** Every analysis runs in the WebAssembly worker; no native binding is loaded. */
export const wasmFallowAnalyzer: FallowAnalyzer = {
  async complexity(scope) {
    return toHealthReport((await call("complexity", scope)) as unknown as WasmComplexity)
  },
  async duplication(scope) {
    return toDuplicationReport((await call("duplication", scope)) as unknown as WasmDuplication)
  },
  async deadCode(scope) {
    return (await call("deadCode", scope)) as unknown as DeadCodeReport
  },
  async cycles(scope) {
    return (await call("cycles", scope)) as unknown as DeadCodeReport
  },
}

/** The analyzer the review and the exploration tools use unless a caller passes another. */
export const defaultFallowAnalyzer: FallowAnalyzer = wasmFallowAnalyzer
