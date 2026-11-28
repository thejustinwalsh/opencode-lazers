import {
  findingFor,
  flattenFunctions,
  increased,
  overlapsChangedLine,
  pairFunctions,
  type FlatFunction,
} from "./compare.ts"
import { collectFunctionIdentities } from "./function-identities.ts"
import { safeRepositoryPath } from "./privacy.ts"
import type {
  CcccChangedFile,
  CcccComparisonSnapshot,
  CcccFileReport,
  CcccFunctionFinding,
  CcccSettings,
  CcccSide,
  CcccSnapshotReader,
  CcccSourceInput,
} from "./types.ts"

interface ComparisonInput {
  reader: CcccSnapshotReader
  snapshot: CcccComparisonSnapshot
  reports: readonly CcccFileReport[]
  sources: readonly CcccSourceInput[]
  settings: CcccSettings
  signal: AbortSignal
}

export async function compareChangedFiles(input: ComparisonInput) {
  const reports = new Map(
    input.reports.map((report) => [`${report.side}\0${safeRepositoryPath(report.path)}`, report]),
  )
  const sources = new Map(
    input.sources.map((source) => [`${source.side}\0${source.path}`, source.source]),
  )
  const findings: CcccFunctionFinding[] = []
  const measuredFiles = new Set<string>()

  for (const change of input.snapshot.changedFiles) {
    input.signal.throwIfAborted()
    const result = await compareOneFile(input, change, reports, sources)
    if (result.measured) measuredFiles.add(change.path)
    findings.push(...result.findings)
  }
  return { findings, measuredFiles }
}

async function compareOneFile(
  input: ComparisonInput,
  change: CcccChangedFile,
  reports: ReadonlyMap<string, CcccFileReport>,
  sources: ReadonlyMap<string, string>,
): Promise<{ measured: boolean; findings: CcccFunctionFinding[] }> {
  if (change.binary) return { measured: false, findings: [] }
  const basePath = change.status === "renamed" ? (change.previousPath ?? change.path) : change.path
  const base = reports.get(reportKey("base", basePath))
  const head = reports.get(reportKey("head", change.path))
  const measured = (base?.functions.length ?? 0) > 0 || (head?.functions.length ?? 0) > 0
  const pair = pairableReports(base, head, change.status)
  if (!pair) return { measured, findings: [] }
  return compareFunctionReports(input, change, pair.base, pair.head, basePath, sources, measured)
}

function pairableReports(
  base: CcccFileReport | undefined,
  head: CcccFileReport | undefined,
  status: CcccChangedFile["status"],
): { base: CcccFileReport; head: CcccFileReport } | undefined {
  if (!base || !head || status === "added" || status === "removed") return undefined
  return { base, head }
}

async function compareFunctionReports(
  input: ComparisonInput,
  change: CcccChangedFile,
  base: CcccFileReport,
  head: CcccFileReport,
  basePath: string,
  sources: ReadonlyMap<string, string>,
  measured: boolean,
): Promise<{ measured: boolean; findings: CcccFunctionFinding[] }> {
  const baseFunctions = flattenFunctions(base, base.lineCount)
  const headFunctions = flattenFunctions(head, head.lineCount)
  const [baseKeys, headKeys] = await Promise.all([
    collectFunctionIdentities(
      input.reader,
      input.snapshot.comparisonID,
      "base",
      basePath,
      sources.get(sourceKey("base", basePath)) ?? "",
      baseFunctions,
      input.signal,
    ),
    collectFunctionIdentities(
      input.reader,
      input.snapshot.comparisonID,
      "head",
      change.path,
      sources.get(sourceKey("head", change.path)) ?? "",
      headFunctions,
      input.signal,
    ),
  ])
  const pairs = pairFunctions(baseFunctions, headFunctions, (side, fn) =>
    identityFor(side, fn, baseKeys, headKeys),
  )
  return {
    measured,
    findings: findingsForPairs(pairs, change, input.settings, input.signal),
  }
}

function identityFor(
  side: CcccSide,
  fn: FlatFunction,
  base: ReadonlyMap<FlatFunction, string>,
  head: ReadonlyMap<FlatFunction, string>,
): string | undefined {
  return (side === "base" ? base : head).get(fn)
}

function findingsForPairs(
  pairs: ReturnType<typeof pairFunctions>,
  change: CcccChangedFile,
  settings: CcccSettings,
  signal: AbortSignal,
): CcccFunctionFinding[] {
  const findings: CcccFunctionFinding[] = []
  for (const pair of pairs) {
    signal.throwIfAborted()
    if (!increased(pair)) continue
    if (!overlapsChangedLine(change.changedLines, pair.head.line, pair.head.endLine)) continue
    findings.push(findingFor(pair, settings))
  }
  return findings
}

function reportKey(side: CcccSide, path: string): string {
  return `${side}\0${safeRepositoryPath(path)}`
}

function sourceKey(side: CcccSide, path: string): string {
  return `${side}\0${path}`
}
