import { realpathSync, watch, type FSWatcher } from "node:fs"
import { basename, dirname, join } from "node:path"
import type { Database } from "bun:sqlite"

type Listener = { changed(): void; failed(error: Error): void }
type Group = {
  listeners: Set<Listener>
  watchers: Map<string, FSWatcher>
  pending?: ReturnType<typeof setImmediate>
  retry?: ReturnType<typeof setTimeout>
}

/** Database/WAL notifications invalidate reads; durable revisions determine actual changes. */
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
        } catch {
          /* A reader cannot fail the shared feed. */
        }
      }
    })
  }

  subscribe(path: string, changed: () => void, failed: (error: Error) => void) {
    const key = realpathSync(path)
    let group = this.groups.get(key)
    if (!group) {
      group = { listeners: new Set(), watchers: new Map() }
      this.groups.set(key, group)
    }
    const target = group
    const listener = { changed, failed }
    let closed = false
    target.listeners.add(listener)
    if (!target.watchers.size && !target.retry) this.open(key, target)
    return () => {
      if (closed) return
      closed = true
      target.listeners.delete(listener)
      if (target.listeners.size) return
      this.groups.delete(key)
      for (const watcher of target.watchers.values()) watcher.close()
      target.watchers.clear()
      if (target.pending) clearImmediate(target.pending)
      if (target.retry) clearTimeout(target.retry)
    }
  }

  private open(path: string, group: Group) {
    if (this.groups.get(path) !== group) return
    const invalidate = () => this.invalidate(group)
    const failure = (error: Error) => {
      for (const watcher of group.watchers.values()) watcher.close()
      group.watchers.clear()
      for (const listener of group.listeners) {
        try {
          listener.failed(error)
        } catch {
          /* Other readers still receive the gap. */
        }
      }
      if (!group.listeners.size || this.groups.get(path) !== group || group.retry) return
      // Retry only a failed subscription; healthy subscriptions have no interval.
      group.retry = setTimeout(() => {
        group.retry = undefined
        this.open(path, group)
      }, 1_000)
      group.retry.unref()
    }
    try {
      const name = basename(path)
      const directory = dirname(path)
      const names = new Set([name, `${name}-wal`, `${name}-journal`])
      const attach = (filename: string) => {
        if (group.watchers.has(filename)) return
        try {
          const watcher = watch(join(directory, filename), { persistent: false }, (event) => {
            invalidate()
            if (event === "rename" && group.watchers.get(filename) === watcher) {
              watcher.close()
              group.watchers.delete(filename)
              try {
                attach(filename)
              } catch (error) {
                failure(error instanceof Error ? error : new Error(String(error)))
              }
            }
          })
          group.watchers.set(filename, watcher)
          watcher.on("error", (error) => {
            if (group.watchers.get(filename) === watcher) failure(error)
          })
        } catch (error) {
          // WAL/journal files may not exist until the first write; the directory
          // subscription attaches their file watchers when they are created.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
      }
      const directoryWatcher = watch(directory, { persistent: false }, (event, filename) => {
        if (filename !== null && !names.has(filename)) return
        for (const file of filename === null ? names : [filename]) {
          if (event === "rename") {
            group.watchers.get(file)?.close()
            group.watchers.delete(file)
          }
          try {
            attach(file)
          } catch (error) {
            failure(error instanceof Error ? error : new Error(String(error)))
            return
          }
        }
        invalidate()
      })
      group.watchers.set("", directoryWatcher)
      directoryWatcher.on("error", (error) => {
        if (group.watchers.get("") === directoryWatcher) failure(error)
      })
      for (const file of names) attach(file)
      // Close the registration/reconnect window with one durable revision check.
      invalidate()
    } catch (error) {
      failure(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

const key = Symbol.for("opencode-lazers.database-change-hub.v1")
const host = globalThis as typeof globalThis & { [key]?: DatabaseChangeHub }
export const databaseChanges = (host[key] ??= new DatabaseChangeHub())
