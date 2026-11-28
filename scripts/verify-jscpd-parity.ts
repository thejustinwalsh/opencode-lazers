import { fileURLToPath, pathToFileURL } from "node:url"
import { buildJscpdProvider } from "./build-jscpd-provider.ts"
import { runJscpdReleaseOracle } from "./jscpd-release-oracle.ts"
import {
  changedLineMap,
  groupPairs,
  introducedClones,
  mergeClones,
} from "../src/code-review/providers/jscpd/compare.ts"
import {
  DEFAULT_DUPLICATION_SETTINGS,
  JSCPD_DETECTOR_IDS,
  type DuplicationFinding,
  type JscpdComparisonInput,
  type JscpdDetector,
  type JscpdSideReport,
  type WasmScanRequest,
} from "../src/code-review/providers/jscpd/contract.ts"
import {
  makeCapturedConfigParityRequest,
  makeIsolatedConfigParityRequest,
} from "../src/code-review/providers/jscpd/config-parity-input.ts"
import {
  makeEmbeddedParityRequest,
  makeParityRequest,
} from "../src/code-review/providers/jscpd/test-input.ts"

const root = fileURLToPath(new URL("..", import.meta.url))

interface PackagedProvider {
  analyzeDuplicationComparison(
    input: JscpdComparisonInput,
    options?: {
      settings?: typeof DEFAULT_DUPLICATION_SETTINGS
    },
  ): Promise<{
    status: string
    findings: readonly DuplicationFinding[]
    coverage: {
      head: {
        filesIgnored: number
      }
    }
  }>
}

function selectedSettings(detectors: readonly JscpdDetector[]) {
  const selected = new Set(detectors)
  return {
    ...DEFAULT_DUPLICATION_SETTINGS,
    detectors: {
      strict: selected.has("strict"),
      mild: selected.has("mild"),
      weak: selected.has("weak"),
      renamed: selected.has("renamed"),
      gap: selected.has("gap"),
      ast: selected.has("ast"),
      crossLanguage: selected.has("cross-language"),
    },
  }
}

function copyPath(path: string): string {
  const slash = path.lastIndexOf("/")
  const dot = path.lastIndexOf(".")
  const extension = dot > slash ? path.slice(dot) : ""
  return `${slash < 0 ? "" : path.slice(0, slash + 1)}release-added-copy${extension}`
}

function sourceLineCount(source: string): number {
  return source.split("\n").length
}

function expectedFindings(
  base: JscpdSideReport["detectors"],
  head: JscpdSideReport["detectors"],
  changedLines: JscpdComparisonInput["changedLines"],
): DuplicationFinding[] {
  const headByDetector = new Map(head.map((report) => [report.detector, report.clones]))
  const baseByDetector = new Map(base.map((report) => [report.detector, report.clones]))
  const changed = changedLineMap(changedLines)
  const found = JSCPD_DETECTOR_IDS.flatMap((detector) => {
    const baseGroups = groupPairs(baseByDetector.get(detector) ?? [])
    const headGroups = groupPairs(headByDetector.get(detector) ?? [])
    const clones = introducedClones(baseGroups, headGroups, changed)
    return clones.length > 0 ? [{ detector, clones }] : []
  })
  return mergeClones(found, changed)
    .filter((clone) => clone.introduced.length + clone.others.length >= 2)
    .map((clone) => ({
      fingerprint: clone.primary.group.fingerprint,
      detector: clone.detector,
      detectors: clone.detectors,
      instances: [...clone.introduced, ...clone.others],
      introducedInstances: clone.introduced.length,
      baseInstances: clone.primary.baseInstances,
      lines: clone.primary.group.lines,
      tokens: clone.primary.group.tokens,
      severity:
        clone.primary.group.tokens >= DEFAULT_DUPLICATION_SETTINGS.warningTokens
          ? "warning"
          : "info",
      provenance: clone.detector === "strict" || clone.detector === "mild" ? "exact" : "heuristic",
      kind: clone.primary.group.kind,
      configurationChanged: false,
      ...(clone.similarity === undefined ? {} : { similarity: clone.similarity }),
    }))
}

function findingIdentity(findings: readonly DuplicationFinding[]) {
  return findings
    .map((finding) => ({
      fingerprint: finding.fingerprint,
      detector: finding.detector,
      detectors: [...finding.detectors],
      instances: [...finding.instances]
        .map(({ path, startLine, endLine }) => ({ path, startLine, endLine }))
        .sort(
          (left, right) =>
            left.path.localeCompare(right.path) ||
            left.startLine - right.startLine ||
            left.endLine - right.endLine,
        ),
      introducedInstances: finding.introducedInstances,
      baseInstances: finding.baseInstances,
      lines: finding.lines,
      tokens: finding.tokens,
      severity: finding.severity,
      provenance: finding.provenance,
      kind: finding.kind,
      configurationChanged: finding.configurationChanged,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

async function verifyCase(
  provider: PackagedProvider,
  name: string,
  scan: WasmScanRequest,
): Promise<{ findings: number; nativePairs: number }> {
  const original = scan.files[0]
  if (!original) throw new Error(`Parity case ${name} has no source file.`)
  const copy = { ...original, path: copyPath(original.path) }
  const headFiles = [...scan.files, copy]
  const changedLines = [{ path: copy.path, startLine: 1, endLine: sourceLineCount(copy.source) }]
  const baseScan = { ...scan, files: scan.files }
  const headScan = { ...scan, files: headFiles }
  const comparison: JscpdComparisonInput = {
    comparisonID: `jscpd-release-parity:${name}`,
    base: {
      files: baseScan.files,
      complete: true,
      config: scan.config,
      ignoreFiles: scan.ignoreFiles,
      ignoreFilesComplete: true,
    },
    head: {
      files: headFiles,
      complete: true,
      config: scan.config,
      ignoreFiles: scan.ignoreFiles,
      ignoreFilesComplete: true,
    },
    changedLines,
  }

  const [baseOracle, headOracle, result] = await Promise.all([
    runJscpdReleaseOracle(baseScan),
    runJscpdReleaseOracle(headScan),
    provider.analyzeDuplicationComparison(comparison, {
      settings: selectedSettings(scan.detectors),
    }),
  ])
  if (result.status !== "complete")
    throw new Error(`Packaged provider returned non-complete coverage in parity case ${name}.`)
  const expected = expectedFindings(baseOracle, headOracle, changedLines)
  const actualIdentity = JSON.stringify(findingIdentity(result.findings))
  const expectedIdentity = JSON.stringify(findingIdentity(expected))
  if (actualIdentity !== expectedIdentity)
    throw new Error(
      `Packaged public provider differs from pinned jscpd 5.4.0 in ${name}: ${JSON.stringify({ actual: findingIdentity(result.findings), expected: findingIdentity(expected) })}`,
    )
  const serialized = JSON.stringify(result)
  for (const file of headFiles) {
    if (serialized.includes(file.source))
      throw new Error(`Packaged provider output leaked source in parity case ${name}.`)
  }
  return {
    findings: result.findings.length,
    nativePairs: [...baseOracle, ...headOracle].reduce(
      (sum, report) => sum + report.clones.length,
      0,
    ),
  }
}

const configurationRequest = makeCapturedConfigParityRequest()
const isolatedRequest = makeIsolatedConfigParityRequest()
const localRequest = makeParityRequest()
localRequest.detectors = ["mild"]
localRequest.config = { mode: "mild", skipLocal: true }

await buildJscpdProvider()
const providerURL = pathToFileURL(`${root}/dist/jscpd-provider.js`)
const provider = (await import(providerURL.href)) as PackagedProvider
const cases = [
  ["seven-detectors", makeParityRequest()],
  ["embedded-vue", makeEmbeddedParityRequest()],
  ["captured-format-and-ignore", configurationRequest],
  ["skip-local", localRequest],
  ["skip-isolated", isolatedRequest],
] as const
let pairCount = 0
let findingCount = 0
for (const [name, scan] of cases) {
  const result = await verifyCase(provider, name, scan)
  pairCount += result.nativePairs
  findingCount += result.findings
}

console.log(
  `Pinned jscpd 5.4.0 release parity passed: ${cases.length} cases, ${pairCount} native clone pairs, ${findingCount} packaged findings.`,
)
