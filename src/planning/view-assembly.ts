import type { TargetField } from "./contract.ts"
import type { PlanningBody, Validation } from "./draft.ts"
import type { PlanningView, ViewAgent, ViewReview } from "./view-model.ts"
import type { PlanningState } from "../runner/lifecycle-machines.ts"

/**
 * The plan view from stored rows, with no database: the server's `planningView` (`read.ts`) and
 * the Plan panel's `planning.detail` stream (`src/streams/sources/planning.ts`) both assemble
 * through here, so the panel shows what the stored rows say and nothing else.
 */

/** Per unit (`draftID`, or `@plan`), the hash of each stored field; `*` hashes the whole unit. */
export type Hashes = Record<string, Record<string, string>>

/** The stored keys a finding field depends on. `*` is the whole unit. */
export const FIELD_KEYS: Record<TargetField, readonly string[]> = {
  objective: ["objective"],
  acceptance: ["acceptance"],
  verification: ["verification"],
  "write-scope": ["writeScope", "createScope", "protectedScope"],
  dependencies: ["dependsOn"],
  exclusions: ["exclusions"],
  assumption: ["assumptions"],
  "design-decision": ["*"],
  other: ["*"],
}

/**
 * A finding is stale when its draft's field changed (or the draft was added or removed) since
 * the revision it was raised on. A plan-level finding has no draft and reads `@plan`.
 */
export function isStale(
  finding: { draftID: string | null; field: TargetField; revision: number },
  hashesAt: (revision: number) => Hashes,
  current: number,
): boolean {
  if (finding.revision === current) return false
  const unit = finding.draftID ?? "@plan"
  const then = hashesAt(finding.revision)[unit]
  const now = hashesAt(current)[unit]
  if (!then || !now) return then !== now
  return FIELD_KEYS[finding.field].some((key) => then[key] !== now[key])
}

/** Stored rows in the column names of their tables, as the store and the stream read them. */
export type StoredFinding = {
  id: string
  source: string
  revision: number
  draft_id: string | null
  field: string | null
  severity: string | null
  confidence: string | null
  body: string
  resolution: string | null
}
export type StoredQuestion = {
  id: string
  source: string
  revision: number
  body: string
  route: string | null
  answer: string | null
}
export type StoredRun = {
  agent: string
  state: string
  reason: string | null
  input_tokens: number | null
  output_tokens: number | null
  duration_ms: number | null
}
export type StoredReview = {
  id: string
  stage: "review" | "final"
  revision: number
  /** In `started_at, attempt, id` order. */
  runs: StoredRun[]
}
export type StoredTasked = {
  draft_id: string
  reference: string | null
  changed_fields_json: string | null
}
export type PlanningParts = {
  id: string
  title: string
  state: PlanningState
  revision: number
  shownRevision: number
  body: PlanningBody
  validation: Validation
  /** Field hashes by revision: at least the shown one and every finding's. */
  hashes: Record<number, Hashes>
  findings: StoredFinding[]
  questions: StoredQuestion[]
  reviews: StoredReview[]
  tasked: StoredTasked[]
}

const text = (json: string | null | undefined, keys: string[]): string => {
  if (!json) return ""
  try {
    const value = JSON.parse(json) as Record<string, unknown>
    for (const key of keys) if (typeof value[key] === "string") return value[key] as string
    return json
  } catch {
    return json
  }
}

function agentOf(agent: string, runs: StoredRun[]): ViewAgent {
  const latest = runs.at(-1)!
  const status: ViewAgent["status"] =
    latest.state === "reviewed"
      ? "reviewed"
      : latest.state === "stuck"
        ? "stuck"
        : latest.state === "failed" || latest.state === "cancelled"
          ? "not-run"
          : "running"
  const reason = status === "reviewed" || status === "running" ? undefined : latest.reason
  return {
    agent,
    status,
    attempts: runs.length,
    tokens: runs.reduce((sum, run) => sum + (run.input_tokens ?? 0) + (run.output_tokens ?? 0), 0),
    durationMs: runs.reduce((sum, run) => sum + (run.duration_ms ?? 0), 0),
    ...(reason ? { reason } : {}),
  }
}

export function assemblePlanningView(parts: PlanningParts): PlanningView {
  const hashesAt = (revision: number) => parts.hashes[revision] ?? {}
  const reviews: ViewReview[] = parts.reviews.map((review) => {
    const byAgent = new Map<string, StoredRun[]>()
    for (const run of review.runs) byAgent.set(run.agent, [...(byAgent.get(run.agent) ?? []), run])
    return {
      id: review.id,
      stage: review.stage,
      revision: review.revision,
      agents: [...byAgent].map(([agent, list]) => agentOf(agent, list)),
    }
  })
  const tasked = parts.tasked.map((entry) => ({
    draftID: entry.draft_id,
    reference: entry.reference ?? null,
    changedFields: entry.changed_fields_json
      ? (JSON.parse(entry.changed_fields_json) as string[])
      : [],
  }))
  return {
    id: parts.id,
    title: parts.title,
    state: parts.state,
    revision: parts.revision,
    shownRevision: parts.shownRevision,
    body: parts.body,
    validation: parts.validation,
    findings: parts.findings.map((finding) => ({
      id: finding.id,
      source: finding.source,
      revision: finding.revision,
      draftId: finding.draft_id ?? null,
      field: finding.field ?? null,
      severity: finding.severity ?? null,
      confidence: finding.confidence ?? null,
      what: text(finding.body, ["what"]),
      resolution: finding.resolution ?? "open",
      stale: isStale(
        {
          draftID: finding.draft_id ?? null,
          field: (finding.field ?? "other") as TargetField,
          revision: finding.revision,
        },
        hashesAt,
        parts.shownRevision,
      ),
    })),
    questions: parts.questions.map((question) => ({
      id: question.id,
      source: question.source,
      revision: question.revision,
      question: text(question.body, ["question"]),
      route: question.route ?? "open",
      answer: question.answer ?? null,
    })),
    reviews,
    ...(tasked.length ? { tasked } : {}),
  }
}
