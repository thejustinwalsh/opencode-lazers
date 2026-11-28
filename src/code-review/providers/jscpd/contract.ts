export const JSCPD_DETECTOR_IDS = [
  "strict",
  "mild",
  "weak",
  "renamed",
  "gap",
  "ast",
  "cross-language",
] as const

export type JscpdDetector = (typeof JSCPD_DETECTOR_IDS)[number]

export const JSCPD_TOOL = {
  name: "jscpd",
  version: "5.4.0",
} as const

export interface JscpdDetectors {
  strict: boolean
  mild: boolean
  weak: boolean
  renamed: boolean
  gap: boolean
  ast: boolean
  crossLanguage: boolean
}

export interface DuplicationSettings {
  timeoutMs: number
  warningTokens: number
  detectors: JscpdDetectors
}

export const DEFAULT_DUPLICATION_SETTINGS: DuplicationSettings = {
  timeoutMs: 120_000,
  warningTokens: 150,
  detectors: {
    strict: true,
    mild: true,
    weak: true,
    renamed: true,
    gap: true,
    ast: true,
    crossLanguage: true,
  },
}

export interface JscpdFile {
  /** Relative path in the captured side inventory, using `/` separators. */
  path: string
  /** Captured source text. It is sent only to the worker and never returned in a finding. */
  source: string
  /** Optional jscpd format hint; otherwise inferred from the path or shebang. */
  format?: string
  /** Binary entries are omitted from analysis without decoding their bytes. */
  binary?: boolean
}

export interface JscpdConfig {
  mode?: "strict" | "mild" | "weak"
  ignoreCase?: boolean
  ignoreIdentifiers?: boolean
  ignoreLiterals?: boolean
  ignoreAnnotations?: boolean
  /** Native `.jscpd.json` `format` filter, normalized to format names. */
  formats?: readonly string[]
  /** Native `formatsExts` and `formatsNames` mappings. */
  formatsExts?: Readonly<Record<string, readonly string[]>>
  formatsNames?: Readonly<Record<string, readonly string[]>>
  /** CLI `-i` overrides `.jscpd.json` ignore in the Oaink invocation. */
  ignore?: readonly string[]
  /** Native `.jscpd.json` code-level regular expressions. */
  ignorePattern?: readonly string[]
  /** Compatibility spelling accepted by the provider contract. */
  codeIgnorePatterns?: readonly string[]
  /** Format equivalence groups, e.g. [["javascript", "typescript"]]. */
  crossFormats?: readonly (readonly string[])[]
  /** Native filesystem-walker options that can be evaluated from captured inputs. */
  maxLines?: number
  maxSize?: string
  maxGapLines?: number
  similarity?: number
  noGitignore?: boolean
  skipLocal?: boolean
  skipIsolated?: readonly (readonly string[])[]
  pattern?: string
}

export interface JscpdIgnoreFile {
  /** Relative path of `.ignore`, `.gitignore`, or `.git/info/exclude`. */
  path: string
  /** Captured ignore rules; kept in the worker and never returned. */
  contents: string
}

export interface JscpdSideInventory {
  files: readonly JscpdFile[]
  /** False when the captured list is known to omit files from this comparison side. */
  complete: boolean
  /** Additional omitted files known to the inventory provider. */
  omittedFiles?: number
  /** Side-specific `.jscpd.json` options captured with the source tree. */
  config?: JscpdConfig
  /** Captured ignore files used by the native walker. */
  ignoreFiles: readonly JscpdIgnoreFile[]
  /** False when the captured ignore-file list is known to be incomplete. */
  ignoreFilesComplete: boolean
  /** Native config keys not represented by the portable provider contract. */
  unsupportedConfig?: readonly string[]
}

export interface ChangedLineRange {
  path: string
  startLine: number
  endLine: number
}

export interface JscpdComparisonInput {
  /** Stable identity of the captured comparison that owns these side inventories. */
  comparisonID: string
  /** Full base-side source inventory, including unchanged files. */
  base: JscpdSideInventory
  /** Full head-side source inventory, including unchanged files. */
  head: JscpdSideInventory
  /** Head-side line ranges added or changed by this comparison. */
  changedLines: readonly ChangedLineRange[]
}

export interface CloneLocation {
  path: string
  startLine: number
  endLine: number
}

export interface ClonePair {
  fingerprint: string
  format: string
  kind: "exact" | "renamed" | "similar" | "gap" | string
  tokens: number
  lines: number
  first: CloneLocation
  second: CloneLocation
  similarity?: number
}

export interface DetectorReport {
  detector: JscpdDetector
  clones: readonly ClonePair[]
}

export interface ScanCoverage {
  filesReceived: number
  filesScanned: number
  filesUnsupported: number
  filesIgnored: number
}

export interface JscpdSideReport {
  detectors: readonly DetectorReport[]
  coverage: ScanCoverage
}

export interface InventoryCoverage extends ScanCoverage {
  complete: boolean
  omittedFiles: number
  ignoreFilesComplete: boolean
  unsupportedConfig: readonly string[]
}

export interface DuplicationCoverage {
  base: InventoryCoverage
  head: InventoryCoverage
  requestedDetectors: readonly JscpdDetector[]
  configurationChanged: boolean
}

export type DuplicationFailureCode =
  | "analyzer-unavailable"
  | "analyzer-memory"
  | "analyzer-timeout"
  | "invalid-request"
  | "worker-failed"

export interface DuplicationFailure {
  code: DuplicationFailureCode
  side: "base" | "head"
}

export type DuplicationComparisonResult =
  | {
      status: "complete" | "partial" | "disabled"
      comparisonID: string
      tool: typeof JSCPD_TOOL
      coverage: DuplicationCoverage
      findings: readonly DuplicationFinding[]
    }
  | {
      status: "unavailable"
      comparisonID: string
      tool: typeof JSCPD_TOOL
      coverage: DuplicationCoverage
      findings: readonly []
      failure: DuplicationFailure
    }

export type DuplicationInstance = CloneLocation

export interface DuplicationFinding {
  fingerprint: string
  detector: JscpdDetector
  detectors: readonly JscpdDetector[]
  instances: readonly DuplicationInstance[]
  introducedInstances: number
  baseInstances: number
  lines: number
  tokens: number
  severity: "warning" | "info"
  provenance: "exact" | "heuristic"
  kind: string
  similarity?: number
  configurationChanged: boolean
}

export interface WasmScanRequest {
  files: readonly JscpdFile[]
  ignoreFiles: readonly JscpdIgnoreFile[]
  detectors: readonly JscpdDetector[]
  minTokens: number
  minLines: number
  config: JscpdConfig
}
