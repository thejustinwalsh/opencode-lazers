export const GITLEAKS_PROVIDER_ID = "gitleaks" as const
export const GITLEAKS_TOOL = "gitleaks" as const
export const GITLEAKS_VERSION = "8.30.1" as const

export type GitleaksSide = "base" | "head"
export type GitleaksFileStatus = "added" | "modified" | "removed" | "renamed"

export interface GitleaksChangedFile {
  path: string
  previousPath?: string
  status: GitleaksFileStatus
  binary?: boolean
}

export interface GitleaksLineRange {
  startLine: number
  endLine: number
}

export type GitleaksSourceRead =
  | { status: "present"; content: string }
  | { status: "absent" }
  | { status: "unavailable"; code?: string }

/**
 * An immutable, comparison-scoped reader. `read` must return only captured snapshot content;
 * it must not resolve a physical worktree path or fall back to a live filesystem read.
 */
export interface GitleaksComparisonReader {
  readonly comparisonID: string
  readonly baseRevision: string
  readonly headRevision: string
  readonly changedFiles: readonly GitleaksChangedFile[]
  readonly changedLines: {
    readonly status: "complete" | "unavailable"
    readonly ranges: readonly {
      path: string
      ranges: readonly GitleaksLineRange[]
    }[]
  }
  read(side: GitleaksSide, path: string, signal: AbortSignal): Promise<GitleaksSourceRead>
  isCurrent?(comparisonID: string): boolean | Promise<boolean>
}

export interface GitleaksResultIdentity {
  comparisonID: string
  baseRevision: string
  headRevision: string
}

export interface GitleaksSettings {
  /** Gitleaks does not inspect a captured file larger than this many UTF-8 bytes. */
  maxFileBytes: number
  /** Bounds the captured source/config payload sent to one WASM run. */
  maxInputBytes: number
  /** Cancels the isolated provider worker after this many milliseconds. */
  timeoutMs: number
}

export const DEFAULT_GITLEAKS_SETTINGS: Readonly<GitleaksSettings> = {
  maxFileBytes: 2_000_000,
  maxInputBytes: 16_000_000,
  timeoutMs: 120_000,
}

export type GitleaksFailureCode =
  | "cancelled"
  | "input-invalid"
  | "source-unavailable"
  | "config-unavailable"
  | "config-too-large"
  | "input-too-large"
  | "timeout"
  | "worker-failed"
  | "worker-exit"
  | "wasm-unavailable"
  | "wasi-trap"
  | "memory-exhausted"
  | "invalid-config"
  | "invalid-output"
  | "detector-failed"
  | "worker-cleanup-failed"

export type GitleaksSkipReason =
  | "binary"
  | "file-too-large"
  | "input-byte-limit"
  | "source-unavailable"
  | "change-ranges-unavailable"

export interface GitleaksSkippedInput {
  side: GitleaksSide | "comparison"
  /** Internal preparation detail; public results omit unverified paths. */
  path?: string
  reason: GitleaksSkipReason
}

export interface GitleaksCoverage {
  status: "complete" | "degraded"
  scannedFiles: { side: GitleaksSide; path: string }[]
  skipped: GitleaksSkippedInput[]
  changes: "complete" | "unavailable"
}

export interface GitleaksLocation {
  side: "head"
  path: string
  range: {
    startLine: number
    startCol: number
    endLine: number
    endCol: number
  }
  prPosition: { path: string; line: number; side: "RIGHT" }
}

export interface GitleaksIntroducedFinding {
  kind: "secret.introduced"
  severity: "error"
  provenance: "heuristic"
  location: GitleaksLocation
  rule: string
  description: string
  masked: string
  /** Per-comparison HMAC token; its random key is never returned or persisted. */
  fingerprint: string
  entropy?: number
  summary: string
  evidence: string
}

export interface GitleaksUnclassifiedFinding {
  kind: "secret.unclassified"
  location: GitleaksLocation
  rule: string
  description: string
  masked: string
  fingerprint: string
  entropy?: number
  reason: "incomplete-snapshot"
}

export interface GitleaksInlineAllow {
  kind: "secret.allow.inline"
  location: GitleaksLocation
  matches: { rule: string; masked: string; fingerprint: string }[]
  leftOut: number | null
  exact: boolean
  severity: "error" | "info" | "unknown"
  provenance: "heuristic" | "exact"
  summary: string
  evidence: string
}

export interface GitleaksAllowlistChange {
  kind: "secret.allowlist.changed"
  location: {
    side: "base" | "head"
    path: string
    range?: { startLine: number; startCol: number; endLine: number; endCol: number }
    prPosition: { path: string; line?: number; file?: true; side?: "RIGHT" }
  }
  files: { path: string; change: "added" | "modified" | "removed" }[]
  added: string[]
  totalAdded: number
  leftOut: number
  exact: boolean
  severity: "error" | "warning" | "unknown"
  summary: string
  evidence: string
}

export interface GitleaksResult {
  provider: typeof GITLEAKS_PROVIDER_ID
  tool: { id: typeof GITLEAKS_TOOL; version: typeof GITLEAKS_VERSION }
  identity: GitleaksResultIdentity
  status: "complete" | "degraded" | "failed" | "cancelled" | "stale"
  coverage: GitleaksCoverage
  findings: GitleaksIntroducedFinding[]
  unclassified: GitleaksUnclassifiedFinding[]
  inlineAllow: GitleaksInlineAllow[]
  allowlistChange?: GitleaksAllowlistChange
  failure?: { code: GitleaksFailureCode }
}
