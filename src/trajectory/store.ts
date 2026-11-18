import type { Database } from "bun:sqlite"
import { acquireSharedConnection } from "../storage.ts"
import type { TaskRepository } from "../storage.ts"
import { TaskSpecSchema } from "../task.ts"
import { taskReferenceFor } from "../task-reference.ts"
import { RunnerStore } from "../runner/store.ts"
import type { RunnerStore as RunnerStoreType } from "../runner/store.ts"

/** Open only the existing project database, without repository migrations or runner DDL. */
export function openReadOnlyTrajectoryStore(path: string, projectDirectory: string) {
  const shared = acquireSharedConnection(path, "readonly")
  const db = shared.db
  try {
    const repository = {
      path,
      projectDirectory,
      atomic<T>(run: (db: Database) => T): T {
        return db.transaction(() => run(db)).deferred()
      },
      read<T>(run: (db: Database) => T): T {
        return db.transaction(() => run(db)).deferred()
      },
      get(id: string) {
        const row = db
          .query<{ body: string }, [string, string]>(
            "SELECT body FROM tasks WHERE project_directory = ? AND id = ?",
          )
          .get(projectDirectory, id)
        return row ? TaskSpecSchema.parse(JSON.parse(row.body)) : undefined
      },
      referenceFor(taskID: string) {
        return taskReferenceFor(db, projectDirectory, taskID)
      },
    } as unknown as TaskRepository

    // RunnerStore's public read methods only require this repository surface.
    // Avoid its constructor because that constructor creates runner tables.
    const store = Object.create(RunnerStore.prototype) as RunnerStoreType
    Object.defineProperty(store, "repository", {
      value: repository,
      enumerable: true,
    })
    return { store, close: () => shared.release() }
  } catch (error) {
    shared.release()
    throw error
  }
}
