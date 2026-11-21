import type { Database } from "bun:sqlite"
import { ATTEMPT_KEYS, KEY_BACKFILL, PLAN_KEYS } from "./identity-keys.ts"
import { lifecycleTransition } from "./lifecycle-machines.ts"

/**
 * Paged backfill of the integer keys on rows written before the key columns existed, and the
 * per-table migration state that readers and index builders follow.
 *
 * ```
 * backfilling ──last row keyed──► indexing ──integer indexes exist──► keyed ──text indexes dropped──► text-retired
 *   readers: text predicate          text predicate                    integer predicate    integer predicate
 * ```
 *
 * One page is one transaction over a rowid range; the retention pass runs pages until its time
 * slice is used (`advanceIdentityKeys`), so no transaction at startup or at any time touches more
 * than a page. The cursor is a rowid, so a page costs the same however far along the table is.
 * The state moves only through the `identityKeys` lifecycle machine.
 */
export type BackfillTable = "runner_transitions" | "runner_progress"
export type IdentityKeysState = "backfilling" | "indexing" | "keyed" | "text-retired"

const TABLES: Record<
  BackfillTable,
  { rowid: string; keys: Array<{ column: string; source: string; keyTable: string; text: string }> }
> = {
  runner_transitions: {
    rowid: "id",
    keys: [{ column: "plan_n", source: "plan_id", keyTable: PLAN_KEYS, text: "plan_id" }],
  },
  runner_progress: {
    rowid: "seq",
    keys: [
      { column: "plan_n", source: "plan_id", keyTable: PLAN_KEYS, text: "plan_id" },
      { column: "attempt_n", source: "attempt_id", keyTable: ATTEMPT_KEYS, text: "attempt_id" },
    ],
  },
}

export const BACKFILL_TABLES = Object.keys(TABLES) as BackfillTable[]
export const rowidOf = (table: BackfillTable) => TABLES[table].rowid

/**
 * Rows per page. Measured by `scripts/measure-integer-keys.ts` on a live-shaped fixture: a page
 * of 1,000 transitions or progress rows commits in a few milliseconds, so the writer waits at
 * most that long behind one.
 */
export const BACKFILL_PAGE_ROWS = 1_000

export type BackfillState = { state: IdentityKeysState; cursor: number; rowsDone: number }

export function backfillState(db: Database, table: BackfillTable): BackfillState {
  const row = db
    .query<{ state: IdentityKeysState; cursor: number; rows_done: number }, [string]>(
      `SELECT state,cursor,rows_done FROM ${KEY_BACKFILL} WHERE table_name=?`,
    )
    .get(table)
  return {
    state: row?.state ?? "backfilling",
    cursor: row?.cursor ?? 0,
    rowsDone: row?.rows_done ?? 0,
  }
}

/** Move a table's migration state by one machine event; the caller holds the transaction. */
export function transitionKeys(
  db: Database,
  table: BackfillTable,
  event: Exclude<IdentityKeysState, "backfilling">,
): IdentityKeysState {
  const next = lifecycleTransition("identityKeys", backfillState(db, table).state, event)
  db.query(
    `INSERT INTO ${KEY_BACKFILL}(table_name,state) VALUES(?,?)
     ON CONFLICT(table_name) DO UPDATE SET state=excluded.state`,
  ).run(table, next)
  return next as IdentityKeysState
}

export type BackfillPage = { rows: number; done: boolean }

/**
 * Key one page of rows. The caller holds the transaction. Rows already keyed (written by a
 * keyed writer, or by the insert trigger) are skipped by `IS NULL`; a page of them updates
 * nothing and only advances the cursor. Past the last row the table moves to `indexing`: the
 * insert trigger keys every row written from then on, so no NULL key can appear behind it.
 */
export function backfillPage(
  db: Database,
  table: BackfillTable,
  pageRows = BACKFILL_PAGE_ROWS,
): BackfillPage {
  const state = backfillState(db, table)
  if (state.state !== "backfilling") return { rows: 0, done: true }
  const { rowid, keys } = TABLES[table]
  const high = db
    .query<{ high: number | null }, [number, number]>(
      `SELECT max(${rowid}) AS high FROM (SELECT ${rowid} FROM ${table} WHERE ${rowid}>? ORDER BY ${rowid} LIMIT ?)`,
    )
    .get(state.cursor, pageRows)?.high
  if (high === null || high === undefined) {
    transitionKeys(db, table, "indexing")
    return { rows: 0, done: true }
  }
  const anyNull = keys.map((key) => `${key.column} IS NULL`).join(" OR ")
  for (const key of keys)
    db.query(
      `INSERT OR IGNORE INTO ${key.keyTable}(${key.text})
       SELECT DISTINCT ${key.source} FROM ${table}
        WHERE ${rowid}>? AND ${rowid}<=? AND (${anyNull})`,
    ).run(state.cursor, high)
  const assignments = keys
    .map(
      (key) =>
        `${key.column}=COALESCE(${key.column},(SELECT n FROM ${key.keyTable} WHERE ${key.text}=${table}.${key.source}))`,
    )
    .join(",")
  const { changes } = db
    .query(`UPDATE ${table} SET ${assignments} WHERE ${rowid}>? AND ${rowid}<=? AND (${anyNull})`)
    .run(state.cursor, high)
  db.query(
    `INSERT INTO ${KEY_BACKFILL}(table_name,cursor,rows_done) VALUES(?,?,?)
     ON CONFLICT(table_name) DO UPDATE SET cursor=excluded.cursor,rows_done=excluded.rows_done`,
  ).run(table, high, state.rowsDone + changes)
  return { rows: changes, done: false }
}
