import { flattenFunctions, functionTotals } from "./compare.ts"
import { safeRepositoryPath } from "./privacy.ts"
import type {
  CcccComparisonSnapshot,
  CcccCoverage,
  CcccFailureCode,
  CcccFileReport,
  CcccProviderIssue,
  CcccProviderResult,
} from "./types.ts"
import { CCCC_TOOL, CCCC_VERSION } from "./types.ts"
import { CcccWorkerError } from "./worker-client.ts"

export const EMPTY_COVERAGE: CcccCoverage = {
  supportedFiles: 0,
  analyzedFiles: 0,
  unsupportedFiles: 0,
  unavailableFiles: 0,
  unclassifiedFiles: 0,
  parseErrorFiles: 0,
  parseErrors: 0,
}

const EMPTY_SUMMARY = {
  files: 0,
  functions: { base: 0, head: 0, delta: 0 },
  cyclomatic: { base: 0, head: 0, delta: 0 },
  cognitive: { base: 0, head: 0, delta: 0 },
  functionsIncreased: 0,
}

export function ccccFailure(
  comparisonID: string,
  code: CcccFailureCode,
  coverage: CcccCoverage = EMPTY_COVERAGE,
  issues: readonly CcccProviderIssue[] = [],
  revisions = { base: "", head: "" },
): CcccProviderResult {
  return {
    comparisonID,
    revisions,
    tool: { name: CCCC_TOOL, version: CCCC_VERSION },
    status: "failed",
    coverage: { ...coverage },
    reports: [],
    findings: [],
    summary: {
      ...EMPTY_SUMMARY,
      functions: { ...EMPTY_SUMMARY.functions },
      cyclomatic: { ...EMPTY_SUMMARY.cyclomatic },
      cognitive: { ...EMPTY_SUMMARY.cognitive },
    },
    failure: { code, message: failureMessage(code) },
    issues: issues.map((issue) => ({ ...issue, path: safeRepositoryPath(issue.path) })),
  }
}

export function safeFailureCode(error: unknown): CcccFailureCode {
  return error instanceof CcccWorkerError ? error.code : "worker-unavailable"
}

function failureMessage(code: CcccFailureCode): string {
  switch (code) {
    case "analysis-timeout":
      return "cccc analysis exceeded its configured time limit"
    case "cancelled":
      return "cccc analysis was cancelled"
    case "worker-invalid-output":
      return "cccc returned an invalid report"
    default:
      return "cccc analysis is unavailable for this comparison"
  }
}

export function completeCcccResult(
  snapshot: CcccComparisonSnapshot,
  reports: CcccFileReport[],
  coverage: CcccCoverage,
  issues: readonly CcccProviderIssue[],
  findings: CcccProviderResult["findings"],
  measuredFiles: ReadonlySet<string>,
): CcccProviderResult {
  const parseErrorCount = coverage.parseErrors
  return {
    comparisonID: snapshot.comparisonID,
    revisions: { base: snapshot.baseRevision, head: snapshot.headRevision },
    tool: { name: CCCC_TOOL, version: CCCC_VERSION },
    status: hasCoverageGaps(coverage, parseErrorCount) ? "degraded" : "complete",
    coverage,
    reports,
    findings,
    summary: summaryFor(reports, findings.length, measuredFiles.size),
    issues: issues.map((issue) => ({ ...issue, path: safeRepositoryPath(issue.path) })),
  }
}

function hasCoverageGaps(coverage: CcccCoverage, parseErrors: number): boolean {
  return (
    coverage.unsupportedFiles > 0 ||
    coverage.unavailableFiles > 0 ||
    coverage.unclassifiedFiles > 0 ||
    parseErrors > 0
  )
}

function summaryFor(reports: readonly CcccFileReport[], increasedCount: number, files: number) {
  const totals = (side: "base" | "head") =>
    functionTotals(
      reports
        .filter((report) => report.side === side)
        .flatMap((report) => flattenFunctions(report, report.lineCount)),
    )
  const base = totals("base")
  const head = totals("head")
  return {
    files,
    functions: {
      base: base.functions,
      head: head.functions,
      delta: head.functions - base.functions,
    },
    cyclomatic: {
      base: base.cyclomatic,
      head: head.cyclomatic,
      delta: head.cyclomatic - base.cyclomatic,
    },
    cognitive: {
      base: base.cognitive,
      head: head.cognitive,
      delta: head.cognitive - base.cognitive,
    },
    functionsIncreased: increasedCount,
  }
}
