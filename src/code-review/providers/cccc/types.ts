export const CCCC_TOOL = "cccc"
export const CCCC_VERSION = "1.7.0"

export const CCCC_LANGUAGES = [
  "typescript",
  "javascript",
  "rust",
  "go",
  "php",
  "ruby",
  "scheme",
  "racket",
  "commonlisp",
  "emacslisp",
  "clojure",
  "kotlin",
  "python",
  "zig",
  "c",
  "cpp",
  "perl",
  "swift",
  "java",
  "dart",
  "scala",
] as const

export type CcccLanguage = (typeof CCCC_LANGUAGES)[number]
export type CcccSide = "base" | "head"
export type CcccFileStatus = "added" | "modified" | "removed" | "renamed" | "copied"

export interface CcccFunctionReport {
  name: string
  kind: string
  line: number
  cognitive: number
  cyclomatic: number
  children?: CcccFunctionReport[]
}

export interface CcccFileReport {
  side: CcccSide
  path: string
  language: CcccLanguage
  lineCount: number
  cognitive: number
  cyclomatic: number
  functions: CcccFunctionReport[]
  /** Parser messages are deliberately reduced to coordinates and a count. */
  parseErrors: { count: number; lines: number[] }
}

export interface CcccRawFunctionReport {
  name: string
  kind: string
  line: number
  cognitive: number
  cyclomatic: number
  children?: CcccRawFunctionReport[]
}

export interface CcccChangedFile {
  path: string
  previousPath?: string
  status: CcccFileStatus
  binary?: boolean
  /** 1-based changed head lines supplied by the immutable comparison. */
  changedLines?: readonly number[]
}

export interface CcccComparisonSnapshot {
  comparisonID: string
  baseRevision: string
  headRevision: string
  changedFiles: readonly CcccChangedFile[]
}

export interface CcccFunctionLocation {
  path: string
  line: number
  endLine: number
}

export interface CcccFunctionFinding {
  name: string
  kind: string
  location: CcccFunctionLocation
  base: CcccFunctionLocation
  cyclomatic: { base: number; head: number; delta: number }
  cognitive: { base: number; head: number; delta: number }
  severity: "info" | "warning"
  tier: "supporting" | "primary"
  complexityAxis: number
}

export interface CcccComparisonSummary {
  files: number
  functions: { base: number; head: number; delta: number }
  cyclomatic: { base: number; head: number; delta: number }
  cognitive: { base: number; head: number; delta: number }
  functionsIncreased: number
}

export type CcccFailureCode =
  | "comparison-unavailable"
  | "comparison-mismatch"
  | "invalid-snapshot"
  | "invalid-settings"
  | "worker-unavailable"
  | "worker-invalid-output"
  | "analysis-timeout"
  | "cancelled"
  | "stale-comparison"

export interface CcccProviderFailure {
  code: CcccFailureCode
  message: string
}

export interface CcccCoverage {
  supportedFiles: number
  analyzedFiles: number
  unsupportedFiles: number
  unavailableFiles: number
  unclassifiedFiles: number
  parseErrorFiles: number
  parseErrors: number
}

export interface CcccProviderResult {
  comparisonID: string
  revisions: { base: string; head: string }
  tool: { name: typeof CCCC_TOOL; version: typeof CCCC_VERSION }
  status: "complete" | "degraded" | "failed"
  coverage: CcccCoverage
  reports: CcccFileReport[]
  findings: CcccFunctionFinding[]
  summary: CcccComparisonSummary
  failure?: CcccProviderFailure
  issues: CcccProviderIssue[]
}

export interface CcccProviderIssue {
  code: "source-unavailable" | "unsupported-extension" | "changed-lines-unavailable"
  side?: CcccSide
  path: string
}

export interface CcccSettings {
  timeoutMs: number
  complexity: {
    cyclomatic: number
    cognitive: number
    primaryDelta: number
  }
}

export const DEFAULT_CCCC_SETTINGS: CcccSettings = {
  timeoutMs: 120_000,
  complexity: { cyclomatic: 20, cognitive: 15, primaryDelta: 5 },
}

export interface CcccSnapshotReader {
  /** Returns only immutable comparison metadata; source content is fetched separately by side. */
  readComparison(
    comparisonID: string,
    signal: AbortSignal,
  ): Promise<CcccComparisonSnapshot | undefined>
  /** The content must belong to this exact comparison ID, side, and repository-relative path. */
  readSource(
    comparisonID: string,
    side: CcccSide,
    path: string,
    signal: AbortSignal,
  ): Promise<string | undefined>
  /** Optional live-generation check. Results are discarded if a newer comparison replaced this one. */
  isCurrent?(comparisonID: string): boolean | Promise<boolean>
  /** Stable symbol identity when the host's captured index has one for this function location. */
  functionIdentity?(
    input: CcccFunctionIdentityInput,
  ): Promise<string | CcccFunctionIdentity | undefined>
}

export interface CcccFunctionIdentityInput {
  comparisonID: string
  side: CcccSide
  path: string
  line: number
  column: number
  signal: AbortSignal
}

export interface CcccFunctionIdentity {
  key: string
  /** Present only when this cccc function is the indexed symbol itself. */
  endLine?: number
}

export interface CcccProviderOptions {
  settings?: CcccSettings
  signal?: AbortSignal
  /** Test seam; runtime defaults to the provider-owned OpenCode worker. */
  analyzeSources?: CcccSourceAnalyzer
}

export interface CcccSourceInput {
  side: CcccSide
  path: string
  source: string
}

export interface CcccSourceAnalyzer {
  (
    files: readonly CcccSourceInput[],
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<CcccFileReport[]>
}
