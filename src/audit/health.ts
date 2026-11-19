import type { AuditHistory } from "./history.ts"
import type { AuditActor } from "./history.ts"
import { DUPLICATION_NOT_INCLUDED, fallowReport } from "./report.ts"
import type { FallowHealthComparison, FallowHealthRunOutput } from "./contract.ts"

/**
 * Whole-repository health as an Auditor run: the full `fallow health` score with its per-metric
 * penalties and the findings behind the worst of them, stored as an audit run (dead code,
 * duplication and health from one engine run), comparable with any earlier health run.
 */

const HEALTH_SECTIONS = ["deadCode", "duplication", "health"] as const
const TOP_PER_METRIC = 5

type Row = { file: string; line: number; subject: string }
type Obj = Record<string, unknown>
const list = (value: unknown): Obj[] => (Array.isArray(value) ? (value as Obj[]) : [])
const str = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback)
const int = (value: unknown) => (typeof value === "number" ? Math.max(0, Math.trunc(value)) : 0)
const num = (value: unknown) => (typeof value === "number" ? value : 0)

export type HealthScore = {
  score: number
  grade: string
  formulaVersion: number
  penalties: Record<string, number>
}

/** The score object of a stored health section, when the run produced one. */
export function scoreOf(health: unknown): HealthScore | undefined {
  const score = (health as { health_score?: Obj } | undefined)?.health_score
  if (!score || typeof score.score !== "number") return undefined
  const penalties = Object.fromEntries(
    Object.entries((score.penalties as Record<string, unknown>) ?? {}).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  )
  return {
    score: score.score,
    grade: str(score.grade),
    formulaVersion: int(score.formula_version),
    penalties,
  }
}

type Reports = { deadCode?: Obj; duplication?: Obj; health?: Obj }

/** Findings behind each penalty, drawn from the sections the run stored. */
const SOURCES: Record<string, (reports: Reports) => Row[]> = {
  dead_files: (r) =>
    list(r.deadCode?.unused_files).map((f) => ({
      file: str(f.path),
      line: 1,
      subject: "unused file",
    })),
  dead_exports: (r) =>
    [...list(r.deadCode?.unused_exports), ...list(r.deadCode?.unused_types)].map((f) => ({
      file: str(f.path),
      line: int(f.line),
      subject: `unused export ${str(f.export_name)}`,
    })),
  complexity: (r) =>
    list(r.health?.findings)
      .sort((a, b) => num(b.cognitive) - num(a.cognitive))
      .map((f) => ({
        file: str(f.path),
        line: int(f.line),
        subject: `${str(f.name)} cognitive ${num(f.cognitive)} cyclomatic ${num(f.cyclomatic)}`,
      })),
  maintainability: (r) =>
    list(r.health?.file_scores)
      .sort((a, b) => num(a.maintainability_index) - num(b.maintainability_index))
      .map((f) => ({
        file: str(f.path),
        line: 1,
        subject: `maintainability ${num(f.maintainability_index)}`,
      })),
  hotspots: (r) =>
    list(r.health?.hotspots).map((f) => ({
      file: str(f.path),
      line: 1,
      subject: `hotspot score ${num(f.score)}, ${num(f.commits)} commits`,
    })),
  unused_deps: (r) =>
    [...list(r.deadCode?.unused_dependencies), ...list(r.deadCode?.unused_dev_dependencies)].map(
      (f) => ({
        file: str(f.path, "package.json"),
        line: int(f.line),
        subject: str(f.package_name),
      }),
    ),
  circular_deps: (r) =>
    list(r.deadCode?.circular_dependencies).map((f) => ({
      file: str((f.files as string[] | undefined)?.[0]),
      line: 1,
      subject: `${int(f.length)} files import each other`,
    })),
  unit_size: (r) =>
    list(r.health?.large_functions).map((f) => ({
      file: str(f.path),
      line: int(f.line),
      subject: `${str(f.name)} ${int(f.line_count)} lines`,
    })),
  coupling: (r) =>
    list(r.health?.file_scores)
      .sort((a, b) => num(b.fan_in) - num(a.fan_in))
      .map((f) => ({ file: str(f.path), line: 1, subject: `fan-in ${num(f.fan_in)}` })),
  duplication: (r) =>
    list(r.duplication?.clone_groups)
      .sort((a, b) => num(b.token_count) - num(a.token_count))
      .map((g) => {
        const first = (g.instances as Obj[] | undefined)?.[0] ?? {}
        return {
          file: str(first.file),
          line: int(first.start_line),
          subject: `${int(g.line_count)} lines in ${list(g.instances).length} places`,
        }
      }),
}
SOURCES.p90_complexity = SOURCES.complexity!

/** Penalty deltas between two scores. A positive delta is a worse metric; a positive score delta is better. */
export function compareHealth(
  baselineRunID: string,
  from: HealthScore | undefined,
  to: HealthScore | undefined,
  duplicationComparable: boolean,
): FallowHealthComparison {
  const metrics = [
    ...new Set([...Object.keys(from?.penalties ?? {}), ...Object.keys(to?.penalties ?? {})]),
  ]
  return {
    baselineRunID,
    scoreFrom: from?.score ?? null,
    scoreTo: to?.score ?? null,
    scoreDelta: from && to ? Math.round((to.score - from.score) * 10) / 10 : null,
    gradeFrom: from?.grade ?? null,
    gradeTo: to?.grade ?? null,
    penaltyDeltas: metrics
      .filter((metric) => duplicationComparable || metric !== "duplication")
      .map((metric) => {
        const before = from?.penalties[metric] ?? 0
        const after = to?.penalties[metric] ?? 0
        return { metric, from: before, to: after, delta: Math.round((after - before) * 10) / 10 }
      })
      .sort((a, b) => b.delta - a.delta),
    duplicationComparable,
  }
}

export type HealthRunInput = {
  requestID: string
  workspace: string
  taskID?: string
  phase?: "baseline" | "follow-up" | "inspection"
  /** Compare with this earlier health run; default is the task's baseline when there is one. */
  baselineRunID?: string
}

/** The stored result of a health run, with its comparison to the baseline run. */
export function healthRunOutput(
  history: AuditHistory,
  runID: string,
  against?: string,
): FallowHealthRunOutput {
  const run = history.get(runID)
  const sections = history.sections(runID)
  const reports: Reports = {}
  const errors: FallowHealthRunOutput["errors"] = []
  for (const section of sections) {
    if (section.error) errors.push({ section: section.analysis, message: section.error })
    else if (HEALTH_SECTIONS.includes(section.analysis as never))
      (reports as Record<string, Obj>)[section.analysis] = section.report as Obj
  }
  const score = scoreOf(reports.health)
  const duplicationIncluded = !errors.some(
    (e) => e.section === "duplication" && e.message === DUPLICATION_NOT_INCLUDED,
  )
  const penalties = Object.entries(score?.penalties ?? {})
    .map(([metric, penalty]) => ({ metric, penalty }))
    .sort((a, b) => b.penalty - a.penalty)
  const top = penalties
    .filter((p) => p.penalty > 0)
    .map((p) => ({
      metric: p.metric,
      penalty: p.penalty,
      findings: (SOURCES[p.metric]?.(reports) ?? []).slice(0, TOP_PER_METRIC),
    }))
  let comparison: FallowHealthComparison | undefined
  const baselineID = against ?? run.baselineRunID
  if (baselineID && baselineID !== runID) {
    const baseSections = history.sections(baselineID)
    const baseHealth = baseSections.find((s) => s.analysis === "health" && !s.error)?.report
    const baseDuplication = baseSections.some(
      (s) => s.analysis === "duplication" && s.error === DUPLICATION_NOT_INCLUDED,
    )
    comparison = compareHealth(
      baselineID,
      scoreOf(baseHealth),
      score,
      duplicationIncluded && !baseDuplication,
    )
  }
  return {
    runID,
    phase: run.phase,
    state: run.state,
    score: score?.score ?? null,
    grade: score?.grade ?? null,
    formulaVersion: score?.formulaVersion ?? null,
    penalties,
    duplicationIncluded,
    top,
    ...(comparison ? { comparison } : {}),
    errors,
    reportPath: history.reportPath(runID),
  }
}

/** Runs a whole-repository health run (or replays the stored one for the same request). */
export async function fallowHealthRun(
  history: AuditHistory,
  input: HealthRunInput,
  actor: AuditActor,
  signal?: AbortSignal,
): Promise<FallowHealthRunOutput> {
  const summary = await fallowReport(
    history,
    { ...input, sections: [...HEALTH_SECTIONS] },
    actor,
    signal,
  )
  return healthRunOutput(history, summary.runID)
}
