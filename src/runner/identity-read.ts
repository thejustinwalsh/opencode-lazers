import type { Database } from "bun:sqlite"
import type { BackfillTable } from "./identity-backfill.ts"
import { ATTEMPT_KEYS, PLAN_KEYS } from "./identity-keys.ts"
import { keysTaken } from "./transition-indexes.ts"

/**
 * How a reader chooses between the text id columns and the integer keys.
 *
 * The rule is the table's migration state (`lazers_key_backfill.state`, moved by the
 * `identityKeys` machine), not a COALESCE: a predicate like `plan_n=K OR (plan_n IS NULL AND
 * plan_id=?)` cannot use one index for the lookup and the ordering at once and would keep the
 * text indexes in every plan. A table is `keyed` only when every row has its keys (the paged
 * backfill has passed the last row and the insert trigger keys any row written since) and the
 * integer indexes exist. Until then a reader runs the statement it always ran; afterwards the
 * same statement with the predicate swapped, taking the same bound parameters. The state never
 * goes back, so a true answer is cached for the life of the connection.
 *
 * The text columns stay in both states: result columns keep naming them, and the triggers key new
 * rows from them. Only predicates move.
 */
const known = new WeakMap<Database, Set<BackfillTable>>()

export function keysReady(db: Database, table: BackfillTable): boolean {
  let ready = known.get(db)
  if (ready?.has(table)) return true
  let taken = false
  try {
    taken = keysTaken(db, table)
  } catch {
    // A connection opened before the runner schema exists reads the text columns.
    return false
  }
  if (taken) {
    if (!ready) known.set(db, (ready = new Set()))
    ready.add(table)
  }
  return taken
}

/** Test and tooling hook: forget what a connection has cached. */
export function forgetKeysReady(db: Database) {
  known.delete(db)
}

const qualified = (alias: string | undefined, column: string) =>
  alias ? `${alias}.${column}` : column

/**
 * `plan_id=<value>` on a history table, as its integer key once the table is keyed. `value` is
 * `?` (the bound parameter is unchanged) or a column of another table in a join.
 */
export function planIs(db: Database, table: BackfillTable, alias?: string, value = "?") {
  return keysReady(db, table)
    ? `${qualified(alias, "plan_n")}=(SELECT n FROM ${PLAN_KEYS} WHERE plan_id=${value})`
    : `${qualified(alias, "plan_id")}=${value}`
}

/** `plan_id IN (<list>)`, same rule as `planIs`. */
export function planIn(db: Database, table: BackfillTable, list: string, alias?: string) {
  return keysReady(db, table)
    ? `${qualified(alias, "plan_n")} IN (SELECT n FROM ${PLAN_KEYS} WHERE plan_id IN (${list}))`
    : `${qualified(alias, "plan_id")} IN (${list})`
}

/** `attempt_id=<value>` on `runner_progress`, same rule as `planIs`. */
export function attemptIs(db: Database, alias?: string, value = "?") {
  return keysReady(db, "runner_progress")
    ? `${qualified(alias, "attempt_n")}=(SELECT n FROM ${ATTEMPT_KEYS} WHERE attempt_id=${value})`
    : `${qualified(alias, "attempt_id")}=${value}`
}

/** `attempt_id IN (<list>)` on `runner_progress`, same rule as `planIs`. */
export function attemptIn(db: Database, list: string, alias?: string) {
  return keysReady(db, "runner_progress")
    ? `${qualified(alias, "attempt_n")} IN (SELECT n FROM ${ATTEMPT_KEYS} WHERE attempt_id IN (${list}))`
    : `${qualified(alias, "attempt_id")} IN (${list})`
}

/**
 * A join of a history table to the row that names its plan (`other` is that row's plan id, such
 * as `p.id`). Keyed, it states the join both ways: the integer key lets the planner drive from the
 * plan into the history table's integer index, and the text equality still lets it drive from the
 * history row into the plan's primary key. Both are true of every row, so the result is the same.
 */
export function planJoin(db: Database, table: BackfillTable, alias: string, other: string) {
  const text = `${other}=${alias}.plan_id`
  return keysReady(db, table) ? `${planIs(db, table, alias, other)} AND ${text}` : text
}

/** Two rows of one history table on the same plan: the integer keys once keyed, else the text. */
export function samePlan(db: Database, table: BackfillTable, alias: string, other: string) {
  return keysReady(db, table)
    ? `${alias}.plan_n=${other}.plan_n`
    : `${alias}.plan_id=${other}.plan_id`
}
