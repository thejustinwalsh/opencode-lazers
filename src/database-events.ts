import { realpathSync } from "node:fs"
import type { Database } from "bun:sqlite"

type Listener = { changed(): void; failed(error: Error): void }
type Group = {
  listeners: Set<Listener>
  pending?: ReturnType<typeof setImmediate>
}
type RevisionPublisher = { read(): number; emit(version: number): Promise<void> }
type PublisherGroup = {
  members: Set<RevisionPublisher>
  published: number
  running: boolean
  dirty: boolean
  closed: boolean
  retry?: ReturnType<typeof setTimeout>
  unsubscribe(): void
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

/** One revision publisher per physical database/topic, shared across location module graphs. */
export class RevisionPublisherHub {
  constructor(private readonly changes: DatabaseChangeHub) {}
  private readonly publishers = new Map<string, PublisherGroup>()

  /** RPC events are global: one active project publisher serves every loaded location. */
  publishRevisions(path: string, topic: string, member: RevisionPublisher) {
    const key = JSON.stringify([realpathSync(path), topic])
    let group = this.publishers.get(key)
    if (!group) {
      group = {
        members: new Set(),
        published: member.read(),
        running: false,
        dirty: false,
        closed: false,
        unsubscribe: () => {},
      }
      this.publishers.set(key, group)
      const created = group
      created.unsubscribe = this.changes.subscribe(
        path,
        () => this.publishRevision(created),
        () => this.retryRevision(created),
      )
    }
    const target = group
    target.members.add(member)
    let closed = false
    return () => {
      if (closed) return
      closed = true
      const wasPublisher = target.members.values().next().value === member
      target.members.delete(member)
      if (target.members.size) {
        if (wasPublisher) this.publishRevision(target)
        return
      }
      target.closed = true
      target.unsubscribe()
      if (target.retry) clearTimeout(target.retry)
      this.publishers.delete(key)
    }
  }

  private retryRevision(group: PublisherGroup) {
    if (group.closed || group.retry) return
    group.retry = setTimeout(() => {
      group.retry = undefined
      this.publishRevision(group)
    }, 1_000)
    group.retry.unref()
  }

  private publishRevision(group: PublisherGroup) {
    if (group.closed) return
    if (group.running) {
      group.dirty = true
      return
    }
    const member = group.members.values().next().value
    if (!member) return
    let version: number
    try {
      version = member.read()
    } catch {
      this.retryRevision(group)
      return
    }
    if (version === group.published) return
    group.running = true
    group.dirty = false
    void Promise.resolve()
      .then(() => member.emit(version))
      .then(
        () => {
          group.published = version
        },
        () => this.retryRevision(group),
      )
      .finally(() => {
        group.running = false
        if (group.dirty && !group.retry) this.publishRevision(group)
      })
  }
}

const key = Symbol.for("opencode-lazers.database-change-hub.v2")
const host = globalThis as typeof globalThis & { [key]?: DatabaseChangeHub }
export const databaseChanges = (host[key] ??= new DatabaseChangeHub())

const publishersKey = Symbol.for("opencode-lazers.revision-publishers.v1")
const publishersHost = globalThis as typeof globalThis & { [publishersKey]?: RevisionPublisherHub }
export const revisionPublishers = (publishersHost[publishersKey] ??= new RevisionPublisherHub(
  databaseChanges,
))
