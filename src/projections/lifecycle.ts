import type { Database } from "bun:sqlite"
import { schemaModules } from "../database-schema.ts"
import { lifecycleTransition } from "../runner/lifecycle-machines.ts"
import type { TaskRepository } from "../storage.ts"

/**
 * `projection_state`: one row per stored projection (and scope), holding its `projection`
 * lifecycle state and its backfill watermark.
 *
 * ```
 *   start ──► backfilling ── phase 0 pages … phase n pages ──► ready
 *                 ▲                                              │
 *                 └──────── stored generation < code generation ─┘
 * ```
 *
 * `phase` indexes the spec's backfill phases and `after` is the watermark inside the phase (each
 * phase says what it means; usually the largest source rowid done). Both commit with the page that
 * moved them, so a restart resumes at the next page. The state moves only through
 * `lifecycleTransition("projection", …)`. A rowid table, so a stream source can show the progress.
 */
const MODULE = schemaModules.projections

export type ProjectionLifecycleState = "backfilling" | "ready"

export type ProjectionStatus = {
  name: string
  scope: string
  generation: number
  state: ProjectionLifecycleState
  phase: number
  after: number
  /** Pages committed since the backfill last started; a measurement, not a limit. */
  pages: number
  last_error: string | null
}

function installProjectionStateSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projection_state (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '',
      generation INTEGER NOT NULL, state TEXT NOT NULL,
      phase INTEGER NOT NULL DEFAULT 0, after INTEGER NOT NULL DEFAULT 0,
      pages INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      updated_at INTEGER NOT NULL,
      UNIQUE(name, scope)
    );
  `)
}

export function ensureProjectionStateSchema(repository: TaskRepository) {
  repository.installSchema("projections", MODULE.generation, MODULE.tables, (db) =>
    installProjectionStateSchema(db),
  )
}

const COLUMNS = "name,scope,generation,state,phase,after,pages,last_error"

export function projectionStatus(
  db: Database,
  name: string,
  scope = "",
): ProjectionStatus | undefined {
  return (
    db
      .query<ProjectionStatus, [string, string]>(
        `SELECT ${COLUMNS} FROM projection_state WHERE name=? AND scope=?`,
      )
      .get(name, scope) ?? undefined
  )
}

/**
 * The row of a projection at the code's generation, in the caller's write transaction: created
 * `backfilling` when missing; sent back to `backfilling` (watermark reset) when the stored
 * generation is older. A stored generation newer than the code's belongs to a newer plugin copy;
 * it is left as is, and this copy does not backfill.
 */
export function openProjectionState(
  db: Database,
  name: string,
  generation: number,
  scope = "",
  now = Date.now(),
): ProjectionStatus {
  db.query(
    `INSERT OR IGNORE INTO projection_state(name,scope,generation,state,updated_at)
     VALUES(?,?,?,'backfilling',?)`,
  ).run(name, scope, generation, now)
  const row = projectionStatus(db, name, scope)!
  if (row.generation >= generation) return row
  const state = lifecycleTransition("projection", row.state, "backfilling")
  db.query(
    `UPDATE projection_state SET generation=?,state=?,phase=0,after=0,pages=0,last_error=NULL,updated_at=?
     WHERE name=? AND scope=?`,
  ).run(generation, state, now, name, scope)
  return projectionStatus(db, name, scope)!
}

/** Commit a page's watermark; `ready` moves the lifecycle when the last phase is done. */
export function advanceProjectionState(
  db: Database,
  name: string,
  scope: string,
  next: { phase: number; after: number; ready: boolean },
  now = Date.now(),
) {
  const row = projectionStatus(db, name, scope)!
  const state = next.ready ? lifecycleTransition("projection", row.state, "ready") : row.state
  db.query(
    `UPDATE projection_state SET state=?,phase=?,after=?,pages=pages+1,last_error=NULL,updated_at=?
     WHERE name=? AND scope=?`,
  ).run(state, next.phase, next.after, now, name, scope)
}

/** Record the error of a failed page or drain; the state and watermark are unchanged. */
export function recordProjectionError(
  db: Database,
  name: string,
  scope: string,
  error: string,
  now = Date.now(),
) {
  db.query("UPDATE projection_state SET last_error=?,updated_at=? WHERE name=? AND scope=?").run(
    error.slice(0, 500),
    now,
    name,
    scope,
  )
}

/** Forget a projection's progress (its tables were rebuilt): the next owner start backfills. */
export function resetProjectionState(db: Database, name: string) {
  db.query("DELETE FROM projection_state WHERE name=?").run(name)
}
