import type { DeadCodeReport, DuplicationReport, HealthReport } from "@fallow-cli/fallow-node"
import type { TaskRepository } from "../storage.ts"
import {
  attributeComplexity,
  attributeDeadCode,
  attributeDuplication,
  type ComplexityAttribution,
  type ComplexityPoint,
  type DeadCodeKey,
  type DuplicationInstance,
  type LineRange,
} from "./attribution.ts"
import { nativeFallowAnalyzer, type FallowAnalyzer } from "./analyzer.ts"
import {
  cleanupResolvedFallowConfig,
  resolveFallowConfig,
  thresholdsFrom,
  type ResolvedFallowConfig,
} from "./config.ts"
import { addedRangesForFiles, changedAnalysableFiles, materialiseBaseTree } from "./review-git.ts"

const TIMEOUT_MS = 60_000

export type Finding = {
  id: string
  check: "duplication" | "complexity" | "dead-code" | "cycle"
  status: "introduced" | "worsened"
  file: string
  line: number
  endLine?: number
  subject: string
  measured?: number
  limit?: number
  before?: number
  others?: { file: string; line: number; endLine: number }[]
  fix: string
}

export type FallowReviewResult = {
  status: "clean" | "findings" | "unavailable"
  introduced: Finding[]
  concerns: Finding[]
  thresholds: { cyclomatic: number; cognitive: number }
  configSource: "repo" | "lazers" | "defaults"
  reason?: string
}

export type FallowReviewInput = {
  workspace: string
  baseCommit: string
  artifact: string
  repository: TaskRepository
  analyzer?: FallowAnalyzer
  signal?: AbortSignal
}

async function withTimeout<T>(run: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: analyzer call exceeded ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([run(), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function toComplexityPoints(report: HealthReport): ComplexityPoint[] {
  return report.findings.map((f) => ({
    path: f.path,
    name: f.name,
    cyclomatic: f.cyclomatic,
    cognitive: f.cognitive,
    line: f.line,
  }))
}

function complexityFinding(
  attr: ComplexityAttribution,
  thresholds: { cyclomatic: number; cognitive: number },
): Finding {
  const useCognitive = attr.cognitive > thresholds.cognitive
  const measured = useCognitive ? attr.cognitive : attr.cyclomatic
  const limit = useCognitive ? thresholds.cognitive : thresholds.cyclomatic
  const before = attr.before
    ? useCognitive
      ? attr.before.cognitive
      : attr.before.cyclomatic
    : undefined
  const metric = useCognitive ? "cognitive" : "cyclomatic"
  return {
    id: `complexity:${attr.path}:${attr.line ?? 0}:${attr.name}`,
    check: "complexity",
    status: attr.status,
    file: attr.path,
    line: attr.line ?? 0,
    subject: attr.name,
    measured,
    limit,
    before,
    fix: `Split \`${attr.name}\` into smaller functions; it is ${metric} ${measured} against a limit of ${limit}.`,
  }
}

function duplicationInstanceSummary(instance: DuplicationInstance) {
  return { file: instance.file, line: instance.startLine, endLine: instance.endLine }
}

function duplicationFinding(instances: readonly DuplicationInstance[], tokens: number): Finding {
  const [first, ...rest] = instances
  const lines = first!.endLine - first!.startLine + 1
  return {
    id: `duplication:${first!.file}:${first!.startLine}`,
    check: "duplication",
    status: "introduced",
    file: first!.file,
    line: first!.startLine,
    endLine: first!.endLine,
    subject: `${lines} lines, ${tokens} tokens`,
    measured: tokens,
    others: rest.slice(0, 3).map(duplicationInstanceSummary),
    fix: "Keep one implementation and import it in both places instead of duplicating it.",
  }
}

function duplicationGroupKey(instances: readonly DuplicationInstance[]): string {
  return instances.map((i) => `${i.file}:${i.startLine}:${i.endLine}`).join("|")
}

function newDuplicationFindings(
  report: DuplicationReport,
  addedRanges: ReadonlyMap<string, readonly LineRange[]>,
): Finding[] {
  const groups = report.clone_groups.map((group) => ({
    tokens: group.token_count,
    instances: group.instances.map((i) => ({
      file: i.file,
      startLine: i.start_line,
      endLine: i.end_line,
    })),
  }))
  const introducedKeys = new Set(
    attributeDuplication(groups, addedRanges).map((g) => duplicationGroupKey(g.instances)),
  )
  return groups
    .filter((g) => introducedKeys.has(duplicationGroupKey(g.instances)))
    .map((g) => duplicationFinding(g.instances, g.tokens))
}

const DEAD_CODE_FIX: Record<string, string> = {
  export:
    "Remove the unused export only if the value is still used in the file, otherwise delete it.",
  type: "Remove the unused type if nothing else in the file still needs it.",
  file: "Delete the file if it is not an entry point reached by configuration or a dynamic path.",
}

function deadCodeFinding(key: DeadCodeKey, line: number): Finding {
  return {
    id: `dead-code:${key.kind}:${key.path}:${key.name}`,
    check: "dead-code",
    status: "introduced",
    file: key.path,
    line,
    subject: `${key.kind} \`${key.name}\``,
    fix: DEAD_CODE_FIX[key.kind] ?? "Remove the unused code if nothing else references it.",
  }
}

type DeadCodeRecord = DeadCodeKey & { line: number }

function deadCodeRecords(report: DeadCodeReport): DeadCodeRecord[] {
  const exports = report.unused_exports.map((f) => ({
    kind: "export",
    path: f.path,
    name: f.export_name,
    line: f.line,
  }))
  const types = report.unused_types.map((f) => ({
    kind: "type",
    path: f.path,
    name: f.export_name,
    line: f.line,
  }))
  const files = report.unused_files.map((f) => ({
    kind: "file",
    path: f.path,
    name: f.path,
    line: 1,
  }))
  return [...exports, ...types, ...files]
}

function deadCodeKeyString(key: DeadCodeKey): string {
  return `${key.kind}\u0000${key.path}\u0000${key.name}`
}

function newDeadCodeFindings(base: DeadCodeReport, candidate: DeadCodeReport): Finding[] {
  const candidateRecords = deadCodeRecords(candidate)
  const introducedKeys = new Set(
    attributeDeadCode(deadCodeRecords(base), candidateRecords).map(deadCodeKeyString),
  )
  return candidateRecords
    .filter((record) => introducedKeys.has(deadCodeKeyString(record)))
    .map((record) => deadCodeFinding(record, record.line))
}

type AnalysisPass = {
  candidateComplexity: HealthReport
  candidateDuplication: DuplicationReport
  baseComplexity: HealthReport
  deadCode?: [candidate: DeadCodeReport, base: DeadCodeReport]
  addedRanges: Map<string, LineRange[]>
}

async function runAnalysis(
  analyzer: FallowAnalyzer,
  workspace: string,
  baseCommit: string,
  artifact: string,
  resolved: ResolvedFallowConfig,
  changed: string[],
  signal: AbortSignal | undefined,
): Promise<AnalysisPass> {
  const addedRanges = await withTimeout(
    () => addedRangesForFiles(workspace, baseCommit, artifact, changed),
    TIMEOUT_MS,
  )
  const base = await materialiseBaseTree(workspace, baseCommit, changed)
  try {
    const scope = (root: string) => ({
      root,
      configPath: resolved.configPath,
      files: changed,
      signal,
    })
    const [candidateComplexity, candidateDuplication, baseComplexity] = await withTimeout(
      () =>
        Promise.all([
          analyzer.complexity(scope(workspace)),
          analyzer.duplication(scope(workspace)),
          analyzer.complexity(scope(base.directory)),
        ]),
      TIMEOUT_MS,
    )
    const deadCode = resolved.deadCodeEnabled
      ? await withTimeout(
          () =>
            Promise.all([
              analyzer.deadCode(scope(workspace)),
              analyzer.deadCode(scope(base.directory)),
            ]),
          TIMEOUT_MS,
        )
      : undefined
    return { candidateComplexity, candidateDuplication, baseComplexity, deadCode, addedRanges }
  } finally {
    await base.cleanup()
  }
}

/**
 * Fallow review of a candidate against its base commit. Only findings the change introduces or
 * worsens are reported; older findings are never surfaced. Any analyzer or git error is reported
 * as `unavailable`, never thrown.
 */
export async function fallowReview(input: FallowReviewInput): Promise<FallowReviewResult> {
  const analyzer = input.analyzer ?? nativeFallowAnalyzer
  let resolved: ResolvedFallowConfig | undefined
  try {
    resolved = await resolveFallowConfig({
      directory: input.workspace,
      baseCommit: input.baseCommit,
      repository: input.repository,
    })
    const thresholds = thresholdsFrom(resolved.config)
    const changed = await changedAnalysableFiles(input.workspace, input.baseCommit, input.artifact)
    if (changed.length === 0)
      return {
        status: "clean",
        introduced: [],
        concerns: [],
        thresholds,
        configSource: resolved.source,
      }
    const { candidateComplexity, candidateDuplication, baseComplexity, deadCode, addedRanges } =
      await runAnalysis(
        analyzer,
        input.workspace,
        input.baseCommit,
        input.artifact,
        resolved,
        changed,
        input.signal,
      )
    const complexityAttrs = attributeComplexity(
      toComplexityPoints(baseComplexity),
      toComplexityPoints(candidateComplexity),
      thresholds,
    )
    const introduced: Finding[] = [
      ...complexityAttrs
        .filter((a) => a.status === "introduced")
        .map((a) => complexityFinding(a, thresholds)),
      ...newDuplicationFindings(candidateDuplication, addedRanges),
    ]
    const concerns: Finding[] = [
      ...complexityAttrs
        .filter((a) => a.status === "worsened")
        .map((a) => complexityFinding(a, thresholds)),
      ...(deadCode ? newDeadCodeFindings(deadCode[1], deadCode[0]) : []),
    ]
    return {
      status: introduced.length + concerns.length === 0 ? "clean" : "findings",
      introduced,
      concerns,
      thresholds,
      configSource: resolved.source,
    }
  } catch (error) {
    return {
      status: "unavailable",
      introduced: [],
      concerns: [],
      thresholds: thresholdsFrom(resolved?.config ?? null),
      configSource: resolved?.source ?? "defaults",
      reason: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (resolved) await cleanupResolvedFallowConfig(resolved)
  }
}

const GUIDANCE_CHECK_LABEL: Record<Finding["check"], string> = {
  complexity: "complexity",
  duplication: "duplication",
  "dead-code": "dead-code",
  cycle: "cycle",
}

function guidanceMeasure(finding: Finding): string {
  if (finding.measured === undefined) return ""
  const base = `${finding.measured}, limit ${finding.limit ?? "n/a"}`
  return finding.before !== undefined ? ` ${base} (was ${finding.before}).` : ` ${base}.`
}

function guidanceLine(finding: Finding, index: number): string {
  const location = finding.endLine
    ? `${finding.file}:${finding.line}-${finding.endLine}`
    : `${finding.file}:${finding.line}`
  const header = `${index + 1}. ${GUIDANCE_CHECK_LABEL[finding.check]} ${location} \`${finding.subject}\`${guidanceMeasure(finding)}`
  return `${header}\n   ${finding.fix}`
}

/** Plain-text guidance from fixed templates: at most ten findings, 1,500 characters, deterministic. */
export function fallowGuidance(result: FallowReviewResult): string {
  const findings = result.introduced.slice(0, 10)
  const header = `Fallow review: ${result.introduced.length} findings introduced by this task. Older findings are not counted.`
  const lines = findings.map((f, i) => guidanceLine(f, i))
  const closing = "Fix these inside your write scope. Do not add fallow-ignore comments."
  const guidance = [header, ...lines, closing].join("\n")
  return guidance.length > 1500 ? `${guidance.slice(0, 1497)}...` : guidance
}
