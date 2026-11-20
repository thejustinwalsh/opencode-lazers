import type { Database } from "bun:sqlite"
import { DISPLAY_VERSION, progressDisplay, type DisplayRow } from "./display.ts"

/**
 * `runner_progress_display`: what the live history list shows of each progress row, stored beside
 * it so a reader needs no payload. One narrow row per progress row, keyed by its `seq`, written
 * in the transaction that writes the progress row from {@link progressDisplay}, the same pure
 * function the read-time projection uses. Narrow on purpose: a reader scans these rows and never
 * the wide `runner_progress` rows (a payload is about 2 KB and can spill to overflow pages).
 *
 * ```
 * recorder ── INSERT/UPDATE runner_progress ──► refreshProgressDisplay(seq) ──► display row
 * retention ── DELETE runner_progress ─────────► trigger ───────────────────► display row gone
 * legacy rows (before this table) ── backfill ──► display row           (see display-backfill.ts)
 * ```
 */
export const PROGRESS_DISPLAY_TABLE = "runner_progress_display"

export function installProgressDisplaySchema(db: Database) {
  // Derived data: a table from before the project id and version columns is dropped and rebuilt
  // (the backfill refills it).
  const columns = db
    .query<{ name: string }, []>("PRAGMA table_info(runner_progress_display)")
    .all()
    .map((column) => column.name)
  if (columns.length > 0 && !(columns.includes("version") && columns.includes("project_id")))
    db.exec("DROP TABLE runner_progress_display")
  db.exec(`
    CREATE TABLE IF NOT EXISTS runner_progress_display (
      seq INTEGER PRIMARY KEY,
      project_directory TEXT NOT NULL, project_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL, session_id TEXT NOT NULL,
      at REAL NOT NULL, recorded_at REAL,
      kind TEXT NOT NULL, source TEXT NOT NULL, message_id TEXT, call_id TEXT,
      tool TEXT, status TEXT, agent TEXT, result TEXT, error TEXT,
      route_provider TEXT, route_model TEXT, route_variant TEXT,
      file_targets_json TEXT, observations_json TEXT NOT NULL,
      payload_available INTEGER NOT NULL, version INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runner_progress_display_attempt
      ON runner_progress_display(project_directory,attempt_id,session_id,seq,at,tool,project_id);
    CREATE TRIGGER IF NOT EXISTS runner_progress_display_deleted
    AFTER DELETE ON runner_progress BEGIN
      DELETE FROM runner_progress_display WHERE seq=OLD.seq;
    END;
  `)
}

/** The stored columns the display is derived from, and the keys it is filed under. */
export type StoredProgress = DisplayRow & {
  project_directory: string
  project_id: string
  attempt_id: string
  session_id: string
}

export function writeProgressDisplay(db: Database, row: StoredProgress) {
  const display = progressDisplay(row)
  db.query(
    `INSERT OR REPLACE INTO runner_progress_display
     (seq,project_directory,project_id,attempt_id,session_id,at,recorded_at,kind,source,message_id,call_id,
      tool,status,agent,result,error,route_provider,route_model,route_variant,
      file_targets_json,observations_json,payload_available,version)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.seq,
    row.project_directory,
    row.project_id,
    row.attempt_id,
    row.session_id,
    row.at,
    row.recorded_at,
    display.kind,
    display.source,
    display.messageID,
    display.callID,
    display.tool,
    display.status,
    display.agent,
    display.result,
    display.error,
    display.route?.providerID ?? null,
    display.route?.modelID ?? null,
    display.route?.variant ?? null,
    display.fileTargets ? JSON.stringify(display.fileTargets) : null,
    JSON.stringify(display.observations),
    display.payloadAvailable ? 1 : 0,
    DISPLAY_VERSION,
  )
}

const STORED_COLUMNS =
  "seq,project_directory,project_id,attempt_id,session_id,at,recorded_at,source,kind,event_ids_json,call_id,message_id,payload"

/** Recompute one row's display from the progress row as stored; false when the row is gone. */
export function refreshProgressDisplay(db: Database, seq: number): boolean {
  const row = db
    .query<StoredProgress, [number]>(`SELECT ${STORED_COLUMNS} FROM runner_progress WHERE seq=?`)
    .get(seq)
  if (!row) return false
  writeProgressDisplay(db, row)
  return true
}
