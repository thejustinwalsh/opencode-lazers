import { readFile } from "node:fs/promises"
import { basename, isAbsolute, relative } from "node:path"
import { Worker } from "node:worker_threads"
import type { DuplicationReport, HealthFinding, HealthReport } from "@fallow-cli/fallow-node"
import { workerURL } from "../worker-url.ts"
import { nativeFallowAnalyzer, type AnalyzerScope, type FallowAnalyzer } from "./analyzer.ts"
import type { FallowWorkerRequest, FallowWorkerResponse } from "./fallow-worker.ts"

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
    this.worker = worker
    return worker
  }

  private fail(worker: Worker, error: Error): void {
    if (this.worker === worker) this.worker = undefined
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
  ): Promise<FallowWorkerResponse> {
    return new Promise((resolve, reject) => {
      const id = this.nextID++
      const worker = this.worker ?? this.spawn()
      const timer = setTimeout(
        () => this.stop(new Error(`timeout: analyzer call exceeded ${REQUEST_TIMEOUT_MS}ms`)),
        REQUEST_TIMEOUT_MS,
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
  ): Promise<FallowWorkerResponse> {
    signal?.throwIfAborted()
    const run = this.queue.then(() => {
      signal?.throwIfAborted()
      return this.exchange(request, signal)
    })
    this.queue = run.catch(() => undefined)
    return run
  }
}

const client = new WorkerClient()

async function configText(configPath: string | undefined) {
  if (!configPath) return { configName: "", configText: "" }
  return { configName: basename(configPath), configText: await readFile(configPath, "utf8") }
}

function relativePaths(root: string, files: readonly string[]): string[] {
  return files.map((file) => (isAbsolute(file) ? relative(root, file) : file))
}

async function canUseNative(): Promise<boolean> {
  try {
    await import("@fallow-cli/fallow-node")
    return true
  } catch {
    return false
  }
}

async function call(
  kind: "complexity" | "duplication",
  scope: AnalyzerScope,
): Promise<Record<string, unknown>> {
  const files = scope.files ? relativePaths(scope.root, scope.files) : undefined
  const response = await client.request(
    {
      kind,
      root: scope.root,
      ...(kind === "complexity" ? { files } : { changed: files }),
      ...(await configText(scope.configPath)),
    },
    scope.signal,
  )
  if ("error" in response) throw new AnalyzerError(response.error.code, response.error.message)
  return response.report
}

/** `extends-unsupported` means the config needs host inlining; native can follow it. */
async function withNativeFallback<T>(run: () => Promise<T>, native: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (
      error instanceof AnalyzerError &&
      error.code === "extends-unsupported" &&
      (await canUseNative())
    )
      return native()
    throw error
  }
}

/** Complexity and duplication run in the WebAssembly worker; dead code stays native. */
export const wasmFallowAnalyzer: FallowAnalyzer = {
  complexity: (scope) =>
    withNativeFallback(
      async () => toHealthReport((await call("complexity", scope)) as unknown as WasmComplexity),
      () => nativeFallowAnalyzer.complexity(scope),
    ),
  duplication: (scope) =>
    withNativeFallback(
      async () =>
        toDuplicationReport((await call("duplication", scope)) as unknown as WasmDuplication),
      () => nativeFallowAnalyzer.duplication(scope),
    ),
  async deadCode(scope) {
    if (!(await canUseNative()))
      throw new AnalyzerError(
        "dead-code-unavailable",
        "dead code needs the native Fallow binding, which could not be loaded",
      )
    return nativeFallowAnalyzer.deadCode(scope)
  },
  async cycles(scope) {
    if (!(await canUseNative()))
      throw new AnalyzerError(
        "cycles-unavailable",
        "import cycles need the native Fallow binding, which could not be loaded",
      )
    return nativeFallowAnalyzer.cycles(scope)
  },
}

/** The analyzer the review and the exploration tools use unless a caller passes another. */
export const defaultFallowAnalyzer: FallowAnalyzer = wasmFallowAnalyzer
