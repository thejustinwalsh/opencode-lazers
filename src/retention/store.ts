import type { Database } from "bun:sqlite"
import { schemaModules } from "../database-schema.ts"
import type { TaskRepository } from "../storage.ts"

/** Retention settings and the record of every purge slice. Nothing here is workflow state. */
export function installRetentionSchema(repository: TaskRepository) {
  repository.installSchema(
    "retention",
    schemaModules.retention.generation,
    schemaModules.retention.tables,
    (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS retention_settings (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          auto_days INTEGER CHECK(auto_days IS NULL OR auto_days >= 1),
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS retention_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at INTEGER NOT NULL,
          days INTEGER NOT NULL,
          trigger TEXT NOT NULL CHECK(trigger IN ('manual','auto')),
          done INTEGER NOT NULL CHECK(done IN (0,1)),
          removed TEXT NOT NULL
        );
      `)
    },
  )
}

export type RemovedKinds = Record<string, { rows: number; bytes: number }>
export type WorktreeRemoval = { path: string; bytes: number | null }
export type WorktreeSkipped = { path: string; reason: string }
export type RetentionRun = {
  id: number
  at: number
  days: number
  trigger: "manual" | "auto"
  done: boolean
  removed: RemovedKinds
  worktrees: WorktreeRemoval[]
  skipped: WorktreeSkipped[]
}

/** Runs older than the newest few hundred add nothing the totals below do not already say. */
const RUNS_KEPT = 200

/** One row per purge, however many slices it takes; each slice adds to it. */
export function startRun(
  db: Database,
  run: { at: number; days: number; trigger: "manual" | "auto" },
): number {
  const { id } = db
    .query<{ id: number }, [number, number, string, string]>(
      "INSERT INTO retention_runs(at,days,trigger,done,removed) VALUES(?,?,?,0,?) RETURNING id",
    )
    .get(run.at, run.days, run.trigger, JSON.stringify({ kinds: {}, worktrees: [], skipped: [] }))!
  db.query("DELETE FROM retention_runs WHERE id <= ? - ?").run(id, RUNS_KEPT)
  return id
}

export function addToRun(
  db: Database,
  id: number,
  delta: { kinds: RemovedKinds; worktrees: WorktreeRemoval[]; skipped: WorktreeSkipped[] },
  done: boolean,
  at: number,
) {
  const row = db
    .query<{ removed: string }, [number]>("SELECT removed FROM retention_runs WHERE id=?")
    .get(id)
  if (!row) return
  const body = JSON.parse(row.removed) as {
    kinds: RemovedKinds
    worktrees: WorktreeRemoval[]
    skipped?: WorktreeSkipped[]
  }
  for (const [kind, total] of Object.entries(delta.kinds)) {
    const entry = (body.kinds[kind] ??= { rows: 0, bytes: 0 })
    entry.rows += total.rows
    entry.bytes += total.bytes
  }
  body.worktrees.push(...delta.worktrees)
  // Only the latest slice's reasons: they describe what is still in place now.
  body.skipped = delta.skipped
  db.query("UPDATE retention_runs SET removed=?, done=?, at=? WHERE id=?").run(
    JSON.stringify(body),
    done ? 1 : 0,
    at,
    id,
  )
}

/** The newest automatic run, so an unfinished one is continued rather than restarted. */
export function openAutoRun(db: Database): number | null {
  return (
    db
      .query<{ id: number }, []>(
        "SELECT id FROM retention_runs WHERE trigger='auto' AND done=0 ORDER BY id DESC LIMIT 1",
      )
      .get()?.id ?? null
  )
}

type RunRow = {
  id: number
  at: number
  days: number
  trigger: string
  done: number
  removed: string
}

export function lastRuns(db: Database, limit = 5): RetentionRun[] {
  return db
    .query<RunRow, [number]>("SELECT * FROM retention_runs ORDER BY id DESC LIMIT ?")
    .all(limit)
    .map((row) => {
      const body = JSON.parse(row.removed) as {
        kinds?: RetentionRun["removed"]
        worktrees?: WorktreeRemoval[]
        skipped?: WorktreeSkipped[]
      }
      return {
        id: row.id,
        at: row.at,
        days: row.days,
        trigger: row.trigger === "auto" ? "auto" : "manual",
        done: row.done === 1,
        removed: body.kinds ?? {},
        worktrees: body.worktrees ?? [],
        skipped: body.skipped ?? [],
      }
    })
}

export function autoDays(db: Database): number | null {
  return (
    db
      .query<{ auto_days: number | null }, []>(
        "SELECT auto_days FROM retention_settings WHERE id=1",
      )
      .get()?.auto_days ?? null
  )
}

export function setAutoDays(db: Database, days: number | null, now: number) {
  db.query(
    `INSERT INTO retention_settings(id,auto_days,updated_at) VALUES(1,?,?)
     ON CONFLICT(id) DO UPDATE SET auto_days=excluded.auto_days, updated_at=excluded.updated_at`,
  ).run(days, now)
}

/** Automatic runs start at most this often; an unfinished one continues on the next tick. */
export const AUTO_INTERVAL_MS = 6 * 3_600_000

/**
 * Whether the scheduler should purge now, and what. Superseded rows (kinds that age does not
 * apply to) are always due on the interval: each is dead the moment its successor exists, so no
 * choice of age is involved. `days` is set only when the owner turned on automatic retention of
 * old finished plans; null means the superseded-only pass. An unfinished run continues on the next
 * tick.
 */
export function autoRetentionDue(db: Database, now: number): { days: number | null } | null {
  const days = autoDays(db)
  const last = db
    .query<{ at: number; done: number }, []>(
      "SELECT at,done FROM retention_runs WHERE trigger='auto' ORDER BY id DESC LIMIT 1",
    )
    .get()
  if (!last || last.done === 0 || now - last.at >= AUTO_INTERVAL_MS) return { days }
  return null
}

/** True while any attempt is preparing, running or verifying: not a quiet point. */
export function workIsActive(db: Database) {
  return (
    db
      .query(
        "SELECT 1 FROM runner_attempts WHERE state IN ('preparing','running','verifying') LIMIT 1",
      )
      .get() !== null
  )
}
