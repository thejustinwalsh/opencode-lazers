import type { Database } from "bun:sqlite"

/**
 * A projection's dirty queue: one row per source key (`ref`) whose projection rows are stale.
 * Guarded triggers on the source tables queue refs with {@link queueRef} or {@link queueRefs}: an
 * existing entry is reset (a new change ends a parked entry's backoff), a missing one inserted;
 * {@link drainQueue} refreshes them inside a write transaction.
 *
 * Never `INSERT OR REPLACE` in a trigger body: SQLite applies the outer statement's conflict
 * handling to the statements of the triggers it fires, so an outer upsert (`ON CONFLICT DO
 * UPDATE`) turns the replace into a failing insert and the writer's statement fails. The update,
 * then insert-if-missing form never conflicts.
 *
 * ```
 * source write ─trigger─► queue(ref, next_at=0) ─drain (same transaction)─► projection rows
 *                                    │ refresh throws
 *                                    └─► stays queued: attempts+1, error, next_at = now + backoff
 * ```
 *
 * A throwing refresh is rolled back to its savepoint; the entry stays with its error and a later
 * `next_at`, so later writes skip it (the probe reads only due entries) and the owner retries it
 * when it comes due. Nothing is dropped.
 */
export function queueTableSQL(table: string) {
  return `
    CREATE TABLE IF NOT EXISTS ${table} (
      ref TEXT PRIMARY KEY,
      next_at INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS ${table}_due ON ${table}(next_at);
  `
}

/** The statements a trigger body uses to queue `ref` (an SQL expression). */
export const queueRef = (table: string, ref: string) =>
  `UPDATE ${table} SET next_at=0,attempts=0,error=NULL WHERE ref=${ref};
   INSERT INTO ${table}(ref) SELECT ${ref} WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE ref=${ref});`

/** The statements a trigger body uses to queue every `ref` a SELECT returns (its column named `ref`). */
export const queueRefs = (table: string, select: string) =>
  `UPDATE ${table} SET next_at=0,attempts=0,error=NULL WHERE ref IN (SELECT ref FROM (${select}));
   INSERT INTO ${table}(ref) SELECT DISTINCT s.ref FROM (${select}) s
     WHERE NOT EXISTS (SELECT 1 FROM ${table} q WHERE q.ref=s.ref);`

/** The probe the drain hook runs in every write transaction: one index seek. */
export const dueProbeSQL = (table: string) => `SELECT 1 FROM ${table} WHERE next_at<=? LIMIT 1`

export type QueueDrain = {
  handled: number
  /** Entries still queued and due (parked entries that are not due yet are not counted). */
  remaining: number
  failed: { ref: string; error: string }[]
}

const BACKOFF_FIRST_MS = 1000
const BACKOFF_CEILING_MS = 5 * 60_000

/**
 * Refresh due entries in the caller's write transaction, at most `budget` of them (a unit of
 * work, not a cap: the rest stay queued for the owner's next transaction).
 */
export function drainQueue(
  db: Database,
  table: string,
  refresh: (db: Database, ref: string) => void,
  options: { budget: number; now?: number },
): QueueDrain {
  const now = options.now ?? Date.now()
  const refs = db
    .query<{ ref: string; attempts: number }, [number, number]>(
      `SELECT ref,attempts FROM ${table} WHERE next_at<=? ORDER BY next_at,ref LIMIT ?`,
    )
    .all(now, options.budget)
  const failed: QueueDrain["failed"] = []
  const done = db.query(`DELETE FROM ${table} WHERE ref=?`)
  const park = db.query(`UPDATE ${table} SET attempts=?,error=?,next_at=? WHERE ref=?`)
  for (const { ref, attempts } of refs) {
    db.exec("SAVEPOINT projection_entry")
    try {
      refresh(db, ref)
      db.exec("RELEASE projection_entry")
      done.run(ref)
    } catch (error) {
      db.exec("ROLLBACK TO projection_entry; RELEASE projection_entry")
      const message = error instanceof Error ? error.message : String(error)
      park.run(
        attempts + 1,
        message.slice(0, 500),
        now + Math.min(BACKOFF_FIRST_MS * 2 ** attempts, BACKOFF_CEILING_MS),
        ref,
      )
      failed.push({ ref, error: message })
    }
  }
  const remaining = db
    .query<{ n: number }, [number]>(`SELECT COUNT(*) AS n FROM ${table} WHERE next_at<=?`)
    .get(now)!.n
  return { handled: refs.length, remaining, failed }
}

/** The earliest time a parked entry comes due, or undefined when none is parked. */
export function nextDueAt(db: Database, table: string, now = Date.now()): number | undefined {
  return (
    db
      .query<{ at: number | null }, [number]>(
        `SELECT MIN(next_at) AS at FROM ${table} WHERE next_at>?`,
      )
      .get(now)?.at ?? undefined
  )
}
