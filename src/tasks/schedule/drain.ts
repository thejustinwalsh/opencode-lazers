import type { Database } from "bun:sqlite"
import { refreshPause, refreshPlan, refreshReservations, refreshTask } from "./refresh.ts"
import type { RefreshContext } from "./refresh.ts"
import type { DirtyKind } from "./schema.ts"

export type DrainResult = {
  handled: number
  remaining: number
  failed: { kind: DirtyKind; ref: string; error: string }[]
}

/**
 * Rows touched per drain call before it leaves the rest queued for the owner. A unit of work, not
 * a cap: nothing is refused or dropped, the owner keeps draining in its own transactions. About a
 * thousand node refreshes is tens of milliseconds (see the drain overhead test).
 */
export const DRAIN_BUDGET = 1000

/** True when work is queued: the only statement a transaction with nothing queued pays. */
const QUEUED = "SELECT 1 FROM task_schedule_dirty LIMIT 1"

export function newRefreshContext(db: Database): RefreshContext {
  return {
    reservations: new Map(),
    plans: new Map(),
    enqueue: (kind, ref) =>
      void db
        .query("INSERT OR IGNORE INTO task_schedule_dirty(kind,ref) VALUES(?,?)")
        .run(kind, ref),
  }
}

export function hasScheduleWork(db: Database): boolean {
  return db.query(QUEUED).get() !== null
}

/**
 * Handle queued entries in the caller's write transaction. A refresh that throws leaves its entry
 * queued and records the error, so a later drain retries it; the write that queued it commits.
 */
export function drainTaskSchedule(db: Database, options: { budget?: number } = {}): DrainResult {
  const budget = options.budget ?? DRAIN_BUDGET
  const failed: DrainResult["failed"] = []
  const skip = new Set<string>()
  let handled = 0
  const ctx = newRefreshContext(db)
  const next = db.query<{ kind: DirtyKind; ref: string }, [number]>(
    `SELECT kind,ref FROM task_schedule_dirty ORDER BY CASE kind WHEN 'task' THEN 0 WHEN 'plan' THEN 1
       WHEN 'reservations' THEN 2 ELSE 3 END, ref LIMIT ?`,
  )
  while (handled < budget) {
    const entry = next
      .all(skip.size + 1)
      .find((candidate) => !skip.has(`${candidate.kind}\0${candidate.ref}`))
    if (!entry) break
    try {
      db.exec("SAVEPOINT task_schedule_entry")
      if (entry.kind === "task") refreshTask(db, ctx, entry.ref)
      else if (entry.kind === "plan") refreshPlan(db, ctx, entry.ref)
      else if (entry.kind === "reservations") refreshReservations(db, ctx, entry.ref)
      else refreshPause(db, ctx, entry.ref)
      db.exec("RELEASE task_schedule_entry")
      db.query("DELETE FROM task_schedule_dirty WHERE kind=? AND ref=?").run(entry.kind, entry.ref)
    } catch (error) {
      db.exec("ROLLBACK TO task_schedule_entry; RELEASE task_schedule_entry")
      const message = error instanceof Error ? error.message : String(error)
      failed.push({ kind: entry.kind, ref: entry.ref, error: message })
      skip.add(`${entry.kind}\0${entry.ref}`)
    }
    handled++
    // Task entries change plan data a plan entry would also touch; a fresh cache keeps reads current.
    ctx.plans.clear()
  }
  if (failed.length)
    db.query(
      `INSERT INTO task_schedule_state(project_directory,last_error) VALUES('',?)
       ON CONFLICT(project_directory) DO UPDATE SET last_error=excluded.last_error`,
    ).run(JSON.stringify(failed.slice(0, 5)))
  const remaining = db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_schedule_dirty")
    .get()!.n
  return { handled, remaining, failed }
}
