import type { Database } from "bun:sqlite"

export type RetiredGateMove = {
  planID: string
  from: string
  to: string
  reason: string | null
  retired: "human-evidence" | "source-quarantine" | "stale-hold"
}

/** `Combined artifact evidence missing: a:human` or `Required evidence missing: a:human, b:human`. */
const HUMAN_ONLY_REASON =
  /^(?:Combined artifact|Required|Required adoption|Required retained [a-z]+) evidence missing: (?:(?:task:|combined:)?[a-z][a-z0-9-]{0,63}:human)(?:, (?:task:|combined:)?[a-z][a-z0-9-]{0,63}:human)*$/

function tableExists(db: Database, name: string) {
  return Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
}

/**
 * Offline, idempotent retirement of the human-evidence gate.
 *
 * - Adoption and retained operations in the retired `waiting-human` states
 *   resume their check phase (`task-checks` or `combined-checks`); with no gate
 *   left, the checks re-run on the current candidate.
 * - A plan blocked solely on `:human` evidence leaves `blocked` through the
 *   plan XState machine (`lz_runner_transition`), so the scheduler re-runs
 *   verification and accepts or fails on real checks.
 *
 * Plans blocked on a cancelled prerequisite and unadmitted drafts are not
 * touched here: the scheduler's first tick drops the cancelled edge and admits
 * drafts through the same machines and admission preflight as a live command.
 */
export function retireHumanEvidenceGate(db: Database): RetiredGateMove[] {
  if (tableExists(db, "runner_adoptions"))
    db.exec(`UPDATE runner_adoptions SET state='task-checks' WHERE state='waiting-human'`)
  if (tableExists(db, "runner_retained_verifications")) {
    db.exec(`UPDATE runner_retained_verifications
      SET state='task-checks', payload=json_set(payload,'$.state','task-checks')
      WHERE state='waiting-human'`)
    db.exec(`UPDATE runner_retained_verifications
      SET state='combined-checks', payload=json_set(payload,'$.state','combined-checks')
      WHERE state='waiting-human-combined'`)
  }
  if (!tableExists(db, "runner_plans")) return []
  const moves: RetiredGateMove[] = []
  const blocked = db
    .query<{ id: string; state: string; reason: string | null; version: number }, []>(
      "SELECT id,state,reason,version FROM runner_plans WHERE state='blocked' AND reason LIKE '%evidence missing:%human%'",
    )
    .all()
  for (const plan of blocked) {
    if (!plan.reason || !HUMAN_ONLY_REASON.test(plan.reason)) continue
    const changed = db
      .query(
        "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),reason=NULL,version=version+1 WHERE id=? AND state='blocked' AND reason=?",
      )
      .run(plan.id, plan.reason).changes
    if (changed !== 1) continue
    db.query(
      "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,NULL,?,'PLAN_GATE_RETIRED',?,?)",
    ).run(
      plan.id,
      plan.version + 1,
      JSON.stringify({ gate: "human-evidence", previousReason: plan.reason }),
      Date.now(),
    )
    moves.push({
      planID: plan.id,
      from: "blocked",
      to: "running",
      reason: plan.reason,
      retired: "human-evidence",
    })
  }
  return moves
}

const QUARANTINE_REASON = /checkout is quarantined|source quarantine/i

/**
 * Offline, idempotent retirement of the source-quarantine ceremony. A plan held
 * because of a quarantine leaves `blocked` through the plan machine, so the
 * scheduler re-observes it with live facts; then the retired table is dropped.
 */
export function retireSourceQuarantines(db: Database): RetiredGateMove[] {
  const moves: RetiredGateMove[] = []
  if (tableExists(db, "runner_plans")) {
    const blocked = db
      .query<{ id: string; reason: string | null; version: number }, []>(
        "SELECT id,reason,version FROM runner_plans WHERE state='blocked' AND reason IS NOT NULL",
      )
      .all()
    for (const plan of blocked) {
      if (!plan.reason || !QUARANTINE_REASON.test(plan.reason)) continue
      const changed = db
        .query(
          "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),reason=NULL,version=version+1 WHERE id=? AND state='blocked' AND reason=?",
        )
        .run(plan.id, plan.reason).changes
      if (changed !== 1) continue
      db.query(
        "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,NULL,?,'PLAN_GATE_RETIRED',?,?)",
      ).run(
        plan.id,
        plan.version + 1,
        JSON.stringify({ gate: "source-quarantine", previousReason: plan.reason }),
        Date.now(),
      )
      moves.push({
        planID: plan.id,
        from: "blocked",
        to: "running",
        reason: plan.reason,
        retired: "source-quarantine",
      })
    }
  }
  db.exec("DROP INDEX IF EXISTS runner_source_quarantines_pending")
  db.exec("DROP TABLE IF EXISTS runner_source_quarantines")
  return moves
}

/**
 * Reasons from holds the simplified runtime no longer raises. A plan blocked on
 * one of them re-observes live facts: the runtime resumes the worker, fails an
 * unanswered input, re-runs the verification, or releases a scope overlap.
 */
const STALE_BLOCKED_REASONS: readonly RegExp[] = [
  /experimental\.idle|background observation|worker input lineage/i,
  /^Recovery uncertain for (?:graph-)?verify:/,
  /^Worker execution was interrupted; explicit reconciliation or cancellation is required/,
  /^Mechanical candidate preparation is blocked by an active scope reservation/,
]

/**
 * Offline, idempotent. Moves plans held by a retired reason forward through the
 * plan machine, and supersedes verification effects that never produced a
 * receipt so the check re-runs (they are re-runnable).
 */
export function retireStaleHolds(db: Database): RetiredGateMove[] {
  const moves: RetiredGateMove[] = []
  if (!tableExists(db, "runner_plans")) return moves
  const plans = db
    .query<{ id: string; state: string; reason: string | null; version: number }, []>(
      "SELECT id,state,reason,version FROM runner_plans WHERE state IN ('blocked','cleanup-blocked') AND reason IS NOT NULL",
    )
    .all()
  for (const plan of plans) {
    if (!plan.reason || !STALE_BLOCKED_REASONS.some((pattern) => pattern.test(plan.reason!)))
      continue
    // A cleanup hold resumes cleanup; any other hold resumes running.
    const event = plan.state === "cleanup-blocked" ? "cleaning" : "running"
    const changed = db
      .query(
        "UPDATE runner_plans SET state=lz_runner_transition('plan',state,?),reason=NULL,version=version+1 WHERE id=? AND state=? AND reason=?",
      )
      .run(event, plan.id, plan.state, plan.reason).changes
    if (changed !== 1) continue
    if (
      /^Recovery uncertain for (?:graph-)?verify:/.test(plan.reason) &&
      tableExists(db, "runner_effects")
    )
      supersedeReceiptlessVerifications(db, plan.id)
    db.query(
      "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,NULL,?,'PLAN_GATE_RETIRED',?,?)",
    ).run(
      plan.id,
      plan.version + 1,
      JSON.stringify({ gate: "stale-hold", previousReason: plan.reason }),
      Date.now(),
    )
    moves.push({
      planID: plan.id,
      from: plan.state,
      to: event === "cleaning" ? "cleaning" : "running",
      reason: plan.reason,
      retired: "stale-hold",
    })
  }
  return moves
}

function supersedeReceiptlessVerifications(db: Database, planID: string) {
  const effects = db
    .query<{ id: string; task_id: string | null; kind: string }, [string]>(
      `SELECT id,task_id,kind FROM runner_effects
       WHERE plan_id=? AND state IN ('intended','uncertain')
         AND (kind LIKE 'verify:%' OR kind LIKE 'graph-verify:%' OR kind='mechanical-fix')
         AND (receipt IS NULL OR receipt LIKE '%No conclusive host/artifact receipt%')`,
    )
    .all(planID)
  for (const effect of effects) {
    db.query(
      "UPDATE runner_effects SET state=lz_runner_transition('effect',state,'failed'),receipt=? WHERE id=?",
    ).run(
      JSON.stringify({ superseded: true, reason: "Retired hold: the check re-runs" }),
      effect.id,
    )
    db.query(
      "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,(SELECT version FROM runner_plans WHERE id=?),'EFFECT_SUPERSEDED',?,?)",
    ).run(
      planID,
      effect.task_id,
      planID,
      JSON.stringify({ effectID: effect.id, kind: effect.kind, reason: "retired hold" }),
      Date.now(),
    )
  }
}
