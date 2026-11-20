import { isAbsolute, relative } from "node:path"
import { Worker } from "node:worker_threads"
import { workerURL } from "../worker-url.ts"
import { Effect } from "effect"
import type { AnalyzerScope, AuditScope, FallowAnalyzer } from "./analyzer.ts"
import { AnalysisScheduler, type AnalysisExecutor } from "./analysis-scheduler.ts"
import type { FallowThreads } from "./fallow-threads.ts"
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
  id: number
  resolve: (response: FallowWorkerResponse) => void
  reject: (error: Error) => void
}

/**
 * One worker thread, spawned on first use and replaced after a terminate. It runs one request
 * at a time; `AnalysisScheduler` decides which request that is and owns the time limits.
 */
class WorkerClient implements AnalysisExecutor<
  Omit<FallowWorkerRequest, "id">,
  FallowWorkerResponse
> {
  private worker: Worker | undefined
  private pending: Pending | undefined
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
  cancel(reason: Error): void {
    const worker = this.worker
    this.worker = undefined
    const pending = this.pending
    this.pending = undefined
    void worker?.terminate()
    pending?.reject(reason)
  }

  run(request: Omit<FallowWorkerRequest, "id">): Promise<FallowWorkerResponse> {
    return new Promise((resolve, reject) => {
      const id = this.nextID++
      const worker = this.worker ?? this.spawn()
      this.pending = { id, resolve, reject }
      worker.postMessage({ ...request, id })
    })
  }
}

const client = new WorkerClient()
const scheduler = new AnalysisScheduler(client)

let cacheEnabled = true

/** Fallow's own cache in `<root>/.fallow`, on by default. Off writes nothing into the tree. */
export function setFallowCache(enabled: boolean): void {
  cacheEnabled = enabled
}

let threadsMode: FallowThreads = "on"
let threadsFallback: string | undefined

/** The `fallowThreads` option: set once when the plugin starts. Takes effect on the next call. */
export function setFallowThreads(mode: FallowThreads): void {
  threadsMode = mode
}

/** Why analysis runs single-threaded although `fallowThreads` is on, once that has happened. */
export function fallowThreadsFallback(): string | undefined {
  return threadsFallback
}

/** Record the first fallback and log it once; later calls stay on the single-threaded module. */
function noteFallback(reason: string): void {
  if (threadsFallback !== undefined) return
  threadsFallback = reason
  void Effect.runPromise(
    Effect.logWarning("Fallow threaded analysis unavailable; using the single-threaded module", {
      reason,
    }),
  ).catch(() => undefined)
}

function relativePaths(root: string, files: readonly string[]): string[] {
  return files.map((file) => (isAbsolute(file) ? relative(root, file) : file))
}

async function call(
  kind: FallowWorkerKind,
  scope: AnalyzerScope,
  options: Record<string, unknown> = {},
  audit?: Pick<AuditScope, "base" | "baseRoot">,
): Promise<Record<string, unknown>> {
  const files = scope.files ? relativePaths(scope.root, scope.files) : undefined
  const response = await scheduler.submit(
    {
      kind,
      root: scope.root,
      ...(kind === "duplication" ? { changed: files } : { files }),
      ...(scope.configPath ? { configPath: scope.configPath } : {}),
      options,
      threads: threadsFallback === undefined ? threadsMode : "off",
      cache: cacheEnabled,
      ...(scope.cacheSeed ? { cacheSeed: scope.cacheSeed } : {}),
      ...(scope.cachePublish ? { cachePublish: scope.cachePublish } : {}),
      ...(audit ? { base: audit.base, baseRoot: audit.baseRoot } : {}),
    },
    {
      priority: scope.priority ?? "interactive",
      signal: scope.signal,
      timeoutMs: scope.timeoutMs ?? REQUEST_TIMEOUT_MS,
    },
  )
  if ("error" in response) throw new AnalyzerError(response.error.code, response.error.message)
  if (response.fallback !== undefined) noteFallback(response.fallback)
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

/** Dead code, duplication and health from one run that shares the duplication report. */
export async function fallowCombined(scope: AnalyzerScope): Promise<{
  deadCode: Record<string, unknown>
  duplication: Record<string, unknown>
  health: Record<string, unknown>
}> {
  return (await call("combined", scope, { explain: true, css: true })) as never
}

/** Health with duplication left out of the score, for a project too large to index for duplication. */
export function fallowHealthWithoutDuplication(
  scope: AnalyzerScope,
): Promise<Record<string, unknown>> {
  return call("health", scope, { explain: true, css: true, skipDuplication: true })
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
  async projectInfo(scope) {
    return await call("projectInfo", scope)
  },
  async audit(scope) {
    return await call("audit", scope, {}, scope)
  },
}

/** The analyzer the review and the exploration tools use unless a caller passes another. */
export const defaultFallowAnalyzer: FallowAnalyzer = wasmFallowAnalyzer
