import { memoryExhausted, runFallowModule, WasiTrap } from "../../../audit/fallow-wasi.ts"
import {
  JSCPD_DETECTOR_IDS,
  type CloneLocation,
  type ClonePair,
  type DetectorReport,
  type DuplicationFailureCode,
  type JscpdDetector,
  type JscpdSideReport,
  type ScanCoverage,
  type WasmScanRequest,
} from "./contract.ts"

type SafePairData = Record<string, unknown> &
  Pick<ClonePair, "fingerprint" | "format" | "kind" | "tokens" | "lines"> & {
    similarity?: number
  }

function failure(code: DuplicationFailureCode): Error {
  return Object.assign(new Error(), { code })
}

function executionFailure(error: unknown): Error {
  if (!(error instanceof WasiTrap)) return failure("worker-failed")
  return failure(
    memoryExhausted(error.stderr) === undefined ? "analyzer-unavailable" : "analyzer-memory",
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0
}

function isDetector(value: unknown): value is JscpdDetector {
  return typeof value === "string" && JSCPD_DETECTOR_IDS.some((detector) => detector === value)
}

function safePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\") ||
    value.includes("\0")
  )
    return false
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
}

function safeLocation(value: unknown): CloneLocation | undefined {
  if (
    !record(value) ||
    !safePath(value.path) ||
    !nonnegativeInteger(value.startLine) ||
    value.startLine < 1 ||
    !nonnegativeInteger(value.endLine) ||
    value.endLine < value.startLine
  )
    return undefined
  return { path: value.path, startLine: value.startLine, endLine: value.endLine }
}

function safeFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^jscpd:[a-f0-9]{12}$/.test(value)
}

function safeFormat(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,63}$/.test(value)
}

function safeKind(value: unknown): value is ClonePair["kind"] {
  return typeof value === "string" && ["exact", "renamed", "similar", "gap"].includes(value)
}

function safeSimilarity(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)
  )
}

function safePairIdentity(value: Record<string, unknown>): boolean {
  return safeFingerprint(value.fingerprint) && safeFormat(value.format) && safeKind(value.kind)
}

function safePairMeasures(value: Record<string, unknown>): boolean {
  return (
    nonnegativeInteger(value.tokens) &&
    nonnegativeInteger(value.lines) &&
    safeSimilarity(value.similarity)
  )
}

function isSafePairData(value: unknown): value is SafePairData {
  return record(value) && safePairIdentity(value) && safePairMeasures(value)
}

function safePair(value: unknown): ClonePair | undefined {
  if (!isSafePairData(value)) return undefined
  const first = safeLocation(value.first)
  const second = safeLocation(value.second)
  if (!first || !second) return undefined
  return {
    fingerprint: value.fingerprint,
    format: value.format,
    kind: value.kind,
    tokens: value.tokens,
    lines: value.lines,
    first,
    second,
    ...(value.similarity === undefined ? {} : { similarity: value.similarity }),
  }
}

function safeDetector(value: unknown): DetectorReport | undefined {
  if (!record(value) || !isDetector(value.detector)) return undefined
  if (!Array.isArray(value.clones)) return undefined
  const clones = value.clones.map(safePair)
  if (clones.some((clone) => clone === undefined)) return undefined
  return {
    detector: value.detector,
    clones: clones as ClonePair[],
  }
}

function safeCoverage(value: unknown): ScanCoverage | undefined {
  if (
    !record(value) ||
    !nonnegativeInteger(value.filesReceived) ||
    !nonnegativeInteger(value.filesScanned) ||
    !nonnegativeInteger(value.filesUnsupported) ||
    !nonnegativeInteger(value.filesIgnored)
  )
    return undefined
  return {
    filesReceived: value.filesReceived,
    filesScanned: value.filesScanned,
    filesUnsupported: value.filesUnsupported,
    filesIgnored: value.filesIgnored,
  }
}

/** Run the pinned adapter against buffered source; diagnostics never cross this boundary. */
export function executeJscpdScan(
  module: WebAssembly.Module,
  scan: WasmScanRequest,
  root = process.cwd(),
): string {
  try {
    const executed = runFallowModule(module, {
      op: "scan",
      root,
      files: scan.files,
      detectors: scan.detectors,
      minTokens: scan.minTokens,
      minLines: scan.minLines,
      config: scan.config,
    })
    if (executed.exitCode !== undefined && executed.exitCode !== 0)
      throw failure("analyzer-unavailable")
    return executed.stdout
  } catch (error) {
    if (error instanceof Error && "code" in error) throw error
    throw executionFailure(error)
  }
}

/** Project only safe adapter fields; source text and unexpected fields never cross the boundary. */
export function parseJscpdResponse(output: string): JscpdSideReport {
  let parsed: unknown
  try {
    parsed = JSON.parse(output) as unknown
  } catch {
    throw failure("analyzer-unavailable")
  }
  if (!record(parsed)) throw failure("analyzer-unavailable")
  if ("error" in parsed) {
    const error = parsed.error
    throw failure(
      record(error) && error.code === "invalid-request"
        ? "invalid-request"
        : "analyzer-unavailable",
    )
  }
  if (!Array.isArray(parsed.detectors)) throw failure("analyzer-unavailable")
  const detectors = parsed.detectors.map(safeDetector)
  const coverage = safeCoverage(parsed.coverage)
  if (!coverage || detectors.some((detector) => detector === undefined))
    throw failure("analyzer-unavailable")
  return {
    detectors: detectors as DetectorReport[],
    coverage,
  }
}
