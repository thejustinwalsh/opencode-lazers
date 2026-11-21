import type { Database } from "bun:sqlite"
import { schemaModules } from "../database-schema.ts"
import type { TaskRepository } from "../storage.ts"
import type { SchedulerCoordinator, SchedulerProjectStatus } from "./scheduler-coordinator.ts"

/**
 * `scheduler_project_status`: the scheduler's state for one project (one row per project
 * directory), written when it changes, so the Radar reads it as a row instead of asking this
 * process's coordinator. The coordinator stays the owner of the state; the row is its mirror, an
 * observation, not a workflow state (no decide read reads it).
 *
 * ```
 * coordinator: register / drain start / drain end / dispose ─► watch(key) ─► latest status
 *   ─► one write at a time (atomicAsync), the newest value wins ─► scheduler_project_status
 * ```
 *
 * One service process per database (owner decision, 2026-11-21), so the row of a project is the
 * status of the one coordinator that schedules it.
 */
const MODULE = schemaModules["scheduler-status"]

export function installSchedulerStatusSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduler_project_status (
      id INTEGER PRIMARY KEY,
      project_directory TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      participants INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
}

export function ensureSchedulerStatusSchema(repository: TaskRepository) {
  repository.installSchema("scheduler-status", MODULE.generation, MODULE.tables, (db) =>
    installSchedulerStatusSchema(db),
  )
}

export function writeSchedulerStatus(
  db: Database,
  project: string,
  status: SchedulerProjectStatus,
  now = Date.now(),
) {
  db.query(
    `INSERT INTO scheduler_project_status(project_directory,status,participants,updated_at)
     VALUES(?,?,?,?) ON CONFLICT(project_directory) DO UPDATE SET status=excluded.status,
       participants=excluded.participants,updated_at=excluded.updated_at
     WHERE status IS NOT excluded.status OR participants IS NOT excluded.participants`,
  ).run(project, status.status, status.participants, now)
}

/**
 * Mirror the coordinator's status of `key` into the project's row until `stop`. Writes are
 * serialized and coalesced: while one is in flight, only the newest status waits behind it.
 * `stop` writes the last status it was told and waits for it.
 */
export function mirrorSchedulerStatus(
  coordinator: Pick<SchedulerCoordinator, "watch">,
  key: string,
  repository: Pick<TaskRepository, "atomicAsync" | "projectDirectory">,
  options: { onError?: (error: unknown) => void } = {},
): { stop(): Promise<void> } {
  // A coordinator built by an older plugin copy (it lives on globalThis) has no `watch`; its row
  // is written once a restart builds the current one.
  if (typeof coordinator.watch !== "function") return { stop: async () => {} }
  let pending: SchedulerProjectStatus | undefined
  let writing: Promise<void> | undefined
  const flush = (): Promise<void> =>
    (writing ??= (async () => {
      while (pending) {
        const next = pending
        pending = undefined
        try {
          await repository.atomicAsync((db) =>
            writeSchedulerStatus(db, repository.projectDirectory, next),
          )
        } catch (error) {
          options.onError?.(error)
        }
      }
    })().finally(() => {
      writing = undefined
    }))
  const unwatch = coordinator.watch(key, (status) => {
    pending = status
    void flush()
  })
  return {
    async stop() {
      unwatch()
      await (writing ?? flush())
    },
  }
}
