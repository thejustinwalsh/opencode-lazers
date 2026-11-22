import type { Database } from "bun:sqlite"
import { refreshPause, refreshPlan, refreshReservations, refreshTask } from "./refresh.ts"
import type { RefreshContext } from "./refresh.ts"
import { refreshLineage } from "./lineage.ts"
import { setScheduleParked } from "./hook.ts"
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
const DRAIN_BUDGET = 1000

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

const BACKOFF_FIRST_MS = 1000
const BACKOFF_CEILING_MS = 5 * 60_000

/**
 * Move a failed entry out of the hot queue into the parked set, and mark the rows it owns stale so
 * a list never shows last-good values as current. Runs after the failed refresh was rolled back,
 * inside the writer's transaction, which still commits: a projection failure never fails a write.
 */
function park(db: Database, kind: DirtyKind, ref: string, error: string, now: number) {
  const before = db
    .query<{ attempts: number; first_at: number }, [string, string]>(
      "SELECT attempts,first_at FROM task_schedule_failed WHERE kind=? AND ref=?",
    )
    .get(kind, ref)
  const attempts = (before?.attempts ?? 0) + 1
  db.query(
    `INSERT INTO task_schedule_failed(kind,ref,error,attempts,first_at,last_at,next_at)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(kind,ref) DO UPDATE SET error=excluded.error,attempts=excluded.attempts,
       last_at=excluded.last_at,next_at=excluded.next_at`,
  ).run(
    kind,
    ref,
    error.slice(0, 500),
    attempts,
    before?.first_at ?? now,
    now,
    now + Math.min(BACKOFF_FIRST_MS * 2 ** (attempts - 1), BACKOFF_CEILING_MS),
  )
  db.query("DELETE FROM task_schedule_dirty WHERE kind=? AND ref=?").run(kind, ref)
  if (kind === "task") db.query("UPDATE task_schedule SET stale=1 WHERE task_id=?").run(ref)
  else if (kind === "plan")
    db.query(
      `UPDATE task_schedule SET stale=1 WHERE plan_id=? OR task_id IN
         (SELECT task_id FROM runner_nodes WHERE plan_id=?)`,
    ).run(ref, ref)
}

/** Queue parked entries whose backoff has passed; they leave the parked set when a refresh succeeds. */
export function retryParked(db: Database, now = Date.now()): number {
  return db
    .query(
      `INSERT OR IGNORE INTO task_schedule_dirty(kind,ref)
       SELECT kind,ref FROM task_schedule_failed WHERE next_at<=?`,
    )
    .run(now).changes
}

function parkedCount(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_schedule_failed").get()!.n
}

/** The earliest time a parked entry is due, or undefined when none is parked. */
export function nextRetryAt(db: Database): number | undefined {
  return (
    db.query<{ at: number | null }, []>("SELECT MIN(next_at) AS at FROM task_schedule_failed").get()
      ?.at ?? undefined
  )
}

/**
 * Handle queued entries in the caller's write transaction. A refresh that throws is rolled back to
 * its savepoint and parked with its error; the write that queued it commits, and the hot queue is
 * empty again, so later writes pay one probe. A parked entry returns to the queue when its task or
 * plan next changes (a trigger queues it) or when the owner's backoff comes due.
 */
export function drainTaskSchedule(db: Database, options: { budget?: number } = {}): DrainResult {
  const budget = options.budget ?? DRAIN_BUDGET
  const failed: DrainResult["failed"] = []
  let handled = 0
  const ctx = newRefreshContext(db)
  const next = db.query<{ kind: DirtyKind; ref: string }, []>(
    `SELECT kind,ref FROM task_schedule_dirty ORDER BY CASE kind WHEN 'task' THEN 0 WHEN 'plan' THEN 1
       WHEN 'reservations' THEN 2 ELSE 3 END, ref LIMIT 1`,
  )
  while (handled < budget) {
    const entry = next.get()
    if (!entry) break
    try {
      db.exec("SAVEPOINT task_schedule_entry")
      if (entry.kind === "task") refreshTask(db, ctx, entry.ref)
      else if (entry.kind === "plan") refreshPlan(db, ctx, entry.ref)
      else if (entry.kind === "reservations") refreshReservations(db, ctx, entry.ref)
      else if (entry.kind === "lineage") refreshLineage(db, entry.ref)
      else refreshPause(db, ctx, entry.ref)
      db.exec("RELEASE task_schedule_entry")
      db.query("DELETE FROM task_schedule_dirty WHERE kind=? AND ref=?").run(entry.kind, entry.ref)
      db.query("DELETE FROM task_schedule_failed WHERE kind=? AND ref=?").run(entry.kind, entry.ref)
    } catch (error) {
      db.exec("ROLLBACK TO task_schedule_entry; RELEASE task_schedule_entry")
      const message = error instanceof Error ? error.message : String(error)
      try {
        park(db, entry.kind, entry.ref, message, Date.now())
      } catch {
        // Parking failed too (a broken projection schema): drop the entry so the drain ends, and
        // let the writer's transaction commit. The next generation install rebuilds the rows.
        db.query("DELETE FROM task_schedule_dirty WHERE kind=? AND ref=?").run(
          entry.kind,
          entry.ref,
        )
      }
      failed.push({ kind: entry.kind, ref: entry.ref, error: message })
    }
    handled++
    // Task entries change plan data a plan entry would also touch; a fresh cache keeps reads current.
    ctx.plans.clear()
  }
  const remaining = db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_schedule_dirty")
    .get()!.n
  if (failed.length || handled) setScheduleParked(parkedCount(db))
  return { handled, remaining, failed }
}
