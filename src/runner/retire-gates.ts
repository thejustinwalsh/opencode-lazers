import type { Database } from "bun:sqlite"
import { planIs } from "./identity-read.ts"

export type RetiredGateMove = {
  planID: string
  from: string
  to: string
  reason: string | null
  retired: "human-evidence" | "source-quarantine" | "stale-hold" | "retained-verification"
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
  /^Recovery uncertain for (?:(?:graph-)?verify:|mechanical-fix )/,
  /^Worker execution was interrupted; explicit reconciliation or cancellation is required/,
  /^Mechanical candidate preparation is blocked by an active scope reservation/,
  // Replay gates: the fix and the checks now run again on the current candidate.
  /^Mechanical candidate preparation (?:inputs changed|is uncertain and was not replayed|journal is unreadable)/,
  /^Mechanical candidate changed after its authorized fix receipt/,
  /^(?:Combined v|V)erification \S+ (?:has an uncertain receipt and was not replayed|completed with exit .*; subprocess cleanup remains uncertain)/,
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
      /^Recovery uncertain for (?:(?:graph-)?verify:|mechanical-fix )/.test(plan.reason) &&
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

export type RetiredRetainedOperation = {
  operationID: string
  planID: string
  from: string
  to: "accepted" | "cancelled"
}

/** Plan holds raised by the retired retained and combined-continuation bindings. */
const RETAINED_GATE_REASONS: readonly RegExp[] = [
  /^Combined verification continuation /,
  /^Interrupted combined verification candidate changed/,
  /retained operation binds/i,
  /^Retained (?:verification|check) /,
  /^Explicit retained check continuation/,
]

function columnExists(db: Database, table: string, column: string) {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column)
}

/**
 * Offline, idempotent collapse of retained verification to one call that passes
 * or fails.
 *
 * - An operation in a retired or running state is closed. Its task candidate was
 *   accepted when a task-acceptance event names it (state `accepted`); otherwise
 *   it is `cancelled` with its prior hold reason kept in the retirement reason,
 *   so verification simply re-runs with `verify-retained`. The existing
 *   terminal cleanup removes its checkouts and settles its resources.
 * - Operation payloads lose the generation, plan-version, authorization,
 *   quarantine and fingerprint bindings; the hold reason becomes the failure
 *   reason. The generation column is dropped from the operation, evidence and
 *   resource tables, and a retained check retry authorization becomes the
 *   completed check it was issued for.
 * - A plan blocked on a retired retained or continuation binding leaves
 *   `blocked` through the plan machine, so the combined check re-runs.
 * - Queued held-verification notices are superseded; the hold they describe is gone.
 */
export function retireRetainedVerificationGates(db: Database): {
  operations: RetiredRetainedOperation[]
  plans: RetiredGateMove[]
} {
  const operations: RetiredRetainedOperation[] = []
  const plans: RetiredGateMove[] = []
  if (tableExists(db, "runner_retained_verifications")) {
    // Only the legacy shape holds retired operations; a current table's live calls are left alone.
    const legacyShape = columnExists(db, "runner_retained_verifications", "generation")
    const open = legacyShape
      ? db
          .query<{ id: string; plan_id: string; task_id: string; state: string }, []>(
            `SELECT id,plan_id,task_id,state FROM runner_retained_verifications
         WHERE state IN ('pending','task-checks','combined-checks','task-accepted','held')`,
          )
          .all()
      : []
    for (const operation of open) {
      const taskAccepted = tableExists(db, "runner_transitions")
        ? Boolean(
            db
              .query(
                `SELECT 1 FROM runner_transitions
                 WHERE ${planIs(db, "runner_transitions")} AND event IN ('RETAINED_TASK_CANDIDATE_ACCEPTED','RETAINED_CANDIDATE_ACCEPTED')
                   AND json_extract(payload,'$.operationID')=? LIMIT 1`,
              )
              .get(operation.plan_id, operation.id),
          )
        : false
      const to = taskAccepted ? "accepted" : "cancelled"
      db.query(
        `UPDATE runner_retained_verifications SET state=?,
           payload=json_set(payload,'$.state',?,'$.holdReason',
             CASE WHEN ?='cancelled'
               THEN 'Retired by the retained-verification collapse; run verify-retained again. Previous reason: '
                 || COALESCE(json_extract(payload,'$.holdReason'),'none')
               ELSE NULL END)
         WHERE id=? AND state=?`,
      ).run(to, to, to, operation.id, operation.state)
      const version =
        db
          .query<{ version: number }, [string]>("SELECT version FROM runner_plans WHERE id=?")
          .get(operation.plan_id)?.version ?? 0
      db.query(
        "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,?,'RETAINED_VERIFICATION_RETIRED',?,?)",
      ).run(
        operation.plan_id,
        operation.task_id,
        version,
        JSON.stringify({ operationID: operation.id, from: operation.state, to }),
        Date.now(),
      )
      operations.push({
        operationID: operation.id,
        planID: operation.plan_id,
        from: operation.state,
        to,
      })
    }
    // Payloads carry the new shape; the column and its unique key go with the generation.
    if (columnExists(db, "runner_retained_verifications", "generation")) {
      db.exec(`UPDATE runner_retained_verifications SET payload=json_set(
          json_remove(payload,'$.generation','$.planVersion','$.ownerEpoch','$.sourceQuarantine',
            '$.combinedInputFingerprint','$.inputFingerprint','$.holdReason'),
          '$.state',state,
          '$.failureReason',COALESCE(json_extract(payload,'$.holdReason'),json_extract(payload,'$.failureReason')))`)
      // Child tables reference the parent by name. Dropping it counts dangling rows
      // against the deferred foreign-key check; inserting the rows back into a
      // table of the same name clears the count before commit.
      db.exec("PRAGMA defer_foreign_keys = ON")
      db.exec(`CREATE TABLE runner_retained_verifications_stash AS
          SELECT id,project_directory,plan_id,task_id,state,payload
          FROM runner_retained_verifications ORDER BY rowid;
        DROP INDEX IF EXISTS runner_retained_verifications_active;
        DROP TABLE runner_retained_verifications;
        CREATE TABLE runner_retained_verifications (
          id TEXT PRIMARY KEY,
          project_directory TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          state TEXT NOT NULL,
          payload TEXT NOT NULL
        );
        INSERT INTO runner_retained_verifications(id,project_directory,plan_id,task_id,state,payload)
          SELECT id,project_directory,plan_id,task_id,state,payload
          FROM runner_retained_verifications_stash;
        DROP TABLE runner_retained_verifications_stash;
        CREATE INDEX runner_retained_verifications_active
          ON runner_retained_verifications(project_directory,plan_id,task_id,state);`)
    }
    if (tableExists(db, "runner_retained_verification_checks"))
      db.exec(
        `UPDATE runner_retained_verification_checks SET state='completed' WHERE state='retry-authorized'`,
      )
    if (
      tableExists(db, "runner_retained_verification_evidence") &&
      columnExists(db, "runner_retained_verification_evidence", "generation")
    ) {
      db.exec("DROP INDEX IF EXISTS runner_retained_verification_evidence_lookup")
      db.exec("ALTER TABLE runner_retained_verification_evidence DROP COLUMN generation")
      db.exec(`CREATE INDEX IF NOT EXISTS runner_retained_verification_evidence_lookup
        ON runner_retained_verification_evidence(operation_id,phase,task_id,assertion_id,artifact)`)
    }
    if (
      tableExists(db, "runner_retained_verification_resources") &&
      columnExists(db, "runner_retained_verification_resources", "generation")
    )
      db.exec("ALTER TABLE runner_retained_verification_resources DROP COLUMN generation")
  }
  if (tableExists(db, "runner_plans")) {
    const blocked = db
      .query<{ id: string; reason: string; version: number }, []>(
        "SELECT id,reason,version FROM runner_plans WHERE state='blocked' AND reason IS NOT NULL AND artifact IS NULL",
      )
      .all()
    for (const plan of blocked) {
      if (!RETAINED_GATE_REASONS.some((pattern) => pattern.test(plan.reason))) continue
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
        JSON.stringify({ gate: "retained-verification", previousReason: plan.reason }),
        Date.now(),
      )
      plans.push({
        planID: plan.id,
        from: "blocked",
        to: "running",
        reason: plan.reason,
        retired: "retained-verification",
      })
    }
  }
  if (tableExists(db, "runner_outbox"))
    db.exec(`UPDATE runner_outbox SET state=lz_runner_transition('outbox',state,'superseded'),
        receipt=COALESCE(receipt,json_object('history',json_array(json_object('kind','retired-retained-hold'))))
      WHERE state='pending' AND json_extract(payload,'$.status')='retained-verification-held'`)
  return { operations, plans }
}
