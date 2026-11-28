import { languageOf } from "./languages.ts"
import { safeFunctionReport, safeRepositoryPath } from "./privacy.ts"
import type { CcccComparisonSnapshot, CcccFileReport, CcccSourceInput } from "./types.ts"

export function validCcccSnapshot(snapshot: CcccComparisonSnapshot): boolean {
  return (
    typeof snapshot.baseRevision === "string" &&
    snapshot.baseRevision.length > 0 &&
    typeof snapshot.headRevision === "string" &&
    snapshot.headRevision.length > 0 &&
    Array.isArray(snapshot.changedFiles) &&
    snapshot.changedFiles.every(validChangedFile)
  )
}

function validChangedFile(change: unknown): boolean {
  const file = recordOf(change)
  if (!file) return false
  return validChangedIdentity(file) && validChangedOptions(file)
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined
}

function validChangedIdentity(file: Record<string, unknown>): boolean {
  return typeof file.path === "string" && isChangedStatus(file.status)
}

function isChangedStatus(status: unknown): boolean {
  return (
    typeof status === "string" &&
    ["added", "modified", "removed", "renamed", "copied"].includes(status)
  )
}

function validChangedOptions(file: Record<string, unknown>): boolean {
  return (
    optionalString(file.previousPath) &&
    optionalBoolean(file.binary) &&
    validChangedLines(file.changedLines)
  )
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string"
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean"
}

function validChangedLines(lines: unknown): boolean {
  if (lines === undefined) return true
  if (!Array.isArray(lines)) return false
  return lines.every(positiveInteger)
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function validFunction(fn: CcccFileReport["functions"][number], lineCount: number): boolean {
  const functionRecord = recordOf(fn)
  if (!functionRecord) return false
  return (
    validFunctionLabel(functionRecord) &&
    validFunctionMetrics(functionRecord, lineCount) &&
    validFunctionChildren(functionRecord.children, lineCount)
  )
}

function validFunctionLabel(fn: Record<string, unknown>): boolean {
  return typeof fn.name === "string" && typeof fn.kind === "string"
}

function validFunctionMetrics(fn: Record<string, unknown>, lineCount: number): boolean {
  return (
    validLine(fn.line, lineCount) &&
    nonnegativeInteger(fn.cognitive) &&
    nonnegativeInteger(fn.cyclomatic)
  )
}

function validLine(line: unknown, lineCount: number): boolean {
  return positiveInteger(line) && (line as number) <= lineCount
}

function nonnegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function validFunctionChildren(children: unknown, lineCount: number): boolean {
  return children === undefined || (Array.isArray(children) && validFunctions(children, lineCount))
}

function validFunctions(
  functions: readonly CcccFileReport["functions"][number][],
  lineCount: number,
): boolean {
  return Array.isArray(functions) && functions.every((fn) => validFunction(fn, lineCount))
}

function validReportNumbers(report: CcccFileReport): boolean {
  return (
    nonnegativeInteger(report.lineCount) &&
    nonnegativeInteger(report.cognitive) &&
    nonnegativeInteger(report.cyclomatic)
  )
}

function validParseErrors(report: CcccFileReport): boolean {
  const errors = recordOf(report.parseErrors)
  if (!errors) return false
  return nonnegativeInteger(errors.count) && validParseErrorLines(errors.lines, report.lineCount)
}

function validParseErrorLines(lines: unknown, lineCount: number): boolean {
  if (!Array.isArray(lines)) return false
  return lines.every((line) => validLine(line, lineCount))
}

function validReport(
  report: CcccFileReport,
  expected: ReadonlySet<string>,
  seen: ReadonlySet<string>,
): boolean {
  const reportRecord = recordOf(report)
  if (!reportRecord || typeof report.path !== "string") return false
  return validReportIdentity(report, expected, seen) && validReportContent(report)
}

function validReportIdentity(
  report: CcccFileReport,
  expected: ReadonlySet<string>,
  seen: ReadonlySet<string>,
): boolean {
  const key = `${report.side}\0${report.path}`
  return (
    (report.side === "base" || report.side === "head") &&
    expected.has(key) &&
    !seen.has(key) &&
    languageOf(report.path) === report.language
  )
}

function validReportContent(report: CcccFileReport): boolean {
  return (
    validReportNumbers(report) &&
    validFunctions(report.functions, report.lineCount) &&
    validParseErrors(report)
  )
}

export function safeCcccReports(
  reports: readonly CcccFileReport[],
  inputs: readonly CcccSourceInput[],
): CcccFileReport[] | undefined {
  const expected = new Set(inputs.map((input) => `${input.side}\0${input.path}`))
  const seen = new Set<string>()
  const safe: CcccFileReport[] = []
  for (const report of reports) {
    if (!validReport(report, expected, seen)) return undefined
    seen.add(`${report.side}\0${report.path}`)
    safe.push({
      side: report.side,
      path: safeRepositoryPath(report.path),
      language: report.language,
      lineCount: report.lineCount,
      cognitive: report.cognitive,
      cyclomatic: report.cyclomatic,
      functions: report.functions.map(safeFunctionReport),
      parseErrors: {
        count: report.parseErrors.count,
        lines: [...new Set(report.parseErrors.lines)].sort((a, b) => a - b),
      },
    })
  }
  if (safe.length !== inputs.length) return undefined
  return safe
}
