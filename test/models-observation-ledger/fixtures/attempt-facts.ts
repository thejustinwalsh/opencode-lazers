import { Database } from "bun:sqlite"
import assert from "node:assert/strict"
import type { ModelDecisionRoute } from "../../../src/models/decision-contract.ts"

/**
 * Rewrite one ledger fixture attempt's recorded steps onto an observed route with complete usage,
 * so the decision read attributes, measures and prices it (shared by the decision read and view
 * tests).
 */
export const completeUsage = (input: number) => ({
  input,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
})

export function observedRoute(route: ModelDecisionRoute) {
  return { status: "observed", route }
}

export function rewriteAttemptFacts(
  path: string,
  projectID: string,
  attemptID: string,
  route: ModelDecisionRoute,
  inputBySequence?: readonly number[],
) {
  const db = new Database(path, { strict: true })
  try {
    const rows = db
      .query<{ seq: number; kind: string; payload: string }, [string]>(
        "SELECT seq,kind,payload FROM runner_progress WHERE attempt_id=? ORDER BY seq",
      )
      .all(attemptID)
    let stepIndex = 0
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>
      if (row.kind === "step") {
        const input = inputBySequence?.[stepIndex]
        if (input !== undefined) payload.usage = completeUsage(input)
        payload.routeEvidence = observedRoute(route)
        payload.route = route
        stepIndex++
      } else if (row.kind === "usage-snapshot") {
        payload.usage = completeUsage(inputBySequence?.[0] ?? 100)
        payload.routeEvidence = observedRoute(route)
        payload.route = route
      }
      db.query("UPDATE runner_progress SET payload=?,message_id=? WHERE seq=?").run(
        JSON.stringify(payload),
        `decision-test-call-${row.seq}`,
        row.seq,
      )
    }

    const owner = db
      .query<{ task_id: string; session_id: string }, [string]>(
        "SELECT task_id,session_id FROM runner_attempts WHERE id=?",
      )
      .get(attemptID)
    const plan = db
      .query<{ plan_id: string; project_directory: string }, [string]>(
        "SELECT a.plan_id,p.project_directory FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id WHERE a.id=?",
      )
      .get(attemptID)
    assert.ok(owner && plan)
    const insertProgress = (
      kind: "step" | "usage-snapshot",
      payload: Record<string, unknown>,
      suffix: string,
    ) => {
      db.query(
        `INSERT INTO runner_progress
         (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,recorded_at,
          source,sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        plan.project_directory,
        projectID,
        plan.plan_id,
        owner.task_id,
        attemptID,
        owner.session_id,
        4_000,
        4_011,
        "runtime",
        JSON.stringify(["runtime"]),
        kind,
        JSON.stringify([]),
        null,
        kind === "step" ? `decision-test-call-${attemptID}` : null,
        `decision-test-${suffix}-${attemptID}`,
        JSON.stringify(payload),
      )
    }

    if (!rows.some((row) => row.kind === "usage-snapshot") && inputBySequence?.length) {
      const cumulativeInput = inputBySequence.reduce((total, value) => total + value, 0)
      insertProgress(
        "usage-snapshot",
        {
          additive: false,
          measurementBasis: "cumulative-session-snapshot",
          usage: completeUsage(cumulativeInput),
        },
        "usage",
      )
    }

    if (!rows.some((row) => row.kind === "step")) {
      insertProgress("step", { routeEvidence: observedRoute(route), route }, "route")
    }
  } finally {
    db.close()
  }
}
