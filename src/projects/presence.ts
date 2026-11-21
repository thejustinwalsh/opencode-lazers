import type { TaskRepository } from "../storage.ts"
import { canonicalPath } from "./scope.ts"

/**
 * `project_presence`: the project roots that have a live core in this service process, one row
 * per root, so the Projects list reads "loaded" from a row instead of from this process's memory.
 *
 * ```
 * core created for a root ─► refs 0 → 1 ─► row (path, canonical, instance)
 * core disposed ───────────► refs 1 → 0 ─► row deleted
 * first presence write of this process ─► rows of every other instance deleted
 * ```
 *
 * One service process per database is the only supported deployment (owner decision,
 * 2026-11-21): rows of another instance are left by a process that stopped, so the first write of
 * a new process clears them. Refcounted per root because a reload builds the new core before it
 * disposes the old one.
 */
type Held = { instance: string; cleared: Set<string>; refs: Map<string, number> }
const key = Symbol.for("lazers.project-presence.v1")
const host = globalThis as typeof globalThis & { [key]?: Held }
const held = () =>
  (host[key] ??= { instance: crypto.randomUUID(), cleared: new Set(), refs: new Map() })

export function acquirePresence(
  repository: Pick<TaskRepository, "atomic" | "path">,
  directory: string,
): { release(): void } {
  const state = held()
  const id = JSON.stringify([repository.path, directory])
  const count = state.refs.get(id) ?? 0
  state.refs.set(id, count + 1)
  if (count === 0)
    repository.atomic((db) => {
      if (!state.cleared.has(repository.path)) {
        db.query("DELETE FROM project_presence WHERE instance<>?").run(state.instance)
        state.cleared.add(repository.path)
      }
      db.query(
        `INSERT INTO project_presence(path,canonical,instance,loaded_at) VALUES(?,?,?,?)
         ON CONFLICT(path) DO UPDATE SET canonical=excluded.canonical,instance=excluded.instance,
           loaded_at=excluded.loaded_at`,
      ).run(directory, canonicalPath(directory), state.instance, Date.now())
    })
  let released = false
  return {
    release() {
      if (released) return
      released = true
      const left = (state.refs.get(id) ?? 1) - 1
      if (left > 0) return void state.refs.set(id, left)
      state.refs.delete(id)
      try {
        repository.atomic((db) =>
          db.query("DELETE FROM project_presence WHERE path=?").run(directory),
        )
      } catch {
        // The next process start clears rows it does not own.
      }
    },
  }
}
