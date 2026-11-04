import { realpathSync } from "node:fs"
import type { Database } from "bun:sqlite"

type Listener = { changed(): void; failed(error: Error): void }
type Group = {
  listeners: Set<Listener>
  pending?: ReturnType<typeof setImmediate>
}

/** Share native SQLite invalidations across this OpenCode service's locations. */
export class DatabaseChangeHub {
  private readonly groups = new Map<string, Group>()

  /** SQLite hooks run before commit; defer reads until the synchronous statement ends. */
  track(db: Database, path: string) {
    const key = realpathSync(path)
    const hook = (_db: Database, table: string) => {
      if (table !== "task_changes" && table !== "observation_revisions") return
      const group = this.groups.get(key)
      if (group) this.invalidate(group)
    }
    db.onInsert = hook
    db.onUpdate = hook
    db.onDelete = hook
  }

  private invalidate(group: Group) {
    if (!group.listeners.size || group.pending) return
    group.pending = setImmediate(() => {
      group.pending = undefined
      for (const listener of group.listeners) {
        try {
          listener.changed()
        } catch (error) {
          try {
            listener.failed(error instanceof Error ? error : new Error(String(error)))
          } catch {
            /* Other readers still receive the invalidation. */
          }
        }
      }
    })
  }

  subscribe(path: string, changed: () => void, failed: (error: Error) => void) {
    const key = realpathSync(path)
    let group = this.groups.get(key)
    if (!group) {
      group = { listeners: new Set() }
      this.groups.set(key, group)
    }
    const target = group
    const listener = { changed, failed }
    let closed = false
    target.listeners.add(listener)
    // Initial/reconnected readers check the durable revision once.
    this.invalidate(target)
    return () => {
      if (closed) return
      closed = true
      target.listeners.delete(listener)
      if (target.listeners.size) return
      this.groups.delete(key)
      if (target.pending) clearImmediate(target.pending)
    }
  }
}

const key = Symbol.for("opencode-lazers.database-change-hub.v2")
const host = globalThis as typeof globalThis & { [key]?: DatabaseChangeHub }
export const databaseChanges = (host[key] ??= new DatabaseChangeHub())
