import { Database } from "bun:sqlite"
import type { TaskRepository } from "../storage.ts"
import { TaskSpecSchema } from "../task.ts"
import { RunnerStore } from "../runner/store.ts"
import type { RunnerStore as RunnerStoreType } from "../runner/store.ts"

/** Open only the existing project database, without repository migrations or runner DDL. */
export function openReadOnlyTrajectoryStore(path: string, projectDirectory: string) {
  const db = new Database(path, { readonly: true, strict: true })
  try {
    const repository = {
      path,
      projectDirectory,
      atomic<T>(run: (db: Database) => T): T {
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
    } as unknown as TaskRepository

    // RunnerStore's public read methods only require this repository surface.
    // Avoid its constructor because that constructor creates runner tables.
    const store = Object.create(RunnerStore.prototype) as RunnerStoreType
    Object.defineProperty(store, "repository", {
      value: repository,
      enumerable: true,
    })
    return { store, close: () => db.close() }
  } catch (error) {
    db.close()
    throw error
  }
}
