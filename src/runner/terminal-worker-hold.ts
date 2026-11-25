import type { AttemptRow, NodeRow, PlanRow, RunnerStore } from "./store.ts"
import type { TerminalWorkerHold } from "./interrupted-continuation.ts"
import { planIs } from "./identity-read.ts"

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function payload(value: string): Record<string, unknown> | undefined {
  try {
    return object(JSON.parse(value))
  } catch {
    return undefined
  }
}

/**
 * Keep the latest plan hold authoritative, except when reconcile has re-held the same failed task
 * generically. In that case, recover only the matching attempt's earlier durable terminal hold.
 */
export function terminalWorkerHoldForContinuation(
  store: RunnerStore,
  plan: PlanRow,
  node: NodeRow | undefined,
  attempt: AttemptRow | undefined,
): TerminalWorkerHold | undefined {
  const { latestBlocked, latestReconcileID } = store.read((db) => {
    const latestBlocked = db
      .query<{ id: number; payload: string }, [string]>(
        `SELECT t.id,t.payload FROM runner_transitions AS t
         WHERE ${planIs(db, "runner_transitions", "t")} AND t.task_id IS NULL AND t.event='BLOCKED'
         ORDER BY t.id DESC LIMIT 1`,
      )
      .get(plan.id)
    const latestReconcileID = db
      .query<{ id: number }, [string]>(
        `SELECT t.id FROM runner_transitions AS t
         WHERE ${planIs(db, "runner_transitions", "t")} AND t.task_id IS NULL
           AND t.event='RECONCILE_REQUESTED'
         ORDER BY t.id DESC LIMIT 1`,
      )
      .get(plan.id)?.id
    return { latestBlocked, latestReconcileID }
  })
  if (!latestBlocked) return undefined

  const latestPayload = payload(latestBlocked.payload)
  const currentObservation = object(latestPayload?.workerObservation)
  if (currentObservation) return currentObservation as TerminalWorkerHold
  if (
    !node ||
    !attempt ||
    plan.state !== "blocked" ||
    plan.artifact !== null ||
    node.task_id !== attempt.task_id ||
    attempt.plan_id !== plan.id ||
    node.state !== "failed" ||
    attempt.state !== "failed" ||
    latestReconcileID === undefined ||
    latestBlocked.id <= latestReconcileID
  )
    return undefined

  const failedTaskReason = `Task ${node.task_id}: ${node.reason ?? node.state}`
  if (plan.reason !== failedTaskReason || latestPayload?.reason !== failedTaskReason)
    return undefined

  const previous = store.read((db) =>
    db
      .query<
        { payload: string },
        [string, string, string, string, string, string, number, string, string]
      >(
        `SELECT t.payload FROM runner_transitions AS t
         WHERE ${planIs(db, "runner_transitions", "t")} AND t.task_id IS NULL AND t.event='BLOCKED'
           AND json_extract(CASE WHEN json_valid(t.payload) THEN t.payload END,'$.workerObservation.kind')=?
           AND json_extract(CASE WHEN json_valid(t.payload) THEN t.payload END,'$.workerObservation.attemptID')=?
           AND json_extract(CASE WHEN json_valid(t.payload) THEN t.payload END,'$.workerObservation.sessionID')=?
           AND json_extract(CASE WHEN json_valid(t.payload) THEN t.payload END,'$.workerObservation.workspace')=?
           AND json_extract(CASE WHEN json_valid(t.payload) THEN t.payload END,'$.workerObservation.inputID')=?
           AND json_extract(CASE WHEN json_valid(t.payload) THEN t.payload END,'$.workerObservation.outcome')='failed'
           AND t.id < ?
           AND EXISTS (
             SELECT 1 FROM runner_attempts AS a
             WHERE a.plan_id=t.plan_id AND a.id=? AND a.task_id=?
           )
         ORDER BY t.id DESC LIMIT 1`,
      )
      .get(
        plan.id,
        "terminal-worker-observation",
        attempt.id,
        attempt.session_id,
        attempt.workspace,
        attempt.message_id,
        latestReconcileID,
        attempt.id,
        attempt.task_id,
      ),
  )
  const observation = object(payload(previous?.payload ?? "")?.workerObservation)
  return observation as TerminalWorkerHold | undefined
}
