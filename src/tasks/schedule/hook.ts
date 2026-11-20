import type { Database } from "bun:sqlite"

/**
 * The seam between `TaskRepository.atomic` and the schedule drain. `storage.ts` cannot import the
 * drain (which reads runner tables), so the drain registers here, and a connection joins once its
 * schema is installed. Every write transaction calls `drainScheduleHook`; with nothing queued that
 * is one indexed `SELECT 1`.
 */
const key = Symbol.for("lazers.taskSchedule.hook.v1")
type Hook = {
  drain?: (db: Database) => void
  connections: WeakSet<Database>
  probe: WeakMap<Database, { get(): unknown }>
}
const host = globalThis as typeof globalThis & { [key]?: Hook }
const hook = (host[key] ??= { connections: new WeakSet(), probe: new WeakMap() })

export function registerScheduleDrain(drain: (db: Database) => void) {
  hook.drain = drain
}

/** The connection has the projection schema; its transactions drain from now on. */
export function enrollScheduleConnection(db: Database) {
  hook.connections.add(db)
  hook.probe.set(db, db.query("SELECT 1 FROM task_schedule_dirty LIMIT 1"))
}

/** Called inside every write transaction, after the writer's statements, before commit. */
export function drainScheduleHook(db: Database) {
  const probe = hook.probe.get(db)
  if (probe === undefined || probe.get() === null) return
  hook.drain?.(db)
}
