import type { Database } from "bun:sqlite"
import { dueProbeSQL } from "./queue.ts"

/**
 * The seam between `TaskRepository.atomic` and the projections' drains (the schedule projection has
 * its own, older seam in `src/tasks/schedule/hook.ts`). `storage.ts` cannot import a drain that
 * reads runner tables, so each projection registers its drain here by name, and a connection joins
 * a projection once that projection's schema is installed on it. Every write transaction calls
 * {@link drainProjections} after the writer's statements, before commit; with nothing due that is
 * one indexed `SELECT 1` per enrolled projection.
 */
type Drain = { queue: string; drain(db: Database): void }
type Hook = {
  drains: Map<string, Drain>
  /** Per connection, the due probe of each projection it is enrolled in. */
  probes: WeakMap<Database, Map<string, { get(now: number): unknown }>>
}
const key = Symbol.for("lazers.projections.hook.v1")
const host = globalThis as typeof globalThis & { [key]?: Hook }
const hook = (host[key] ??= { drains: new Map(), probes: new WeakMap() })

/** Register (or, after a reload, replace) the drain of projection `name` over its queue table. */
export function registerProjectionDrain(
  name: string,
  queue: string,
  drain: (db: Database) => void,
) {
  hook.drains.set(name, { queue, drain })
}

/** The connection has projection `name`'s schema; its write transactions drain it from now on. */
export function enrollProjectionConnection(db: Database, name: string) {
  const entry = hook.drains.get(name)
  if (!entry) throw new Error(`No drain registered for projection ${name}`)
  let probes = hook.probes.get(db)
  if (!probes) hook.probes.set(db, (probes = new Map()))
  probes.set(name, db.query<unknown, [number]>(dueProbeSQL(entry.queue)))
}

/** Called inside every write transaction. A projection failure never fails the writer. */
export function drainProjections(db: Database) {
  const probes = hook.probes.get(db)
  if (!probes) return
  const now = Date.now()
  for (const [name, probe] of probes) {
    if (probe.get(now) === null) continue
    try {
      hook.drains.get(name)?.drain(db)
    } catch {
      // The queued entries stay for the owner, which records the error.
    }
  }
}
