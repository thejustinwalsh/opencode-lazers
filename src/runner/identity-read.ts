import type { Database } from "bun:sqlite"
import { backfillState, type BackfillTable } from "./identity-backfill.ts"
import { KEY_BACKFILL, PLAN_KEYS, ATTEMPT_KEYS } from "./identity-keys.ts"
import { missingKeyIndexes } from "./transition-indexes.ts"

/**
 * How a reader chooses between the text id columns and the integer keys.
 *
 * The rule is a per-table "complete" flag (`lazers_key_backfill.complete`), not a COALESCE: a
 * predicate like `plan_n=K OR (plan_n IS NULL AND plan_id=?)` cannot use one index for the
 * lookup and the ordering at once and would keep the text indexes in every plan. The flag is set
 * only when every row of the table has its keys (the paged backfill has passed the last row and
 * the insert trigger keys any row written since) and the integer indexes exist. Until then a
 * reader runs the statement it always ran; afterwards the same statement with the predicate
 * swapped, taking the same bound parameters. The flag never goes back to 0 (step 4 of the plan
 * removes the text columns), so a true answer is cached for the life of the connection.
 */
const known = new WeakMap<Database, Set<BackfillTable>>()

export function keysReady(db: Database, table: BackfillTable): boolean {
  let ready = known.get(db)
  if (ready?.has(table)) return true
  const complete =
    db
      .query<{ complete: number }, [string]>(
        `SELECT complete FROM ${KEY_BACKFILL} WHERE table_name=?`,
      )
      .get(table)?.complete === 1
  if (complete) {
    if (!ready) known.set(db, (ready = new Set()))
    ready.add(table)
  }
  return complete
}

/** Test and tooling hook: forget what a connection has cached. */
export function forgetKeysReady(db: Database) {
  known.delete(db)
}

/** `plan_id=?` as the table's integer key when keys are complete; the bound parameter is unchanged. */
export function planIs(db: Database, table: BackfillTable, column = "plan_id", alias?: string) {
  const prefix = alias ? `${alias}.` : ""
  return keysReady(db, table)
    ? `${prefix}plan_n=(SELECT n FROM ${PLAN_KEYS} WHERE plan_id=?)`
    : `${prefix}${column}=?`
}

/** `attempt_id=?` for `runner_progress`, same rule as `planIs`. */
export function attemptIs(db: Database, alias?: string) {
  const prefix = alias ? `${alias}.` : ""
  return keysReady(db, "runner_progress")
    ? `${prefix}attempt_n=(SELECT n FROM ${ATTEMPT_KEYS} WHERE attempt_id=?)`
    : `${prefix}attempt_id=?`
}

/**
 * Mark a table complete once its keys and integer indexes exist. The caller holds the
 * transaction. Returns whether the table is complete.
 */
export function completeKeys(db: Database, table: BackfillTable): boolean {
  if (!backfillState(db, table).backfilled || missingKeyIndexes(db, table).length) return false
  db.query(`UPDATE ${KEY_BACKFILL} SET complete=1 WHERE table_name=?`).run(table)
  return true
}
