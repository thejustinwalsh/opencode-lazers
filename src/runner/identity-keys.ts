import type { Database } from "bun:sqlite"

/**
 * Integer identity for plans and attempts. The two largest history tables
 * (`runner_transitions`, `runner_progress`) repeat 36 to 44 byte text ids on every row; they
 * reference these small dimension tables by integer instead (see `.agents/plans/database-design.md`,
 * "Integer identity"). A key is written when the id is first seen by a writer and never changes.
 */
export const PLAN_KEYS = "lazers_plan_keys"
export const ATTEMPT_KEYS = "lazers_attempt_keys"
export const KEY_BACKFILL = "lazers_key_backfill"

export const IDENTITY_KEY_TABLES = [PLAN_KEYS, ATTEMPT_KEYS, KEY_BACKFILL] as const

export function installIdentityKeys(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${PLAN_KEYS} (n INTEGER PRIMARY KEY, plan_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS ${ATTEMPT_KEYS} (n INTEGER PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS ${KEY_BACKFILL} (
      table_name TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0,
      rows_done INTEGER NOT NULL DEFAULT 0, indexed INTEGER NOT NULL DEFAULT 0,
      complete INTEGER NOT NULL DEFAULT 0
    );
  `)
}

/**
 * Keys for every plan and attempt row that exists, and triggers that key each new one in the
 * insert's own transaction, so an id has a key from the moment it is first seen, whichever writer
 * (or still-loaded older copy) created it. Both tables hold thousands of rows, not hundreds of
 * thousands, so this is a small statement at install time.
 */
export function installOwnerKeys(db: Database) {
  db.exec(`
    INSERT OR IGNORE INTO ${PLAN_KEYS}(plan_id) SELECT id FROM runner_plans ORDER BY rowid;
    INSERT OR IGNORE INTO ${ATTEMPT_KEYS}(attempt_id) SELECT id FROM runner_attempts ORDER BY rowid;
    CREATE TRIGGER IF NOT EXISTS runner_plans_key AFTER INSERT ON runner_plans BEGIN
      INSERT OR IGNORE INTO ${PLAN_KEYS}(plan_id) VALUES(NEW.id);
    END;
    CREATE TRIGGER IF NOT EXISTS runner_attempts_key AFTER INSERT ON runner_attempts BEGIN
      INSERT OR IGNORE INTO ${ATTEMPT_KEYS}(attempt_id) VALUES(NEW.id);
    END;
  `)
}

/**
 * The key of an id, created on first sight. `ON CONFLICT DO NOTHING RETURNING` yields a row only
 * when the insert happened; an existing key is read by the unique index. The caller holds the
 * writer's transaction, so the key and the row that uses it commit together.
 */
function keyOf(db: Database, table: string, column: string, id: string): number {
  const inserted = db
    .query<{ n: number }, [string]>(
      `INSERT INTO ${table}(${column}) VALUES(?) ON CONFLICT DO NOTHING RETURNING n`,
    )
    .get(id)
  if (inserted) return inserted.n
  return db.query<{ n: number }, [string]>(`SELECT n FROM ${table} WHERE ${column}=?`).get(id)!.n
}

export const planKey = (db: Database, planID: string) => keyOf(db, PLAN_KEYS, "plan_id", planID)
export const attemptKey = (db: Database, attemptID: string) =>
  keyOf(db, ATTEMPT_KEYS, "attempt_id", attemptID)
