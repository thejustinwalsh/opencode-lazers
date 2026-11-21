import type { Database } from "bun:sqlite"
import {
  BACKFILL_PAGE_ROWS,
  BACKFILL_TABLES,
  backfillPage,
  backfillState,
  rowidOf,
  transitionKeys,
  type BackfillTable,
} from "./identity-backfill.ts"
import { KEY_BACKFILL } from "./identity-keys.ts"
import {
  createKeyIndexes,
  ensureKeyIndexes,
  missingKeyIndexes,
  remainingTextKeyIndexes,
  retireTextKeyIndex,
} from "./transition-indexes.ts"

/**
 * Drives each history table through the `identityKeys` lifecycle, online and resumable:
 *
 * | State          | Step taken here                                                    | Leaves when                  |
 * | -------------- | ------------------------------------------------------------------ | ---------------------------- |
 * | `backfilling`  | key one page of 1,000 rows per transaction                         | the cursor passes the last row |
 * | `indexing`     | build the integer indexes (a worker for a large table)             | every integer index exists   |
 * | `keyed`        | drop one text-id index per transaction                             | no text-id index is left     |
 * | `text-retired` | nothing                                                            | never                        |
 *
 * Every step is a short transaction and the stored state is the resume point, so a restart, a
 * reload or a busy writer only delays it. Nothing here stops the product or needs the owner.
 */

type Repository = {
  readonly path: string
  read<T>(run: (db: Database) => T): T
  atomic<T>(run: (db: Database) => T): T
}

const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

export type IdentityKeysProgress = {
  /** Rows keyed by this call. */
  rows: number
  /** Text-id indexes dropped by this call. */
  retired: string[]
  /** Every table is `text-retired`: later calls have nothing to do. */
  finished: boolean
}

/** Advance every table as far as the time budget allows. */
export async function advanceIdentityKeys(
  repository: Repository,
  budgetMs: number,
  options: {
    workerURL?: URL
    inlineRowLimit?: number
    /** Build indexes and drop text indexes; false while attempts run (backfill pages only). */
    structural?: boolean
  } = {},
): Promise<IdentityKeysProgress> {
  const { structural = true, ...indexOptions } = options
  const started = Date.now()
  const within = () => Date.now() - started < budgetMs
  let rows = 0
  const retired: string[] = []
  for (const table of BACKFILL_TABLES) {
    while (within() && repository.read((db) => backfillState(db, table).state) === "backfilling") {
      const page = repository.atomic((db) => backfillPage(db, table, BACKFILL_PAGE_ROWS))
      rows += page.rows
      await yieldTurn()
    }
    if (!structural) continue
    if (repository.read((db) => backfillState(db, table).state) === "indexing") {
      await ensureKeyIndexes(repository, table, indexOptions)
      repository.atomic((db) => {
        if (backfillState(db, table).state === "indexing" && !missingKeyIndexes(db, table).length)
          transitionKeys(db, table, "keyed")
      })
    }
    while (within() && repository.read((db) => backfillState(db, table).state) === "keyed") {
      const dropped = repository.atomic((db) => {
        const name = retireTextKeyIndex(db, table)
        if (!name) transitionKeys(db, table, "text-retired")
        return name
      })
      if (dropped) retired.push(dropped)
      await yieldTurn()
    }
  }
  return { rows, retired, finished: identityKeysFinished(repository) }
}

export const identityKeysFinished = (repository: Pick<Repository, "read">) =>
  repository.read((db) =>
    BACKFILL_TABLES.every((table) => backfillState(db, table).state === "text-retired"),
  )

/**
 * At schema install, inside its transaction: every table gets its state row, and an empty table
 * (a new database) goes straight through the lifecycle, so it never carries a text-id index and
 * its readers take the integer keys from the first statement.
 */
export function installIdentityState(db: Database) {
  for (const table of BACKFILL_TABLES) {
    db.query(`INSERT OR IGNORE INTO ${KEY_BACKFILL}(table_name) VALUES(?)`).run(table)
    if (backfillState(db, table).state !== "backfilling") continue
    const any = db
      .query<{ one: number }, []>(
        `SELECT 1 AS one FROM ${table} ORDER BY ${rowidOf(table)} LIMIT 1`,
      )
      .get()
    if (any) continue
    settleEmpty(db, table)
  }
}

function settleEmpty(db: Database, table: BackfillTable) {
  backfillPage(db, table)
  createKeyIndexes(db, table)
  transitionKeys(db, table, "keyed")
  while (remainingTextKeyIndexes(db, table).length) retireTextKeyIndex(db, table)
  transitionKeys(db, table, "text-retired")
}
