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
      rows_done INTEGER NOT NULL DEFAULT 0, backfilled INTEGER NOT NULL DEFAULT 0,
      complete INTEGER NOT NULL DEFAULT 0
    );
  `)
}

const hasColumn = (db: Database, table: string, column: string) =>
  db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column)

/**
 * Nullable integer key columns on the two history tables. Adding a column rewrites nothing, so
 * this is cheap on any size. A row inserted without its keys (an older copy still loaded, or a
 * raw insert) gets them from an AFTER INSERT trigger in the same transaction, so after the
 * backfill has passed no NULL key is ever left behind. Writers that know the key write it in the
 * insert and the trigger does not fire.
 */
export function installKeyColumns(db: Database) {
  const columns: Array<[table: string, column: string]> = [
    ["runner_transitions", "plan_n"],
    ["runner_progress", "plan_n"],
    ["runner_progress", "attempt_n"],
  ]
  for (const [table, column] of columns)
    if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER`)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS runner_transitions_keys AFTER INSERT ON runner_transitions
    WHEN NEW.plan_n IS NULL BEGIN
      INSERT OR IGNORE INTO ${PLAN_KEYS}(plan_id) VALUES(NEW.plan_id);
      UPDATE runner_transitions SET plan_n=(SELECT n FROM ${PLAN_KEYS} WHERE plan_id=NEW.plan_id)
       WHERE id=NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS runner_progress_keys AFTER INSERT ON runner_progress
    WHEN NEW.plan_n IS NULL OR NEW.attempt_n IS NULL BEGIN
      INSERT OR IGNORE INTO ${PLAN_KEYS}(plan_id) VALUES(NEW.plan_id);
      INSERT OR IGNORE INTO ${ATTEMPT_KEYS}(attempt_id) VALUES(NEW.attempt_id);
      UPDATE runner_progress SET plan_n=(SELECT n FROM ${PLAN_KEYS} WHERE plan_id=NEW.plan_id),
             attempt_n=(SELECT n FROM ${ATTEMPT_KEYS} WHERE attempt_id=NEW.attempt_id)
       WHERE seq=NEW.seq;
    END;
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
 * The key of an id, created on first sight: a read of the unique index in the common case, an
 * insert only for a new id. The caller holds the writer's transaction, so the key and the row that
 * uses it commit together.
 */
function keyOf(db: Database, table: string, column: string, id: string): number {
  const known = db
    .query<{ n: number }, [string]>(`SELECT n FROM ${table} WHERE ${column}=?`)
    .get(id)
  if (known) return known.n
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
