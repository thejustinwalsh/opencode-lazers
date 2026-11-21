import type { Database } from "bun:sqlite"
import { schemaModules } from "../database-schema.ts"
import { ensureProjectionStateSchema, resetProjectionState } from "../projections/lifecycle.ts"
import type { ProjectionSpec } from "../projections/owner.ts"
import type { TaskRepository } from "../storage.ts"

/**
 * `native_tool_call_display`: what the Radar shows of each canonical tool call, one narrow row per
 * `native_tool_calls` row (82,327 live, wide: `payload`, `sources_json`, `event_ids_json`), so a
 * stream reads a session's calls through one index and never a payload.
 *
 * ```
 * recorder ── INSERT/UPDATE native_tool_calls ──► trigger ──► display row (same statement)
 * retention ── DELETE native_tool_calls ────────► trigger ──► display row gone
 * rows from before this table ── backfill, newest first ──► display rows
 * ```
 *
 * The display is the SQL the live read ran per read (`LiveReadStore.nativeCalls` and
 * `toolDetails`, `src/observability/live-store.ts`): the call id, status, a 200-character detail
 * and a 240-character error, extracted from the payload. Kept by triggers, so every writer of the
 * wide table (the recorder's insert, merge and identity promotion, project-key backfill,
 * retention) keeps it current with no code of its own. The row's `id` is the call's rowid, which
 * an identity promotion keeps, so a stream updates the row in place.
 */
const MODULE = schemaModules["native-call-display"]
export const NATIVE_CALL_DISPLAY = "native-call-display"

/** Bump when the derived columns change: the backfill rewrites every row. */
const NATIVE_CALL_DISPLAY_GENERATION = 1

const COLUMNS =
  "id,project_directory,session_id,identity_kind,invocation_id,call_id,detail_call_id,message_id,agent,tool,attempt_id,status,detail,error,first_observed_at,last_observed_at"

/** The display of a `native_tool_calls` row named `row` (NEW in a trigger, the table in a page). */
const derived = (row: string) => `${row}.rowid,${row}.project_directory,${row}.session_id,
  ${row}.identity_kind,${row}.invocation_id,COALESCE(${row}.native_call_id,${row}.invocation_id),
  COALESCE(${row}.native_call_id,${row}.context_call_id,${row}.invocation_id),${row}.message_id,
  ${row}.agent,${row}.tool,${row}.attempt_id,json_extract(${row}.payload,'$.status'),
  substr(json_extract(${row}.payload,'$.detail'),1,200),
  substr(json_extract(${row}.payload,'$.error.message'),1,240),
  ${row}.first_observed_at,${row}.last_observed_at`

const TABLE_SQL = `
  CREATE TABLE native_tool_call_display (
    id INTEGER PRIMARY KEY,
    project_directory TEXT NOT NULL, session_id TEXT NOT NULL,
    identity_kind TEXT NOT NULL, invocation_id TEXT NOT NULL,
    call_id TEXT NOT NULL, detail_call_id TEXT NOT NULL,
    message_id TEXT, agent TEXT, tool TEXT, attempt_id TEXT,
    status TEXT, detail TEXT, error TEXT,
    first_observed_at INTEGER NOT NULL, last_observed_at INTEGER NOT NULL
  );
  CREATE INDEX native_tool_call_display_session
    ON native_tool_call_display(project_directory, session_id, first_observed_at DESC, id);
`

const WATCHED =
  "project_directory,session_id,identity_kind,invocation_id,native_call_id,context_call_id,message_id,agent,tool,attempt_id,first_observed_at,last_observed_at,payload"

const TRIGGERS_SQL = `
  CREATE TRIGGER native_tool_call_display_insert AFTER INSERT ON native_tool_calls BEGIN
    INSERT OR REPLACE INTO native_tool_call_display(${COLUMNS}) SELECT ${derived("NEW")};
  END;
  CREATE TRIGGER native_tool_call_display_update AFTER UPDATE OF ${WATCHED} ON native_tool_calls BEGIN
    INSERT OR REPLACE INTO native_tool_call_display(${COLUMNS}) SELECT ${derived("NEW")};
  END;
  CREATE TRIGGER native_tool_call_display_delete AFTER DELETE ON native_tool_calls BEGIN
    DELETE FROM native_tool_call_display WHERE id=OLD.rowid;
  END;
`
const TRIGGERS = [
  "native_tool_call_display_insert",
  "native_tool_call_display_update",
  "native_tool_call_display_delete",
]

/** The table and triggers, rebuilt from nothing; the backfill refills the rows. */
function installNativeCallDisplaySchema(db: Database) {
  for (const name of TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${name}`)
  db.exec("DROP TABLE IF EXISTS native_tool_call_display")
  db.exec(TABLE_SQL)
  resetProjectionState(db, NATIVE_CALL_DISPLAY)
  db.exec(TRIGGERS_SQL)
}

/** Install through the module registry; needs `native_tool_calls` (the runner schema) first. */
export function ensureNativeCallDisplaySchema(repository: TaskRepository) {
  ensureProjectionStateSchema(repository)
  repository.installSchema("native-call-display", MODULE.generation, MODULE.tables, (db) =>
    installNativeCallDisplaySchema(db),
  )
}

/**
 * Calls per backfill page. Each reads its call's payload once. Measured on the live-sized copy
 * (82,525 calls): 166 pages, median 5.6 ms, slowest 38 ms, 1.3 s in all.
 */
export const NATIVE_CALL_PAGE_ROWS = 500

/**
 * Newest calls first, so a session's recent calls appear before its old ones. The watermark is the
 * lowest rowid done (0 before the first page, which starts above the newest call); rows written
 * since the backfill started have their display from the triggers already.
 */
export const nativeCallDisplayProjection: ProjectionSpec = {
  name: NATIVE_CALL_DISPLAY,
  generation: NATIVE_CALL_DISPLAY_GENERATION,
  backfill: [
    {
      name: "calls",
      page(db, _scope, after) {
        const below =
          after > 0
            ? after
            : (db
                .query<{ id: number | null }, []>("SELECT MAX(rowid) AS id FROM native_tool_calls")
                .get()?.id ?? 0) + 1
        const lowest = db
          .query<{ id: number | null; n: number }, [number, number]>(
            `SELECT MIN(rowid) AS id, COUNT(*) AS n FROM
               (SELECT rowid FROM native_tool_calls WHERE rowid<? ORDER BY rowid DESC LIMIT ?)`,
          )
          .get(below, NATIVE_CALL_PAGE_ROWS)!
        if (lowest.id !== null)
          db.query(
            `INSERT OR REPLACE INTO native_tool_call_display(${COLUMNS})
             SELECT ${derived("native_tool_calls")} FROM native_tool_calls WHERE rowid>=? AND rowid<?`,
          ).run(lowest.id, below)
        const done = lowest.n < NATIVE_CALL_PAGE_ROWS || lowest.id === 1
        // A watermark of 1 means "nothing below": the next page (if any) would start at 0 again.
        return { next: lowest.id ?? 1, done }
      },
    },
  ],
}
