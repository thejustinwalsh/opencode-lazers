import type { Database } from "bun:sqlite"

export type RetiredGateMove = {
  planID: string
  from: string
  to: string
  reason: string | null
  retired: "human-evidence" | "source-quarantine"
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
 * Offline, idempotent collapse of the outbox lifecycle to pending, delivered and
 * superseded. Notices about notices (source-change and source-reference
 * pointers) are retired unsent. Every other notice that reached the host is
 * delivered; one that had not stays pending. Consumption was never provable, so
 * the old consumed, unknown and reconciling distinctions carry no state.
 */
export function retireOutboxLifecycle(db: Database) {
  if (!tableExists(db, "runner_outbox")) return
  const notice = `json_extract(payload,'$.status') IN ('architect-source-reference','architect-source-change')`
  db.exec(`UPDATE runner_outbox SET state='superseded',
      receipt=COALESCE(receipt,json_object('history',json_array(json_object('kind','retired-notice-about-notices'))))
    WHERE ${notice} AND state IN ('pending','sending','uncertain')`)
  db.exec(`UPDATE runner_outbox SET state='pending' WHERE state IN ('sending','uncertain')`)
  db.exec(
    `UPDATE runner_outbox SET state='delivered' WHERE state IN ('admitted','consumed','unknown','reconciling')`,
  )
}
