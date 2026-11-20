import type { TargetField } from "./contract.ts"
import { PlanningBody, isStale, type Validation } from "./draft.ts"
import { renderBreakdown } from "./render.ts"
import type { PlanningStore, RunRow } from "./store.ts"
import type { PlanningView, ViewAgent, ViewReview } from "./view-model.ts"

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

function agentOf(agent: string, runs: RunRow[]): ViewAgent {
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
    tokens: runs.reduce((sum, run) => sum + (run.inputTokens ?? 0) + (run.outputTokens ?? 0), 0),
    durationMs: runs.reduce((sum, run) => sum + (run.durationMs ?? 0), 0),
    ...(reason ? { reason } : {}),
  }
}

/** The stored plan as the view shows it; `undefined` when it is missing or another project's. */
export function planningView(
  store: PlanningStore,
  projectKey: string,
  planningID: string,
  revision?: number,
): PlanningView | undefined {
  const row = store.planning(planningID)
  if (!row || row.projectKey !== projectKey || row.revision === 0) return undefined
  const shownRevision = revision ?? row.revision
  const stored = store.revision(planningID, shownRevision)
  if (!stored) return undefined
  const body = PlanningBody.parse(JSON.parse(stored.body))
  const validation = JSON.parse(stored.validation) as Validation
  const hashes = new Map<number, ReturnType<typeof JSON.parse>>()
  const hashesAt = (n: number) => {
    if (!hashes.has(n)) {
      const at = store.revision(planningID, n)
      hashes.set(n, at ? JSON.parse(at.fieldHashes) : {})
    }
    return hashes.get(n)!
  }
  const findings = store.findings(planningID).map((finding) => ({
    id: finding.id,
    source: finding.source,
    revision: finding.revision,
    draftId: finding.draftId ?? null,
    field: finding.field ?? null,
    severity: finding.severity ?? null,
    confidence: finding.confidence ?? null,
    what: text(finding.body, ["what"]),
    resolution: finding.resolution ?? "open",
    stale: isStale(
      {
        draftID: finding.draftId ?? null,
        field: (finding.field ?? "other") as TargetField,
        revision: finding.revision,
      },
      hashesAt,
      shownRevision,
    ),
  }))
  const questions = store.questions(planningID).map((question) => ({
    id: question.id,
    source: question.source,
    revision: question.revision,
    question: text(question.body, ["question"]),
    route: question.route ?? "open",
    answer: question.answer ?? null,
  }))
  const reviews: ViewReview[] = store.reviews(planningID).map((review) => {
    const runs = store.runs(review.id)
    const byAgent = new Map<string, RunRow[]>()
    for (const run of runs) byAgent.set(run.agent, [...(byAgent.get(run.agent) ?? []), run])
    return {
      id: review.id,
      stage: review.stage,
      revision: review.revision,
      agents: [...byAgent].map(([agent, list]) => agentOf(agent, list)),
    }
  })
  const tasked = store.tasked(planningID).map((entry) => ({
    draftID: entry.draftId,
    reference: entry.reference ?? null,
    changedFields: entry.changedFieldsJson ? (JSON.parse(entry.changedFieldsJson) as string[]) : [],
  }))
  return {
    id: row.id,
    title: row.title,
    state: row.state,
    revision: row.revision,
    shownRevision,
    body,
    validation,
    breakdown: renderBreakdown({
      body,
      revision: shownRevision,
      validation,
      planningID,
      projectID: projectKey,
    }),
    findings,
    questions,
    reviews,
    ...(tasked.length ? { tasked } : {}),
  }
}
