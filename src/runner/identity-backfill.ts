import type { Database } from "bun:sqlite"
import { ATTEMPT_KEYS, KEY_BACKFILL, PLAN_KEYS } from "./identity-keys.ts"

/**
 * Paged backfill of the integer keys on rows written before the key columns existed. One page is
 * one transaction over a rowid range; the retention pass runs pages until its time slice is used
 * (`RetentionService.backfillKeys`), so no transaction at startup or at any time touches more than
 * a page. The cursor is a rowid, so a page costs the same however far along the table is.
 */
export type BackfillTable = "runner_transitions" | "runner_progress"

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

/** Rows per page: see `.agents/plans/database-design.md` for the measured cost per page. */
export const BACKFILL_PAGE_ROWS = 1_000

export type BackfillState = {
  cursor: number
  rowsDone: number
  backfilled: boolean
  complete: boolean
}

export function backfillState(db: Database, table: BackfillTable): BackfillState {
  const row = db
    .query<{ cursor: number; rows_done: number; backfilled: number; complete: number }, [string]>(
      `SELECT cursor,rows_done,backfilled,complete FROM ${KEY_BACKFILL} WHERE table_name=?`,
    )
    .get(table)
  return {
    cursor: row?.cursor ?? 0,
    rowsDone: row?.rows_done ?? 0,
    backfilled: row?.backfilled === 1,
    complete: row?.complete === 1,
  }
}

export type BackfillPage = { rows: number; done: boolean }

/**
 * Key one page of rows. The caller holds the transaction. Rows already keyed (written by a
 * keyed writer, or by the insert trigger) are skipped by `IS NULL`; a page of them updates
 * nothing and only advances the cursor.
 */
export function backfillPage(
  db: Database,
  table: BackfillTable,
  pageRows = BACKFILL_PAGE_ROWS,
): BackfillPage {
  const state = backfillState(db, table)
  if (state.backfilled) return { rows: 0, done: true }
  const { rowid, keys } = TABLES[table]
  const high = db
    .query<{ high: number | null }, [number, number]>(
      `SELECT max(${rowid}) AS high FROM (SELECT ${rowid} FROM ${table} WHERE ${rowid}>? ORDER BY ${rowid} LIMIT ?)`,
    )
    .get(state.cursor, pageRows)?.high
  if (high === null || high === undefined) {
    db.query(
      `INSERT INTO ${KEY_BACKFILL}(table_name,cursor,rows_done,backfilled) VALUES(?,?,?,1)
       ON CONFLICT(table_name) DO UPDATE SET backfilled=1`,
    ).run(table, state.cursor, state.rowsDone)
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
