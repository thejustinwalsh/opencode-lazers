import { PlanningBody, type Validation } from "./draft.ts"
import type { PlanningStore } from "./store.ts"
import { assemblePlanningView, type Hashes } from "./view-assembly.ts"
import type { PlanningView } from "./view-model.ts"

/**
 * The stored plan as the view shows it; `undefined` when it is missing or another project's. The
 * Plan panel reads the same rows through `planning.detail` and assembles them the same way.
 */
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
  const findings = store.findings(planningID)
  const hashes: Record<number, Hashes> = {}
  for (const at of new Set([shownRevision, ...findings.map((finding) => finding.revision)])) {
    const found = at === shownRevision ? stored : store.revision(planningID, at)
    if (found) hashes[at] = JSON.parse(found.fieldHashes) as Hashes
  }
  return assemblePlanningView({
    id: row.id,
    title: row.title,
    state: row.state,
    revision: row.revision,
    shownRevision,
    body: PlanningBody.parse(JSON.parse(stored.body)),
    validation: JSON.parse(stored.validation) as Validation,
    hashes,
    findings: findings.map((finding) => ({
      id: finding.id,
      source: finding.source,
      revision: finding.revision,
      draft_id: finding.draftId ?? null,
      field: finding.field ?? null,
      severity: finding.severity ?? null,
      confidence: finding.confidence ?? null,
      body: finding.body,
      resolution: finding.resolution ?? null,
    })),
    questions: store.questions(planningID).map((question) => ({
      id: question.id,
      source: question.source,
      revision: question.revision,
      body: question.body,
      route: question.route ?? null,
      answer: question.answer ?? null,
    })),
    reviews: store.reviews(planningID).map((review) => ({
      id: review.id,
      stage: review.stage,
      revision: review.revision,
      runs: store.runs(review.id).map((run) => ({
        agent: run.agent,
        state: run.state,
        reason: run.reason ?? null,
        input_tokens: run.inputTokens ?? null,
        output_tokens: run.outputTokens ?? null,
        duration_ms: run.durationMs ?? null,
      })),
    })),
    tasked: store.tasked(planningID).map((entry) => ({
      draft_id: entry.draftId,
      reference: entry.reference ?? null,
      changed_fields_json: entry.changedFieldsJson ?? null,
    })),
  })
}
