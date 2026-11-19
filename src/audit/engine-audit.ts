import { z } from "zod"

/**
 * The JSON of the engine's own `fallow audit` (schema 14, Fallow 3.43.2), as the WebAssembly
 * module emits it, validated at the boundary. The fields and enums LAZERS reads are strict: a
 * new field or enum value in a re-pinned engine fails `parseEngineAudit` (and its test) instead
 * of being dropped. Bulk the review never reads (summaries, vital signs, CSS analytics) is kept
 * as unknown.
 */

const Severity = z.enum(["error", "warn"])
const Verdict = z.enum(["pass", "warn", "fail"])
const WorsenedKind = z.enum(["cyclomatic", "cognitive", "crap", "line_count"])
const Exceeded = z.enum([
  "cyclomatic",
  "cognitive",
  "both",
  "crap",
  "cyclomatic_crap",
  "cognitive_crap",
  "all",
  "file_lines",
])
const Action = z.looseObject({
  type: z.string(),
  auto_fixable: z.boolean().optional(),
  description: z.string().optional(),
  comment: z.string().optional(),
})
const Actions = z.array(Action).optional()

export const EngineComplexityFinding = z.strictObject({
  path: z.string(),
  name: z.string(),
  line: z.int(),
  col: z.int(),
  cyclomatic: z.int(),
  standard_cyclomatic: z.int().optional(),
  cognitive: z.int(),
  line_count: z.int(),
  param_count: z.int(),
  react_hook_count: z.int().optional(),
  react_jsx_max_depth: z.int().optional(),
  react_prop_count: z.int().optional(),
  react_hook_profile: z.unknown().optional(),
  exceeded: Exceeded,
  severity: z.enum(["moderate", "high", "critical"]),
  effective_severity: Severity.optional(),
  crap: z.number().optional(),
  mutation: z.unknown().optional(),
  coverage_pct: z.number().optional(),
  coverage_tier: z.string().optional(),
  coverage_source: z.enum(["istanbul", "estimated", "estimated_component_inherited"]).optional(),
  inherited_from: z.string().optional(),
  component_rollup: z.unknown().optional(),
  contributions: z.array(z.unknown()).optional(),
  effective_thresholds: z.unknown().optional(),
  threshold_source: z.unknown().optional(),
  max_file_lines: z.int().optional(),
  actions: Actions,
  introduced: z.boolean().optional(),
  attribution: z.enum(["introduced", "worsened", "inherited"]).optional(),
  worsened_metrics: z
    .array(z.strictObject({ metric: WorsenedKind, base: z.number(), head: z.number() }))
    .optional(),
  gate_exemption: z.literal("test-file").optional(),
})

export const EngineCloneGroup = z.strictObject({
  instances: z.array(z.looseObject({ file: z.string(), start_line: z.int(), end_line: z.int() })),
  token_count: z.int(),
  line_count: z.int(),
  spread: z.int().optional(),
  similarity: z.number().optional(),
  fingerprint: z.string().optional(),
  suggested_name: z.string().optional(),
  actions: Actions,
  introduced: z.boolean().optional(),
  demotion_reason: z.literal("no-added-lines").optional(),
})

export const EngineDiffRiskFinding = z.strictObject({
  rule: z.enum([
    "weakened-tests",
    "added-suppression",
    "test-only-branch",
    "diverged-clone-sibling",
    "added-dependency",
  ]),
  kind: z.enum(["skip-only", "removed-tests", "assertion-drop", "coverage-threshold"]).optional(),
  path: z.string(),
  line: z.int().optional(),
  message: z.string(),
  evidence: z.string(),
  severity: Severity,
  introduced: z.boolean(),
  related: z.array(z.looseObject({ path: z.string(), line: z.int().optional() })).optional(),
  actions: Actions,
  suppression: z
    .strictObject({
      kinds: z.array(z.string()),
      reason: z.string().nullable(),
      security_without_reason: z.boolean(),
    })
    .optional(),
})

/** Dead-code finding lists the review turns into findings. */
export const DEAD_CODE_LISTS = [
  "unused_files",
  "unused_exports",
  "unused_types",
  "private_type_leaks",
  "unused_enum_members",
  "unused_class_members",
  "unresolved_imports",
  "duplicate_exports",
  "unused_dependencies",
  "unused_dev_dependencies",
  "unused_optional_dependencies",
  "unlisted_dependencies",
  "type_only_dependencies",
  "test_only_dependencies",
  "dev_dependencies_in_production",
  "circular_dependencies",
  "boundary_violations",
  "stale_suppressions",
  "unlisted_binaries",
  "re_export_cycles",
  "package_cycles",
  "boundary_coverage_violations",
  "boundary_call_violations",
  "policy_violations",
  "unused_catalog_entries",
  "empty_catalog_groups",
  "unresolved_catalog_references",
  "unused_dependency_overrides",
  "misconfigured_dependency_overrides",
  "invalid_client_exports",
  "mixed_client_server_barrels",
  "misplaced_directives",
  "route_collisions",
  "dynamic_segment_name_conflicts",
] as const

/** Lists the audit carries that are advisory evidence, not gated findings. */
const ADVISORY_LISTS = new Set([
  "deprecated_exports_in_use",
  "absent_component_props",
  "constant_parameters",
  "workspace_diagnostics",
])

const DeadCodeItem = z.looseObject({
  introduced: z.boolean().optional(),
  effective_severity: Severity.optional(),
  actions: Actions,
})

export const EngineDeadCode = z
  .looseObject(
    Object.fromEntries(DEAD_CODE_LISTS.map((name) => [name, z.array(DeadCodeItem).optional()])),
  )
  .superRefine((value, ctx) => {
    // A list this review does not know would be silently ignored: fail instead.
    for (const [key, entry] of Object.entries(value)) {
      const isList = Array.isArray(entry) && (entry.length === 0 || typeof entry[0] === "object")
      if (
        isList &&
        !(DEAD_CODE_LISTS as readonly string[]).includes(key) &&
        !ADVISORY_LISTS.has(key)
      )
        ctx.addIssue({ code: "custom", message: `unknown dead-code finding list \`${key}\`` })
    }
  })

export const EngineStylingFinding = z.looseObject({
  code: z.string().optional(),
  path: z.string().optional(),
  line: z.int().optional(),
  message: z.string().optional(),
  severity: z.string().optional(),
  introduced: z.boolean().optional(),
  internal: z.looseObject({ introduced: z.boolean().optional() }).optional(),
})

const Attribution = z.strictObject({
  gate: z.enum(["new-only", "all"]),
  worsened: z.enum(["warn", "error", "off"]),
  dead_code_introduced: z.int(),
  dead_code_inherited: z.int(),
  complexity_introduced: z.int(),
  complexity_inherited: z.int(),
  complexity_worsened: z.int(),
  duplication_introduced: z.int(),
  duplication_inherited: z.int(),
  styling_introduced: z.int(),
  styling_inherited: z.int(),
  duplication_demoted: z.int(),
  diff_risk_introduced: z.int(),
})

export const EngineAudit = z.strictObject({
  kind: z.literal("audit"),
  schema_version: z.int(),
  version: z.string(),
  command: z.literal("audit"),
  verdict: Verdict,
  changed_files_count: z.int(),
  base_ref: z.string(),
  base_description: z.string().optional(),
  head_sha: z.string().optional(),
  elapsed_ms: z.int(),
  base_snapshot_skipped: z.boolean().optional(),
  summary: z.strictObject({
    dead_code_issues: z.int(),
    dead_code_has_errors: z.boolean(),
    dead_code_skipped: z.boolean().optional(),
    complexity_skipped: z.boolean().optional(),
    duplication_skipped: z.boolean().optional(),
    complexity_findings: z.int(),
    max_cyclomatic: z.int().nullable(),
    duplication_clone_groups: z.int(),
  }),
  attribution: Attribution,
  gate_outcomes: z.unknown().optional(),
  dead_code: EngineDeadCode.optional(),
  duplication: z
    .looseObject({ clone_groups: z.array(EngineCloneGroup), stats: z.unknown().optional() })
    .optional(),
  complexity: z
    .looseObject({
      findings: z.array(EngineComplexityFinding),
      styling_findings: z.array(EngineStylingFinding).optional(),
    })
    .optional(),
  diff_risk: z.strictObject({ findings: z.array(EngineDiffRiskFinding) }).optional(),
  next_steps: z.array(z.unknown()).optional(),
})
export type EngineAudit = z.infer<typeof EngineAudit>
export type EngineComplexityFinding = z.infer<typeof EngineComplexityFinding>
export type EngineCloneGroup = z.infer<typeof EngineCloneGroup>
export type EngineDiffRiskFinding = z.infer<typeof EngineDiffRiskFinding>
export type EngineDeadCodeItem = z.infer<typeof DeadCodeItem> & Record<string, unknown>

/** Validates the engine's audit JSON. Throws a message naming the first field that does not fit. */
export function parseEngineAudit(value: unknown): EngineAudit {
  const parsed = EngineAudit.safeParse(value)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  throw new Error(
    `analyzer-schema: the audit report does not match the expected schema at ${issue?.path.join(".") || "<root>"}: ${issue?.message}`,
  )
}
