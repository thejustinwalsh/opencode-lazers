import { changedLineMap, groupPairs, introducedClones, mergeClones } from "./compare.ts"
import {
  DEFAULT_DUPLICATION_SETTINGS,
  JSCPD_DETECTOR_IDS,
  JSCPD_TOOL,
  type DuplicationComparisonResult,
  type DuplicationCoverage,
  type DuplicationFailure,
  type DuplicationFinding,
  type DuplicationSettings,
  type InventoryCoverage,
  type JscpdComparisonInput,
  type JscpdConfig,
  type JscpdDetector,
  type JscpdFile,
  type JscpdSideInventory,
  type JscpdSideReport,
  type WasmScanRequest,
} from "./contract.ts"
import { DuplicationAnalysisError, runJscpdSide } from "./worker-client.ts"

const MIN_TOKENS = 50
const MIN_LINES = 5
const DEFAULT_IGNORE = ["**/.git/**", "**/node_modules/**"]

type RunSide = (
  scan: WasmScanRequest,
  options: { signal?: AbortSignal; timeoutMs: number },
) => Promise<JscpdSideReport>

export interface DuplicationProviderOptions {
  settings?: DuplicationSettings
  signal?: AbortSignal
  /** Test seam for deterministic comparison and failure-state checks. */
  runSide?: RunSide
}

interface PreparedInventory {
  files: JscpdFile[]
  preIgnored: number
}

function validRelativePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.includes("\0") ||
    path.includes("\\")
  )
    return false
  const parts = path.split("/")
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..")
}

function ignoredByDefault(path: string): boolean {
  return path.split("/").some((part) => part === ".git" || part === "node_modules")
}

function prepareInventory(inventory: JscpdSideInventory): PreparedInventory {
  const files: JscpdFile[] = []
  let preIgnored = 0
  for (const file of inventory.files) {
    if (!validRelativePath(file.path) || typeof file.source !== "string")
      throw new DuplicationAnalysisError("invalid-request")
    if (file.binary || file.source.includes("\0") || ignoredByDefault(file.path)) {
      preIgnored++
      continue
    }
    files.push({
      path: file.path,
      source: file.source,
      ...(file.format ? { format: file.format } : {}),
    })
  }
  return { files, preIgnored }
}

function normalizedConfig(config: JscpdConfig | undefined): JscpdConfig {
  const defaults: JscpdConfig = {
    mode: "mild",
    ignoreCase: false,
    ignoreIdentifiers: false,
    ignoreLiterals: false,
    ignoreAnnotations: false,
  }
  return {
    ...defaults,
    ...config,
    ignore: [...DEFAULT_IGNORE, ...(config?.ignore ?? [])],
    codeIgnorePatterns: [...(config?.codeIgnorePatterns ?? [])],
    crossFormats: (config?.crossFormats ?? []).map((group) => [...group]),
  }
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`
  if (!value || typeof value !== "object") return JSON.stringify(value) ?? "null"
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  )
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableValue(child)}`).join(",")}}`
}

function detectorsFor(settings: DuplicationSettings): JscpdDetector[] {
  return JSCPD_DETECTOR_IDS.filter((detector) =>
    detector === "cross-language" ? settings.detectors.crossLanguage : settings.detectors[detector],
  )
}

function inventoryCoverage(
  inventory: JscpdSideInventory,
  prepared: PreparedInventory,
  report?: JscpdSideReport,
): InventoryCoverage {
  const omittedFiles = inventory.omittedFiles ?? 0
  const filesReceived = inventory.files.length
  const filesUnsupported = report?.coverage.filesUnsupported ?? 0
  const filesIgnored = prepared.preIgnored + (report?.coverage.filesIgnored ?? 0)
  const filesScanned = report?.coverage.filesScanned ?? 0
  return {
    filesReceived,
    filesScanned,
    filesUnsupported,
    filesIgnored,
    omittedFiles,
    complete:
      inventory.complete &&
      omittedFiles === 0 &&
      report !== undefined &&
      filesUnsupported === 0 &&
      report.coverage.filesReceived === prepared.files.length,
  }
}

function coverage(
  input: { base: JscpdSideInventory; head: JscpdSideInventory },
  prepared: { base: PreparedInventory; head: PreparedInventory },
  requestedDetectors: readonly JscpdDetector[],
  baseReport?: JscpdSideReport,
  headReport?: JscpdSideReport,
): DuplicationCoverage {
  return {
    base: inventoryCoverage(input.base, prepared.base, baseReport),
    head: inventoryCoverage(input.head, prepared.head, headReport),
    requestedDetectors,
    configurationChanged:
      stableValue(normalizedConfig(input.base.config)) !==
      stableValue(normalizedConfig(input.head.config)),
  }
}

function makeFindings(
  base: JscpdSideReport,
  head: JscpdSideReport,
  changedLines: ReturnType<typeof changedLineMap>,
  warningTokens: number,
  configurationChanged: boolean,
): DuplicationFinding[] {
  const headByDetector = new Map(head.detectors.map((report) => [report.detector, report.clones]))
  const baseByDetector = new Map(base.detectors.map((report) => [report.detector, report.clones]))
  const found = JSCPD_DETECTOR_IDS.flatMap((detector) => {
    const baseGroups = groupPairs(baseByDetector.get(detector) ?? [])
    const headGroups = groupPairs(headByDetector.get(detector) ?? [])
    const clones = introducedClones(baseGroups, headGroups, changedLines)
    return clones.length > 0 ? [{ detector, clones }] : []
  })

  return mergeClones(found, changedLines)
    .filter((clone) => clone.introduced.length + clone.others.length >= 2)
    .map((clone) => {
      const instances = [...clone.introduced, ...clone.others]
      const finding: DuplicationFinding = {
        fingerprint: clone.primary.group.fingerprint,
        detector: clone.detector,
        detectors: clone.detectors,
        instances,
        introducedInstances: clone.introduced.length,
        baseInstances: clone.primary.baseInstances,
        lines: clone.primary.group.lines,
        tokens: clone.primary.group.tokens,
        severity: clone.primary.group.tokens >= warningTokens ? "warning" : "info",
        provenance:
          clone.detector === "strict" || clone.detector === "mild" ? "exact" : "heuristic",
        kind: clone.primary.group.kind,
        configurationChanged,
      }
      if (clone.similarity !== undefined)
        finding.similarity = Math.round(clone.similarity * 1000) / 1000
      return finding
    })
}

function validateChangedLines(input: JscpdComparisonInput): boolean {
  return input.changedLines.every(
    (range) =>
      validRelativePath(range.path) &&
      Number.isInteger(range.startLine) &&
      Number.isInteger(range.endLine) &&
      range.startLine > 0 &&
      range.endLine >= range.startLine,
  )
}

interface SideRun {
  report?: JscpdSideReport
  failure?: DuplicationFailure
}

function failureCode(error: unknown): DuplicationFailure["code"] {
  return error instanceof DuplicationAnalysisError ? error.code : "analyzer-unavailable"
}

async function scanSide(
  side: DuplicationFailure["side"],
  scan: WasmScanRequest,
  options: { signal?: AbortSignal; timeoutMs: number },
  runSide: RunSide,
): Promise<SideRun> {
  try {
    return { report: await runSide(scan, options) }
  } catch (error) {
    if (options.signal?.aborted)
      throw new DOMException("Duplication analysis was cancelled.", "AbortError")
    return { failure: { code: failureCode(error), side } }
  }
}

function unavailable(
  comparisonID: string,
  coverage: DuplicationCoverage,
  failure: DuplicationFailure,
): DuplicationComparisonResult {
  return { status: "unavailable", comparisonID, tool: JSCPD_TOOL, coverage, findings: [], failure }
}

function sideRequest(
  prepared: PreparedInventory,
  detectors: readonly JscpdDetector[],
  config: JscpdConfig,
): WasmScanRequest {
  return { files: prepared.files, detectors, minTokens: MIN_TOKENS, minLines: MIN_LINES, config }
}

/**
 * Compare complete captured side inventories. It never walks a worktree, emits source text, or
 * treats a failed/partial scan as a clean comparison.
 */
export async function analyzeDuplicationComparison(
  input: JscpdComparisonInput,
  options: DuplicationProviderOptions = {},
): Promise<DuplicationComparisonResult> {
  const settings = options.settings ?? DEFAULT_DUPLICATION_SETTINGS
  const detectors = detectorsFor(settings)
  if (
    typeof input.comparisonID !== "string" ||
    input.comparisonID.trim().length === 0 ||
    !Number.isInteger(settings.timeoutMs) ||
    settings.timeoutMs < 1 ||
    !Number.isInteger(settings.warningTokens) ||
    settings.warningTokens < 1 ||
    !validateChangedLines(input)
  )
    throw new DuplicationAnalysisError("invalid-request")

  const prepared = {
    base: prepareInventory(input.base),
    head: prepareInventory(input.head),
  }
  if (detectors.length === 0)
    return {
      status: "disabled",
      comparisonID: input.comparisonID,
      tool: JSCPD_TOOL,
      coverage: coverage(input, prepared, detectors),
      findings: [],
    }

  const runSide = options.runSide ?? runJscpdSide
  const config = {
    base: normalizedConfig(input.base.config),
    head: normalizedConfig(input.head.config),
  }
  const runOptions = { signal: options.signal, timeoutMs: settings.timeoutMs }
  const base = await scanSide(
    "base",
    sideRequest(prepared.base, detectors, config.base),
    runOptions,
    runSide,
  )
  if (base.failure)
    return unavailable(input.comparisonID, coverage(input, prepared, detectors), base.failure)
  const baseReport = base.report!
  const head = await scanSide(
    "head",
    sideRequest(prepared.head, detectors, config.head),
    runOptions,
    runSide,
  )
  if (head.failure)
    return unavailable(
      input.comparisonID,
      coverage(input, prepared, detectors, baseReport),
      head.failure,
    )
  const headReport = head.report!

  const finalCoverage = coverage(input, prepared, detectors, baseReport, headReport)
  const findings = makeFindings(
    baseReport,
    headReport,
    changedLineMap(input.changedLines),
    settings.warningTokens,
    finalCoverage.configurationChanged,
  )
  return {
    status: finalCoverage.base.complete && finalCoverage.head.complete ? "complete" : "partial",
    comparisonID: input.comparisonID,
    tool: JSCPD_TOOL,
    coverage: finalCoverage,
    findings,
  }
}
