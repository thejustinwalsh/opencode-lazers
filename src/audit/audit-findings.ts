import { DEAD_CODE_LISTS } from "./engine-audit.ts"
import type {
  EngineAudit,
  EngineCloneGroup,
  EngineComplexityFinding,
  EngineDiffRiskFinding,
} from "./engine-audit.ts"
import type { FallowFinding, FallowPackage } from "./contract.ts"

/**
 * Turns the engine's own `fallow audit` report (validated by `engine-audit.ts`) into the typed
 * `FallowPackage`. Nothing is re-derived: introduced, worsened or inherited, the gate severity
 * and the test-file exemption are the engine's. Duplication carries the engine's severity too
 * (an introduced clone group is a warning; only a duplication threshold makes it fail).
 */

import type { LineRange } from "./attribution.ts"
import { AHEAD_KINDS } from "./suppression-flow.ts"
export type { LineRange }

export type ClassifyContext = {
  thresholds: { cyclomatic: number; cognitive: number }
  /** `health.maxCrap` of the effective config, else Fallow's default. */
  maxCrap: number
  /** Workspace-relative changed files, used to anchor a clone on the file the change touched. */
  changed?: ReadonlySet<string>
  /** Added line ranges per file, to anchor a clone on a line the change wrote. */
  added?: ReadonlyMap<string, readonly LineRange[]>
  config: FallowPackage["config"]
  head?: string
}

const DEFAULT_MAX_CRAP = 30
export { DEFAULT_MAX_CRAP }
/** Inherited findings kept as context in the package; the summary counts every one. */
const INHERITED_LIMIT = 25

type Action = { type: string; comment?: string }
function suppressionOf(actions: readonly Action[] | undefined): FallowFinding["suppress"] {
  const comment = actions?.find((a) => a.type === "suppress-line")?.comment
  return comment ? { comment, requiresReason: true } : undefined
}

type Attribution = FallowFinding["attribution"]
type Severity = FallowFinding["severity"]

// --- complexity ---

function exceededMetrics(exceeded: string): Set<string> {
  const parts = new Set(exceeded.split("_"))
  if (parts.has("both") || parts.has("all")) {
    parts.add("cyclomatic")
    parts.add("cognitive")
  }
  if (parts.has("all")) parts.add("crap")
  return parts
}

type Measure = NonNullable<FallowFinding["measures"]>[number]

function complexityMeasures(finding: EngineComplexityFinding, context: ClassifyContext): Measure[] {
  const over = exceededMetrics(finding.exceeded)
  const before = (metric: Measure["metric"]) =>
    finding.worsened_metrics?.find((m) => m.metric === metric)?.base
  const measure = (metric: Measure["metric"], value: number, threshold: number): Measure => ({
    metric,
    value,
    threshold,
    ...(before(metric) !== undefined ? { baseValue: before(metric) } : {}),
  })
  const measures: Measure[] = []
  if (over.has("cognitive"))
    measures.push(measure("cognitive", finding.cognitive, context.thresholds.cognitive))
  if (over.has("cyclomatic"))
    measures.push(measure("cyclomatic", finding.cyclomatic, context.thresholds.cyclomatic))
  if (over.has("crap") && finding.crap !== undefined)
    measures.push(measure("crap", Math.round(finding.crap), context.maxCrap))
  return measures
}

function complexitySeverity(
  finding: EngineComplexityFinding,
  attribution: Attribution,
  worsenedMode: string,
): Severity {
  if (finding.gate_exemption === "test-file") return "warn"
  const severity = finding.effective_severity ?? "error"
  if (attribution === "worsened" && worsenedMode !== "error") return "warn"
  return severity
}

function complexityText(finding: FallowFinding): string {
  const measures = (finding.measures ?? [])
    .map(
      (m) =>
        `${m.metric} ${m.value} (limit ${m.threshold}${m.baseValue !== undefined ? `, was ${m.baseValue}` : ""})`,
    )
    .join(", ")
  return measures || "over a complexity limit"
}

function complexitySuggestion(finding: FallowFinding): string {
  if (finding.gateExemption === "test-file")
    return "Complexity in a test file never fails the audit; split a long test body if it hides what is checked."
  if (finding.estimatedCrap)
    return "The CRAP score is estimated from static test reachability; add a test that exercises it, or split it."
  if (finding.attribution === "worsened")
    return "It was already over a limit and grew. Split it, or at least do not add to it."
  return "Split it into smaller named functions."
}

function complexityFinding(
  finding: EngineComplexityFinding,
  attribution: Attribution,
  worsenedMode: string,
  context: ClassifyContext,
): FallowFinding {
  const severity = complexitySeverity(finding, attribution, worsenedMode)
  const measures = complexityMeasures(finding, context)
  const result: FallowFinding = {
    id: `complexity:complexity:${finding.path}:${finding.name}`,
    rule: "complexity",
    class: "complexity",
    severity,
    attribution,
    file: finding.path,
    line: finding.line,
    symbol: finding.name,
    message: "",
    ...(measures.length ? { measures } : {}),
    ...(finding.worsened_metrics?.length ? { worsenedMetrics: finding.worsened_metrics } : {}),
    ...(finding.gate_exemption ? { gateExemption: finding.gate_exemption } : {}),
    ...(severity === "warn" &&
    finding.coverage_source?.startsWith("estimated") &&
    exceededMetrics(finding.exceeded).has("crap") &&
    !exceededMetrics(finding.exceeded).has("cognitive") &&
    !exceededMetrics(finding.exceeded).has("cyclomatic")
      ? { estimatedCrap: true as const }
      : {}),
    ...(suppressionOf(finding.actions) ? { suppress: suppressionOf(finding.actions) } : {}),
  }
  result.message = complexityText(result)
  result.suggestion = complexitySuggestion(result)
  return result
}

// --- duplication ---

function overlaps(
  instance: { file: string; start_line: number; end_line: number },
  added: ReadonlyMap<string, readonly LineRange[]> | undefined,
): boolean {
  return (added?.get(instance.file) ?? []).some(
    (range) => range.startLine <= instance.end_line && range.endLine >= instance.start_line,
  )
}

/** The instance on a line the change wrote, else any in a changed file, else the first. */
function duplicationAnchor(group: EngineCloneGroup, context: ClassifyContext): number {
  const byAdded = group.instances.findIndex((i) => overlaps(i, context.added))
  if (byAdded >= 0) return byAdded
  const byChanged = group.instances.findIndex((i) => context.changed?.has(i.file))
  return byChanged >= 0 ? byChanged : 0
}

function duplicationFinding(
  group: EngineCloneGroup,
  attribution: Attribution,
  context: ClassifyContext,
): FallowFinding {
  const anchorIndex = duplicationAnchor(group, context)
  const anchor = group.instances[anchorIndex]!
  const others = group.instances.filter((_, index) => index !== anchorIndex)
  const lines = anchor.end_line - anchor.start_line + 1
  const files = [...new Set(group.instances.map((i) => i.file))].sort().join("+")
  return {
    id: `duplication:code-duplication:${anchor.file}:${files}`,
    rule: "code-duplication",
    class: "duplication",
    severity: "warn",
    attribution,
    file: anchor.file,
    line: anchor.start_line,
    endLine: anchor.end_line,
    message: `${lines} lines repeat ${others[0] ? `${others[0].file}:${others[0].start_line}-${others[0].end_line}` : "another location"}${others.length > 1 ? ` and ${others.length - 1} more` : ""}`,
    relatedLocations: others
      .slice(0, 3)
      .map((i) => ({ file: i.file, line: i.start_line, endLine: i.end_line })),
    suggestion: "Keep one implementation and import it instead of copying it.",
  }
}

// --- dead code, dependencies, cycles ---

type DeadCodeClass = {
  check: "dead-code" | "dependency" | "cycle"
  kind: string
  fix: string
  where: (finding: Record<string, unknown>) => { file: string; line: number; subject: string }
}

const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback
const num = (value: unknown, fallback = 1): number => (typeof value === "number" ? value : fallback)

function located(
  file: (f: Record<string, unknown>) => string,
  subject: (f: Record<string, unknown>) => string,
  line: (f: Record<string, unknown>) => number = (f) => num(f.line),
) {
  return (f: Record<string, unknown>) => ({ file: file(f), line: line(f), subject: subject(f) })
}

const MANIFEST_FIX_UNUSED =
  "Remove it from package.json, or import it where it is needed. Check scripts and config files first."

function dependency(kind: string, fix: string): DeadCodeClass {
  return {
    check: "dependency",
    kind,
    fix,
    where: located(
      (f) => text(f.path, "package.json"),
      (f) => `dependency \`${text(f.package_name)}\``,
    ),
  }
}

function unresolvedDependencySite(f: Record<string, unknown>) {
  const site = (f.imported_from as { path?: string; line?: number }[] | undefined)?.[0]
  return { file: site?.path ?? "package.json", line: site?.line ?? 1 }
}

/** A list the review handles without a bespoke message: the engine's own location and name fields. */
function generic(check: DeadCodeClass["check"], kind: string, fix: string): DeadCodeClass {
  return {
    check,
    kind,
    fix,
    where: (f) => {
      const files = f.files as string[] | undefined
      const site = (f.imported_from as { path?: string; line?: number }[] | undefined)?.[0]
      const named = [f.package_name, f.name, f.specifier, f.key, f.message, f.route, f.reason].find(
        (value) => typeof value === "string",
      )
      return {
        file: text(f.path ?? f.from_path ?? f.file ?? files?.[0] ?? site?.path, "package.json"),
        line: num(f.line ?? site?.line),
        subject: `${kind.replaceAll("-", " ")}${named ? ` \`${named}\`` : ""}`,
      }
    },
  }
}

/** Every dead-code finding list the audit reads, keyed by the engine's list name. */
export const DEAD_CODE_CLASSES: Record<string, DeadCodeClass> = {
  unused_files: {
    check: "dead-code",
    kind: "unused-file",
    fix: "Delete the file if it is not an entry point reached by configuration or a dynamic path.",
    where: located(
      (f) => text(f.path),
      (f) => `file \`${text(f.path)}\``,
      () => 1,
    ),
  },
  unused_exports: {
    check: "dead-code",
    kind: "unused-export",
    fix: "Remove the unused export only if the value is still used in the file, otherwise delete it.",
    where: located(
      (f) => text(f.path),
      (f) => `export \`${text(f.export_name)}\``,
    ),
  },
  unused_types: {
    check: "dead-code",
    kind: "unused-type",
    fix: "Remove the unused type if nothing else in the file still needs it.",
    where: located(
      (f) => text(f.path),
      (f) => `type \`${text(f.export_name)}\``,
    ),
  },
  private_type_leaks: {
    check: "dead-code",
    kind: "private-type-leak",
    fix: "Export the type the signature names, or stop exposing it in the public signature.",
    where: located(
      (f) => text(f.path),
      (f) => `\`${text(f.export_name)}\` exposes private type \`${text(f.type_name)}\``,
    ),
  },
  unused_enum_members: {
    check: "dead-code",
    kind: "unused-enum-member",
    fix: "Remove the enum member if nothing reads it.",
    where: located(
      (f) => text(f.path),
      (f) => `enum member \`${text(f.parent_name)}.${text(f.member_name)}\``,
    ),
  },
  unused_class_members: {
    check: "dead-code",
    kind: "unused-class-member",
    fix: "Remove the class member if nothing calls it.",
    where: located(
      (f) => text(f.path),
      (f) => `class member \`${text(f.parent_name)}.${text(f.member_name)}\``,
    ),
  },
  unresolved_imports: {
    check: "dead-code",
    kind: "unresolved-import",
    fix: "Fix the import path, or add the missing file or package.",
    where: located(
      (f) => text(f.path),
      (f) => `import \`${text(f.specifier)}\` does not resolve`,
    ),
  },
  duplicate_exports: {
    check: "dead-code",
    kind: "duplicate-export",
    fix: "Export the name from one file only, or rename one of them.",
    where: (f) => {
      const site = (f.locations as { path?: string; line?: number }[] | undefined)?.[0]
      return {
        file: site?.path ?? "",
        line: site?.line ?? 1,
        subject: `export \`${text(f.export_name)}\` is exported from several files`,
      }
    },
  },
  unused_dependencies: dependency("unused-dependency", MANIFEST_FIX_UNUSED),
  unused_dev_dependencies: dependency("unused-dev-dependency", MANIFEST_FIX_UNUSED),
  unused_optional_dependencies: dependency("unused-optional-dependency", MANIFEST_FIX_UNUSED),
  unlisted_dependencies: {
    check: "dependency",
    kind: "unlisted-dependency",
    fix: "Add it to the dependencies of the package.json that owns the import, or remove the import.",
    where: (f) => ({
      ...unresolvedDependencySite(f),
      subject: `dependency \`${text(f.package_name)}\` is imported but not declared`,
    }),
  },
  type_only_dependencies: dependency(
    "type-only-dependency",
    "Move it to devDependencies: only types are imported from it.",
  ),
  test_only_dependencies: dependency(
    "test-only-dependency",
    "Move it to devDependencies: only test files import it.",
  ),
  dev_dependencies_in_production: dependency(
    "dev-dependency-in-production",
    "Move it to dependencies: production code imports it.",
  ),
  circular_dependencies: {
    check: "cycle",
    kind: "circular-dependency",
    fix: "Break the cycle: move what the files share into a module that both import.",
    where: (f) => {
      const files = (f.files as string[] | undefined) ?? []
      return {
        file: files[0] ?? "",
        line: 1,
        subject: `${files.length} files import each other: ${files.join(", ")}`,
      }
    },
  },
  boundary_violations: {
    check: "dead-code",
    kind: "boundary-violation",
    fix: "Import through the allowed boundary, or move the code to the zone that may use it.",
    where: located(
      (f) => text(f.from_path),
      (f) => `import of \`${text(f.to_path)}\` crosses a configured boundary`,
    ),
  },
  unlisted_binaries: generic(
    "dependency",
    "unlisted-binary",
    "Declare the package that provides the binary, or stop running it.",
  ),
  re_export_cycles: generic("cycle", "re-export-cycle", "Break the re-export cycle."),
  package_cycles: generic("cycle", "package-cycle", "Break the cycle between workspace packages."),
  boundary_coverage_violations: generic(
    "cycle",
    "boundary-coverage-violation",
    "Put the file in a configured boundary zone.",
  ),
  boundary_call_violations: generic(
    "cycle",
    "boundary-call-violation",
    "Call through the allowed boundary.",
  ),
  policy_violations: generic(
    "cycle",
    "policy-violation",
    "Follow the rule pack that this finding names.",
  ),
  unused_catalog_entries: generic(
    "dependency",
    "unused-catalog-entry",
    "Remove the catalog entry nothing references.",
  ),
  empty_catalog_groups: generic(
    "dependency",
    "empty-catalog-group",
    "Remove the empty catalog group.",
  ),
  unresolved_catalog_references: generic(
    "dependency",
    "unresolved-catalog-reference",
    "Add the catalog entry, or reference an existing one.",
  ),
  unused_dependency_overrides: generic(
    "dependency",
    "unused-dependency-override",
    "Remove the override: nothing needs it.",
  ),
  misconfigured_dependency_overrides: generic(
    "dependency",
    "misconfigured-dependency-override",
    "Fix the override.",
  ),
  invalid_client_exports: generic(
    "dead-code",
    "invalid-client-export",
    "Export only what a client module may export.",
  ),
  mixed_client_server_barrels: generic(
    "dead-code",
    "mixed-client-server-barrel",
    "Split the barrel into client and server modules.",
  ),
  misplaced_directives: generic(
    "dead-code",
    "misplaced-directive",
    "Move the directive to the top of the file.",
  ),
  route_collisions: generic("dead-code", "route-collision", "Rename one of the colliding routes."),
  dynamic_segment_name_conflicts: generic(
    "dead-code",
    "dynamic-segment-name-conflict",
    "Rename the conflicting dynamic segment.",
  ),
  stale_suppressions: {
    check: "dead-code",
    kind: "stale-suppression",
    fix: "Remove the suppression comment: the code it covers is used or gone.",
    where: (f) => {
      const origin = (f.origin ?? {}) as { issue_kind?: string; reason?: string }
      return {
        file: text(f.path),
        line: num(f.line),
        subject: `suppression of ${origin.issue_kind ?? "a finding"}${origin.reason ? ` (reason: ${origin.reason})` : ""} suppresses nothing: the code it covers is used now`,
      }
    },
  },
}

const DEAD_CODE_RULE_CLASS: Record<string, FallowFinding["class"]> = {
  "dead-code": "dead-code",
  dependency: "dependency",
  cycle: "architecture",
}

function deadCodeFindings(deadCode: Record<string, unknown>): FallowFinding[] {
  const found: FallowFinding[] = []
  for (const list of DEAD_CODE_LISTS) {
    const descriptor = DEAD_CODE_CLASSES[list]
    const items = deadCode[list]
    if (!descriptor || !Array.isArray(items)) continue
    for (const item of items as (Record<string, unknown> & {
      introduced?: boolean
      effective_severity?: Severity
      actions?: Action[]
    })[]) {
      const where = descriptor.where(item)
      found.push({
        id: `${DEAD_CODE_RULE_CLASS[descriptor.check]}:${descriptor.kind}:${where.file}:${where.subject}`,
        rule: descriptor.kind,
        class: DEAD_CODE_RULE_CLASS[descriptor.check]!,
        severity: item.effective_severity ?? "error",
        attribution: item.introduced === true ? "introduced" : "inherited",
        file: where.file,
        line: where.line,
        message: where.subject,
        suggestion: descriptor.fix,
        ...(suppressionOf(item.actions) ? { suppress: suppressionOf(item.actions) } : {}),
      })
    }
  }
  return found
}

// --- diff-risk ---

const DIFF_RISK_FIX: Record<string, string> = {
  "weakened-tests:skip-only": "Remove the skip or focus marker, or fix the test so it can run.",
  "weakened-tests:removed-tests":
    "Restore the removed test cases, or move them; do not delete coverage.",
  "weakened-tests:assertion-drop": "Restore the assertions the change removed.",
  "weakened-tests:coverage-threshold": "Restore the threshold; fix the code instead of the bar.",
  "weakened-tests": "Restore the strictness the change removed.",
  "added-suppression": "Fix what the suppression hides instead of silencing it.",
  "test-only-branch":
    "Remove the test-environment branch from production code; inject the dependency instead.",
  "diverged-clone-sibling":
    "Apply the same edit to the sibling copies, or extract one shared implementation.",
  "added-dependency": "Confirm the dependency is needed; prefer what the project already uses.",
}

/** A reasoned suppression of unused code is the sanctioned way to add code ahead of its consumer. */
function suppressionSuggestion(finding: EngineDiffRiskFinding): string | undefined {
  const kinds = finding.suppression?.kinds ?? []
  if (finding.rule !== "added-suppression" || !kinds.some((kind) => AHEAD_KINDS.includes(kind)))
    return undefined
  return finding.suppression?.reason
    ? "Allowed for code added ahead of its consumer: the Architect checks the named consumer is queued. The consumer removes the comment."
    : "Add the reason naming the consumer: `-- consumed by <task reference>`; without one the Architect cannot judge it."
}

function diffRiskFinding(finding: EngineDiffRiskFinding): FallowFinding {
  const key = finding.kind ? `${finding.rule}:${finding.kind}` : finding.rule
  const related = (finding.related ?? []).slice(0, 3).map((r) => ({
    file: r.path,
    line: r.line ?? 1,
  }))
  const suppression = finding.suppression
  return {
    id: `diff-risk:${key}:${finding.path}:${finding.evidence}`,
    rule: key,
    class: "diff-risk",
    severity: finding.severity,
    attribution: "introduced",
    file: finding.path,
    line: finding.line ?? 1,
    message: finding.message,
    ...(related.length ? { relatedLocations: related } : {}),
    suggestion:
      suppressionSuggestion(finding) ??
      DIFF_RISK_FIX[key] ??
      DIFF_RISK_FIX[finding.rule] ??
      "Reverse the change or justify it.",
    ...(suppressionOf(finding.actions) ? { suppress: suppressionOf(finding.actions) } : {}),
    ...(suppression
      ? {
          suppression: {
            kinds: suppression.kinds,
            ...(suppression.reason ? { reason: suppression.reason } : {}),
          },
        }
      : {}),
  }
}

function stylingFinding(
  finding: {
    code?: string
    path?: string
    line?: number
    message?: string
    severity?: string
    introduced?: boolean
    internal?: { introduced?: boolean }
  },
  index: number,
): FallowFinding {
  const code = text(finding.code, "styling")
  const introduced = finding.introduced ?? finding.internal?.introduced
  return {
    id: `styling:${code}:${text(finding.path)}:${index}`,
    rule: code,
    class: "styling",
    severity: finding.severity === "error" ? "error" : "warn",
    attribution: introduced === true ? "introduced" : "inherited",
    file: text(finding.path, "."),
    line: num(finding.line),
    message: finding.message ?? code,
    suggestion: "Follow the project's styling rule that this finding names.",
  }
}

/** Gives repeated ids (same function name twice in a file) a stable occurrence suffix. */
function uniqueIds(findings: FallowFinding[]): FallowFinding[] {
  const seen = new Map<string, number>()
  return findings.map((finding) => {
    const count = (seen.get(finding.id) ?? 0) + 1
    seen.set(finding.id, count)
    return count === 1 ? finding : { ...finding, id: `${finding.id}#${count}` }
  })
}

const ATTRIBUTION_ORDER = { introduced: 0, worsened: 1, inherited: 2 } as const
function byRelevance(a: FallowFinding, b: FallowFinding): number {
  return (
    ATTRIBUTION_ORDER[a.attribution] - ATTRIBUTION_ORDER[b.attribution] ||
    (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) ||
    a.file.localeCompare(b.file) ||
    a.line - b.line ||
    a.id.localeCompare(b.id)
  )
}

function notChecked(report: EngineAudit): FallowPackage["config"]["classesNotChecked"] {
  const reasons: FallowPackage["config"]["classesNotChecked"] = []
  const skipped = (flag: boolean | undefined, name: string) =>
    flag
      ? reasons.push({
          class: name,
          reason: "the project's Fallow config turns the audit domain off",
        })
      : 0
  skipped(report.summary.dead_code_skipped, "dead-code, dependency and architecture")
  skipped(report.summary.complexity_skipped, "complexity and styling")
  skipped(report.summary.duplication_skipped, "duplication")
  return reasons
}

/**
 * The typed package of one audit: every finding the engine reported for the change, introduced
 * and worsened ones first, inherited ones as context (at most 25; the summary counts all).
 */
export function buildPackage(report: EngineAudit, context: ClassifyContext): FallowPackage {
  const worsenedMode = report.attribution.worsened
  const found: FallowFinding[] = []
  for (const finding of report.complexity?.findings ?? []) {
    const attribution = finding.attribution ?? (finding.introduced ? "introduced" : "inherited")
    found.push(complexityFinding(finding, attribution, worsenedMode, context))
  }
  for (const group of report.duplication?.clone_groups ?? []) {
    const introduced = group.introduced === true && !group.demotion_reason
    found.push(duplicationFinding(group, introduced ? "introduced" : "inherited", context))
  }
  if (report.dead_code) found.push(...deadCodeFindings(report.dead_code))
  for (const finding of report.diff_risk?.findings ?? [])
    if (finding.introduced) found.push(diffRiskFinding(finding))
  ;(report.complexity?.styling_findings ?? []).forEach((finding, index) =>
    found.push(stylingFinding(finding, index)),
  )
  const ordered = uniqueIds(found.sort(byRelevance))
  const live = ordered.filter((f) => f.attribution !== "inherited")
  const inherited = ordered.filter((f) => f.attribution === "inherited")
  return {
    verdict: report.verdict,
    base: report.base_ref,
    ...((context.head ?? report.head_sha) ? { head: context.head ?? report.head_sha } : {}),
    config: context.config,
    thresholds: context.thresholds,
    findings: [...live, ...inherited.slice(0, INHERITED_LIMIT)],
    summary: {
      errors: live.filter((f) => f.severity === "error").length,
      warnings: live.filter((f) => f.severity === "warn").length,
      inherited: inherited.length,
    },
    ...(report.base_snapshot_skipped ? { baseSnapshotSkipped: true as const } : {}),
    timings: { elapsedMs: report.elapsed_ms },
  }
}

export { notChecked }

/** True when the worker should get the package: the audit warns or fails on what the change did. */
export function needsRepair(pkg: FallowPackage | undefined): boolean {
  return (
    pkg !== undefined && pkg.verdict !== "pass" && pkg.summary.errors + pkg.summary.warnings > 0
  )
}

export const errorsOf = (pkg: FallowPackage) =>
  pkg.findings.filter((f) => f.attribution !== "inherited" && f.severity === "error")
export const warningsOf = (pkg: FallowPackage) =>
  pkg.findings.filter((f) => f.attribution !== "inherited" && f.severity === "warn")
export const contextOf = (pkg: FallowPackage) =>
  pkg.findings.filter((f) => f.attribution === "inherited")
