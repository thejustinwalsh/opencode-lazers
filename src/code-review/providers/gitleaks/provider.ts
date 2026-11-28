import { wasmURL } from "../../../worker-url.ts"
import {
  DEFAULT_GITLEAKS_SETTINGS,
  GITLEAKS_PROVIDER_ID,
  GITLEAKS_TOOL,
  GITLEAKS_VERSION,
  type GitleaksComparisonReader,
  type GitleaksFailureCode,
  type GitleaksResult,
  type GitleaksSettings,
  type GitleaksSkippedInput,
} from "./contract.ts"
import { isValidGitleaksInput, prepareGitleaksInput } from "./provider-input.ts"
import { isValidGitleaksWasmResult, projectGitleaksResult } from "./projection.ts"
import { WorkerFailure, runGitleaksWorker, type GitleaksWorkerRun } from "./worker-client.ts"
import type { GitleaksWasmRequest, GitleaksWasmResponse } from "./wasm-contract.ts"

export interface GitleaksProviderSeams {
  run?: GitleaksWorkerRun
  loadModule?: () => Promise<WebAssembly.Module>
}

let modulePromise: Promise<WebAssembly.Module> | undefined
function loadGitleaksModule(): Promise<WebAssembly.Module> {
  modulePromise ??= Bun.file(wasmURL("./wasm/gitleaks.wasm", import.meta.url))
    .arrayBuffer()
    .then((bytes) => WebAssembly.compile(bytes))
    .catch((error: unknown) => {
      modulePromise = undefined
      throw error
    })
  return modulePromise
}

function failedResult(
  reader: GitleaksComparisonReader,
  code: GitleaksFailureCode,
  skipped: GitleaksSkippedInput[] = [],
): GitleaksResult {
  const changes = reader.changedLines?.status === "complete" ? "complete" : "unavailable"
  return {
    provider: GITLEAKS_PROVIDER_ID,
    tool: { id: GITLEAKS_TOOL, version: GITLEAKS_VERSION },
    identity: {
      comparisonID: reader.comparisonID,
      baseRevision: reader.baseRevision,
      headRevision: reader.headRevision,
    },
    status: code === "cancelled" ? "cancelled" : "failed",
    coverage: {
      status: "degraded",
      scannedFiles: [],
      skipped,
      changes,
    },
    findings: [],
    unclassified: [],
    inlineAllow: [],
    failure: { code },
  }
}

function staleResult(reader: GitleaksComparisonReader): GitleaksResult {
  return {
    provider: GITLEAKS_PROVIDER_ID,
    tool: { id: GITLEAKS_TOOL, version: GITLEAKS_VERSION },
    identity: {
      comparisonID: reader.comparisonID,
      baseRevision: reader.baseRevision,
      headRevision: reader.headRevision,
    },
    status: "stale",
    coverage: {
      status: "degraded",
      scannedFiles: [],
      skipped: [],
      changes: reader.changedLines?.status === "complete" ? "complete" : "unavailable",
    },
    findings: [],
    unclassified: [],
    inlineAllow: [],
  }
}

const VALID_FAILURE_CODES = new Set<GitleaksFailureCode>([
  "cancelled",
  "input-invalid",
  "source-unavailable",
  "config-unavailable",
  "config-too-large",
  "input-too-large",
  "timeout",
  "worker-failed",
  "worker-exit",
  "wasm-unavailable",
  "wasi-trap",
  "memory-exhausted",
  "invalid-config",
  "invalid-output",
  "detector-failed",
])

function failureCode(code: string): GitleaksFailureCode {
  if (code === "invalid-input") return "input-invalid"
  return VALID_FAILURE_CODES.has(code as GitleaksFailureCode)
    ? (code as GitleaksFailureCode)
    : "detector-failed"
}

async function comparisonIsCurrent(reader: GitleaksComparisonReader): Promise<boolean> {
  if (!reader.isCurrent) return true
  try {
    return await reader.isCurrent(reader.comparisonID)
  } catch {
    return false
  }
}

type DetectorRun =
  { ok: true; response: GitleaksWasmResponse } | { ok: false; code: GitleaksFailureCode }

async function runDetector(
  request: GitleaksWasmRequest,
  seams: GitleaksProviderSeams,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<DetectorRun> {
  if (signal.aborted) return { ok: false, code: "cancelled" }
  let module: WebAssembly.Module
  try {
    module = await (seams.loadModule ?? loadGitleaksModule)()
  } catch {
    return { ok: false, code: "wasm-unavailable" }
  }
  if (signal.aborted) return { ok: false, code: "cancelled" }
  try {
    const response = await (seams.run ?? runGitleaksWorker)(module, request, signal, timeoutMs)
    return { ok: true, response }
  } catch (error) {
    if (error instanceof WorkerFailure) return { ok: false, code: error.code }
    return { ok: false, code: signal.aborted ? "cancelled" : "worker-failed" }
  }
}

function coverageStatus(skipped: GitleaksSkippedInput[], changesComplete: boolean) {
  return skipped.length === 0 && changesComplete ? ("complete" as const) : ("degraded" as const)
}

/**
 * Runs the pinned detector only over immutable comparison content. It never accepts a worktree
 * path, and source strings remain in the request/worker boundary rather than the returned facts.
 */
export async function scanGitleaksComparison(
  reader: GitleaksComparisonReader,
  settings: GitleaksSettings = DEFAULT_GITLEAKS_SETTINGS,
  seams: GitleaksProviderSeams = {},
  signal: AbortSignal = new AbortController().signal,
): Promise<GitleaksResult> {
  if (!isValidGitleaksInput(reader, settings)) return failedResult(reader, "input-invalid")
  if (signal.aborted) return failedResult(reader, "cancelled")
  if (!(await comparisonIsCurrent(reader))) return staleResult(reader)
  const prepared = await prepareGitleaksInput(reader, settings, signal)
  if (!prepared.ok) return failedResult(reader, prepared.code, prepared.skipped)
  const { input } = prepared
  const execution = await runDetector(input.request, seams, signal, settings.timeoutMs)
  if (!execution.ok) return failedResult(reader, execution.code, input.skipped)
  if (signal.aborted) return failedResult(reader, "cancelled", input.skipped)
  if (!(await comparisonIsCurrent(reader))) return staleResult(reader)
  const { response } = execution
  if (!response.ok) return failedResult(reader, failureCode(response.code), input.skipped)
  if (!isValidGitleaksWasmResult(response.result, reader))
    return failedResult(reader, "invalid-output", input.skipped)

  const projection = projectGitleaksResult(response.result, input.changes, input.head)
  const status = coverageStatus(input.skipped, input.request.changesComplete)
  return {
    provider: GITLEAKS_PROVIDER_ID,
    tool: { id: GITLEAKS_TOOL, version: GITLEAKS_VERSION },
    identity: {
      comparisonID: reader.comparisonID,
      baseRevision: reader.baseRevision,
      headRevision: reader.headRevision,
    },
    status,
    coverage: {
      status,
      scannedFiles: input.scannedFiles,
      skipped: input.skipped,
      changes: input.request.changesComplete ? "complete" : "unavailable",
    },
    ...projection,
  }
}
