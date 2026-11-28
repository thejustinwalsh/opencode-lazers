import { compareChangedFiles } from "./comparison-findings.ts"
import { languageOf } from "./languages.ts"
import { safeRepositoryPath } from "./privacy.ts"
import {
  ccccFailure,
  completeCcccResult,
  EMPTY_COVERAGE,
  safeFailureCode,
} from "./provider-result.ts"
import type { SnapshotSources } from "./snapshot.ts"
import { readSnapshotSources } from "./snapshot.ts"
import { safeCcccReports, validCcccSnapshot } from "./report-validation.ts"
import { defaultCcccWorkerAnalyzer } from "./worker-client.ts"
import type {
  CcccComparisonSnapshot,
  CcccFileReport,
  CcccProviderOptions,
  CcccProviderResult,
  CcccSettings,
  CcccSnapshotReader,
  CcccSourceAnalyzer,
} from "./types.ts"

export type Stage<T> =
  { status: "ready"; value: T } | { status: "failed"; result: CcccProviderResult }

export interface PreparedComparison {
  snapshot: CcccComparisonSnapshot
  revisions: { base: string; head: string }
}

export interface CollectedComparison {
  prepared: PreparedComparison
  sources: SnapshotSources
}

export interface AnalyzedComparison extends CollectedComparison {
  reports: CcccFileReport[]
}

export async function prepareComparison(
  reader: CcccSnapshotReader,
  comparisonID: string,
  signal: AbortSignal,
): Promise<Stage<PreparedComparison>> {
  if (signal.aborted) return failed(comparisonID, "cancelled")
  let snapshot: CcccComparisonSnapshot | undefined
  try {
    snapshot = await reader.readComparison(comparisonID, signal)
  } catch {
    return failed(comparisonID, signal.aborted ? "cancelled" : "comparison-unavailable")
  }
  if (signal.aborted) return failed(comparisonID, "cancelled")
  if (!snapshot) return failed(comparisonID, "comparison-unavailable")
  if (snapshot.comparisonID !== comparisonID) return failed(comparisonID, "comparison-mismatch")
  if (!validCcccSnapshot(snapshot)) return failed(comparisonID, "invalid-snapshot")
  return {
    status: "ready",
    value: { snapshot, revisions: { base: snapshot.baseRevision, head: snapshot.headRevision } },
  }
}

export async function collectComparisonSources(
  reader: CcccSnapshotReader,
  prepared: PreparedComparison,
  signal: AbortSignal,
): Promise<Stage<CollectedComparison>> {
  let sources: SnapshotSources
  try {
    sources = await readSnapshotSources(reader, prepared.snapshot, signal)
  } catch {
    const code = signal.aborted ? "cancelled" : "invalid-snapshot"
    return failed(prepared.snapshot.comparisonID, code, EMPTY_COVERAGE, [], prepared.revisions)
  }
  if (signal.aborted)
    return failed(
      prepared.snapshot.comparisonID,
      "cancelled",
      sources.coverage,
      sources.issues,
      prepared.revisions,
    )
  const sourcesCurrent = await isCurrent(reader, prepared.snapshot.comparisonID)
  if (signal.aborted)
    return failed(
      prepared.snapshot.comparisonID,
      "cancelled",
      sources.coverage,
      sources.issues,
      prepared.revisions,
    )
  if (!sourcesCurrent)
    return failed(
      prepared.snapshot.comparisonID,
      "stale-comparison",
      sources.coverage,
      sources.issues,
      prepared.revisions,
    )
  return { status: "ready", value: { prepared, sources } }
}

export async function analyzeComparisonSources(
  reader: CcccSnapshotReader,
  options: CcccProviderOptions,
  settings: CcccSettings,
  collected: CollectedComparison,
  signal: AbortSignal,
): Promise<Stage<AnalyzedComparison>> {
  const { prepared, sources } = collected
  const analyzer: CcccSourceAnalyzer = options.analyzeSources ?? defaultCcccWorkerAnalyzer
  let rawReports: CcccFileReport[]
  try {
    rawReports =
      sources.inputs.length === 0
        ? []
        : await analyzer(sources.inputs, { signal, timeoutMs: settings.timeoutMs })
  } catch (error) {
    const code = signal.aborted ? "cancelled" : safeFailureCode(error)
    return failed(
      prepared.snapshot.comparisonID,
      code,
      sources.coverage,
      sources.issues,
      prepared.revisions,
    )
  }
  if (signal.aborted)
    return failed(
      prepared.snapshot.comparisonID,
      "cancelled",
      sources.coverage,
      sources.issues,
      prepared.revisions,
    )
  const analysisCurrent = await isCurrent(reader, prepared.snapshot.comparisonID)
  if (signal.aborted)
    return failed(
      prepared.snapshot.comparisonID,
      "cancelled",
      sources.coverage,
      sources.issues,
      prepared.revisions,
    )
  if (!analysisCurrent)
    return failed(
      prepared.snapshot.comparisonID,
      "stale-comparison",
      sources.coverage,
      sources.issues,
      prepared.revisions,
    )
  const reports = safeReportsOrUndefined(rawReports, sources.inputs)
  if (!reports)
    return failed(
      prepared.snapshot.comparisonID,
      "worker-invalid-output",
      sources.coverage,
      sources.issues,
      prepared.revisions,
    )
  setReportCoverage(sources, reports)
  return { status: "ready", value: { ...collected, reports } }
}

export async function compareAnalyzedSources(
  reader: CcccSnapshotReader,
  analyzed: AnalyzedComparison,
  settings: CcccSettings,
  signal: AbortSignal,
): Promise<Stage<CcccProviderResult>> {
  const { prepared, sources, reports } = analyzed
  let comparison
  try {
    comparison = await compareChangedFiles({
      reader,
      snapshot: prepared.snapshot,
      reports,
      sources: sources.inputs,
      settings,
      signal,
    })
  } catch {
    return failed(
      prepared.snapshot.comparisonID,
      signal.aborted ? "cancelled" : "comparison-unavailable",
      sources.coverage,
      sources.issues,
      prepared.revisions,
    )
  }
  if (signal.aborted)
    return failed(
      prepared.snapshot.comparisonID,
      "cancelled",
      sources.coverage,
      sources.issues,
      prepared.revisions,
    )
  const comparisonCurrent = await isCurrent(reader, prepared.snapshot.comparisonID)
  if (signal.aborted)
    return failed(
      prepared.snapshot.comparisonID,
      "cancelled",
      sources.coverage,
      sources.issues,
      prepared.revisions,
    )
  if (!comparisonCurrent)
    return failed(
      prepared.snapshot.comparisonID,
      "stale-comparison",
      sources.coverage,
      sources.issues,
      prepared.revisions,
    )
  return {
    status: "ready",
    value: completeCcccResult(
      prepared.snapshot,
      reports,
      sources.coverage,
      sources.issues,
      comparison.findings,
      comparison.measuredFiles,
    ),
  }
}

async function isCurrent(reader: CcccSnapshotReader, comparisonID: string): Promise<boolean> {
  if (!reader.isCurrent) return true
  try {
    return await reader.isCurrent(comparisonID)
  } catch {
    return false
  }
}

function safeReportsOrUndefined(
  reports: CcccFileReport[] | undefined,
  inputs: SnapshotSources["inputs"],
): CcccFileReport[] | undefined {
  if (!Array.isArray(reports)) return undefined
  try {
    return safeCcccReports(reports, inputs)
  } catch {
    return undefined
  }
}

function setReportCoverage(sources: SnapshotSources, reports: readonly CcccFileReport[]): void {
  const parsed = reports.filter((report) => report.parseErrors.count > 0)
  const analyzed = new Set(
    reports.map((report) => `${report.side}\0${safeRepositoryPath(report.path)}`),
  )
  sources.coverage.analyzedFiles = sources.files.filter(({ change, basePath }) => {
    if (change.binary) return false
    const hasBase =
      change.status !== "added" &&
      languageOf(basePath) !== undefined &&
      analyzed.has(`base\0${safeRepositoryPath(basePath)}`)
    const hasHead =
      change.status !== "removed" &&
      languageOf(change.path) !== undefined &&
      analyzed.has(`head\0${safeRepositoryPath(change.path)}`)
    return hasBase || hasHead
  }).length
  sources.coverage.parseErrorFiles = parsed.length
  sources.coverage.parseErrors = parsed.reduce((sum, report) => sum + report.parseErrors.count, 0)
}

function failed(
  comparisonID: string,
  code: Parameters<typeof ccccFailure>[1],
  coverage = EMPTY_COVERAGE,
  issues: Parameters<typeof ccccFailure>[3] = [],
  revisions?: Parameters<typeof ccccFailure>[4],
): Stage<never> {
  return {
    status: "failed",
    result: ccccFailure(comparisonID, code, coverage, issues, revisions),
  }
}
