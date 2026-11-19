/**
 * Report shapes of the Fallow analysis, as the WebAssembly module emits them. They are the
 * subset of `@fallow-cli/fallow-node` 3.43.2's typings that LAZERS reads, copied here so the
 * runtime and `bun check` need no native package. The native package stays a dev dependency
 * only for the parity tests.
 */

export interface AnalysisAction {
  type?: string
  auto_fixable?: boolean
  description?: string
  comment?: string
  note?: string
  [key: string]: unknown
}

export interface DeadCodeSummary {
  absent_component_props: number
  constant_parameters?: number
  total_issues: number
  unused_files: number
  unused_exports: number
  unused_types: number
  private_type_leaks: number
  deprecated_exports_in_use: number
  unused_dependencies: number
  unused_enum_members: number
  unused_class_members: number
  unresolved_imports: number
  unlisted_dependencies: number
  duplicate_exports: number
  type_only_dependencies: number
  test_only_dependencies: number
  dev_dependencies_in_production: number
  circular_dependencies: number
  boundary_violations: number
  stale_suppressions: number
}

export interface EntryPointSummary {
  total: number
  sources: Record<string, number>
}

export interface UnusedFileFinding {
  path: string
  actions?: AnalysisAction[]
  [key: string]: unknown
}

export interface UnusedExportFinding {
  path: string
  export_name: string
  line: number
  col: number
  deprecated?: boolean
  deprecated_reason?: string
  actions?: AnalysisAction[]
  [key: string]: unknown
}

export interface PrivateTypeLeakFinding {
  path: string
  export_name: string
  type_name: string
  line: number
  col: number
  span_start?: number
  actions?: AnalysisAction[]
  [key: string]: unknown
}

export interface DeprecatedExportConsumer {
  path: string
  line: number
  col: number
  kind: string
  [key: string]: unknown
}

export interface DeprecatedExportInUseFinding {
  path: string
  export_name: string
  line: number
  col: number
  deprecated_reason?: string
  consumer_count: number
  consumers: DeprecatedExportConsumer[]
  public_api: boolean
  actions?: AnalysisAction[]
  [key: string]: unknown
}

export interface UnusedDependencyFinding {
  path: string
  package_name: string
  line: number
  col: number
  used_in_workspaces?: string[]
  declared_and_imported_in?: string[]
  actions?: AnalysisAction[]
  [key: string]: unknown
}

export interface UnusedMemberFinding {
  path: string
  parent_name: string
  member_name: string
  line: number
  col: number
  actions?: AnalysisAction[]
  [key: string]: unknown
}

export interface UnresolvedImportFinding {
  path: string
  specifier: string
  line: number
  col: number
  actions?: AnalysisAction[]
  [key: string]: unknown
}

export interface UnlistedDependencyFinding {
  package_name: string
  imported_from: Array<{ path: string; line: number; [key: string]: unknown }>
  actions?: AnalysisAction[]
  [key: string]: unknown
}

export interface DuplicateExportFinding {
  export_name: string
  locations: Array<{ path: string; line: number; [key: string]: unknown }>
  actions?: AnalysisAction[]
  [key: string]: unknown
}

export interface TypeOnlyDependencyFinding {
  path: string
  package_name: string
  line: number
  col: number
  actions?: AnalysisAction[]
  [key: string]: unknown
}

export interface TestOnlyDependencyFinding {
  path: string
  package_name: string
  line: number
  col: number
  actions?: AnalysisAction[]
  [key: string]: unknown
}

export interface DevDependencyInProductionFinding {
  path: string
  package_name: string
  line: number
  actions?: AnalysisAction[]
  [key: string]: unknown
}

export interface CircularDependencyFinding {
  files: string[]
  length: number
  actions?: AnalysisAction[]
  [key: string]: unknown
}

export interface BoundaryViolationFinding {
  from_path: string
  to_path: string
  line: number
  col: number
  from_zone?: string
  to_zone?: string
  actions?: AnalysisAction[]
  [key: string]: unknown
}

export interface StaleSuppressionFinding {
  path: string
  line: number
  col: number
  issue_kind?: string
  actions?: AnalysisAction[]
  [key: string]: unknown
}

/** An optional prop review candidate. Static caller evidence does not prove runtime unreachability. */
export interface AbsentComponentPropFinding {
  path: string
  component_name: string
  prop_name: string
  framework: string
  line: number
  col: number
  has_default: boolean
  inspected_call_sites: Array<{ path: string; line: number; col: number }>
  explanation: string
  finding_id?: string
  actions: AnalysisAction[]
  effective_severity?: "warn" | "error"
}

/** A parameter that each visible call passes in one way. Static call evidence does not prove that no caller outside the project exists. */
export interface ConstantParameterFinding {
  path: string
  function_name: string
  parameter_name: string
  parameter_index: number
  option_key?: string
  line: number
  col: number
  reason: "identical-argument" | "never-passed" | "unused-default"
  evidence?: "type-aware"
  value?: { kind: "boolean" | "null" | "undefined" | "number" | "string" | "binding"; text: string }
  optional: boolean
  has_default: boolean
  condition_reads: number
  call_site_count: number
  inspected_call_sites: Array<{ path: string; line: number; col: number }>
  explanation: string
  finding_id?: string
  actions: AnalysisAction[]
  effective_severity?: "warn" | "error"
}

export interface DeadCodeReport {
  schema_version: number
  version: string
  elapsed_ms: number
  total_issues: number
  summary: DeadCodeSummary
  absent_component_props?: AbsentComponentPropFinding[]
  constant_parameters?: ConstantParameterFinding[]
  entry_points?: EntryPointSummary
  unused_files: UnusedFileFinding[]
  unused_exports: UnusedExportFinding[]
  unused_types: UnusedExportFinding[]
  private_type_leaks: PrivateTypeLeakFinding[]
  deprecated_exports_in_use?: DeprecatedExportInUseFinding[]
  unused_dependencies: UnusedDependencyFinding[]
  unused_dev_dependencies: UnusedDependencyFinding[]
  unused_optional_dependencies: UnusedDependencyFinding[]
  unused_enum_members: UnusedMemberFinding[]
  unused_class_members: UnusedMemberFinding[]
  unresolved_imports: UnresolvedImportFinding[]
  unlisted_dependencies: UnlistedDependencyFinding[]
  duplicate_exports: DuplicateExportFinding[]
  type_only_dependencies: TypeOnlyDependencyFinding[]
  test_only_dependencies: TestOnlyDependencyFinding[]
  dev_dependencies_in_production: DevDependencyInProductionFinding[]
  circular_dependencies: CircularDependencyFinding[]
  boundary_violations: BoundaryViolationFinding[]
  stale_suppressions: StaleSuppressionFinding[]
  _meta?: Record<string, unknown>
}

export interface CloneInstance {
  file: string
  start_line: number
  end_line: number
  start_col: number
  end_col: number
  fragment?: string
  [key: string]: unknown
}

export interface CloneGroup {
  instances: CloneInstance[]
  token_count: number
  line_count: number
  spread: number
  similarity?: number
  actions?: AnalysisAction[]
  [key: string]: unknown
}

export interface DuplicationStats {
  total_files: number
  files_with_clones: number
  total_lines: number
  duplicated_lines: number
  total_tokens: number
  duplicated_tokens: number
  clone_groups: number
  clone_instances: number
  duplication_percentage: number
  clone_groups_ignored?: number
  near_candidates_skipped?: number
}

export interface DuplicationReport {
  schema_version: number
  version: string
  elapsed_ms: number
  clone_groups: CloneGroup[]
  clone_families?: Record<string, unknown>[]
  mirrored_directories?: Record<string, unknown>[]
  stats: DuplicationStats
  _meta?: Record<string, unknown>
}

export interface HealthFinding {
  path: string
  name: string
  line: number
  col: number
  cyclomatic: number
  cognitive: number
  line_count: number
  param_count: number
  exceeded: string
  severity: string
  crap?: number
  coverage_pct?: number
  actions?: AnalysisAction[]
  [key: string]: unknown
}

export interface FileHealthScore {
  path: string
  fan_in: number
  fan_out: number
  dead_code_ratio: number
  complexity_density: number
  maintainability_index: number
  total_cyclomatic: number
  total_cognitive: number
  function_count: number
  lines: number
  crap_max: number
  crap_above_threshold: number
  crap_exempted?: number
  /** Scored functions accepted by a complexity suppression, independent of configured exemptions. */
  crap_suppressed?: number
  /** Remaining maximum and ceiling are supplied together; an incomplete pair uses the legacy metrics. */
  crap_unsuppressed_max?: number
  crap_unsuppressed_effective_threshold?: number
  crap_effective_threshold?: number
  [key: string]: unknown
}

export interface CoverageGaps {
  summary: {
    runtime_files: number
    covered_files: number
    file_coverage_pct: number
    untested_files: number
    untested_exports: number
  }
  files?: Array<{ path: string; value_export_count: number; [key: string]: unknown }>
  exports?: Array<{
    path: string
    export_name: string
    line: number
    col: number
    [key: string]: unknown
  }>
}

export interface RefactoringTarget {
  path: string
  priority: number
  efficiency: number
  recommendation: string
  category: string
  effort: string
  confidence: string
  factors?: Array<Record<string, unknown>>
  evidence?: Record<string, unknown>
  [key: string]: unknown
}

export interface HotspotEntry {
  path: string
  score: number
  commits: number
  /** Median analyzed files per commit that changed this file. Absent without commit ids. */
  median_files_per_commit?: number
  /** Median changed lines per commit that changed this file. Absent without commit ids. */
  median_lines_per_commit?: number
  [key: string]: unknown
}

export interface HiddenCouplingPair {
  path_a: string
  path_b: string
  revisions_a: number
  revisions_b: number
  shared_revisions: number
  /** Coupling degree from 0 to 1. */
  degree: number
  /** Present and true when `degree` reaches `thresholds.strong_degree`. */
  strong?: boolean
}

export interface ChangeCouplingReport {
  since: string
  commits_analyzed: number
  commits_skipped: number
  total_pairs: number
  thresholds: {
    max_files_per_commit: number
    min_revisions: number
    min_shared_revisions: number
    min_degree: number
    strong_degree: number
  }
  pairs: HiddenCouplingPair[]
}

export interface HealthReport {
  schema_version: number
  version: string
  elapsed_ms: number
  findings: HealthFinding[]
  summary: Record<string, unknown>
  vital_signs?: Record<string, unknown>
  health_score?: Record<string, unknown>
  file_scores?: FileHealthScore[]
  coverage_gaps?: CoverageGaps
  hotspots?: HotspotEntry[]
  hotspot_summary?: Record<string, unknown>
  /** Hidden change coupling. Present when the hotspots section ran and the run read the commit history. */
  change_coupling?: ChangeCouplingReport
  runtime_coverage?: Record<string, unknown>
  large_functions?: Array<Record<string, unknown>>
  targets?: RefactoringTarget[]
  target_thresholds?: Record<string, unknown>
  health_trend?: Record<string, unknown>
  _meta?: Record<string, unknown>
}
