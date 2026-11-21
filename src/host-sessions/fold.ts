import { joinNativeEvents } from "../core/event-hub.ts"
import { LruMap, SESSION_MEMO_ENTRIES } from "../core/process-shared.ts"
import { parkQueueEntry, QueueRetryTimer } from "../core/queue-retry.ts"
import { databaseChanges } from "../database-events.ts"
import { startProjection, type ProjectionLease } from "../projections/owner.ts"
import { TaskRepository } from "../storage.ts"
import {
  ensureHostSessionStateSchema,
  HOST_SESSION_QUEUE,
  hostSessionRefRange,
  hostSessionSeedProjection,
  queueHostSession,
  storedHostSession,
  writeHostSession,
  type HostSessionPending,
  type HostSessionSource,
} from "./state.ts"

/**
 * The fold that keeps `host_session_state` current: one per project and database in this process
 * (shared by every project core and plugin copy that loads it), the only writer of the table.
 *
 * A native event is a hint, never a fact: it names a session to re-read. Nothing depends on
 * seeing every event, or seeing them in order.
 *
 * ```
 * event(session, created) ─ created < last read start? ─ yes ─► nothing (that read saw it)
 *                                                      └ no ──► queue(session, next_at 0)
 * queue ─► get (one call) ─┬─ busy, or a hint that can change pending counts ─► pending reads
 *                          └──────────────────────────────────────────────────────┐
 *                                    compare with the row; older stamp ignored ◄──┘
 * subscription attached (start, every reattach) ─► resync: page the host's live sessions by
 *   cursor, write the idle ones, queue the busy ones, queue stored live rows it did not list
 * ```
 *
 * - Lost event: the resync on every attach re-reads the host by cursor. A subscription that
 *   failed or ended reattaches (`core/event-hub.ts`), and the attach resyncs.
 * - Reordered or redelivered event: the read is of the host's current state, gated by the stored
 *   `time.updated`; a duplicate created before the last read began reads nothing.
 * - Idle (nothing queued or parked): no timer, no read; one table subscription.
 * - A failed read stays queued with its error and a backoff (1 s to 5 min, as the projections'
 *   queue); a later hint for the session resets the backoff.
 */
const HOST_SESSION_EVENT_TYPES = [
  "session.created",
  "session.deleted",
  "session.agent.selected",
  "session.model.selected",
  "session.moved",
  "session.archived",
  "session.unarchived",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.inbox.delivery.changed",
  "session.usage.updated",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
  "session.status",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
] as const

/** Events after which the inbox, permission and form counts may differ: read them too. */
const OBSERVE = new Set<string>([
  "session.created",
  "session.unarchived",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.inbox.delivery.changed",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
  "session.status",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
])

type Hint = { sessionID: string; created: number | undefined; observe: boolean; moved: boolean }

const record = (value: unknown) =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined

/** The session a native event names, and when the host created the event. */
export function hostSessionHint(event: unknown): Hint | undefined {
  const info = record(event)
  const type = typeof info?.type === "string" ? info.type : ""
  const data = record(info?.data)
  const sessionID =
    type === "form.created" ? record(data?.form)?.sessionID : (data?.sessionID ?? undefined)
  if (typeof sessionID !== "string" || !sessionID || sessionID.length > 200) return undefined
  const created = info?.created
  return {
    sessionID,
    created: typeof created === "number" && Number.isFinite(created) ? created : undefined,
    observe: OBSERVE.has(type),
    moved: type === "session.moved",
  }
}

/** Queue entries per read of the queue: a unit of work, the rest wait for the next read. */
const DRAIN_BATCH = 20
/** Stored live rows per resync page, an id scan of one index range. */
const RESYNC_ROWS = 500

export type HostSessionFoldOptions = {
  onError?: (error: unknown) => void
  now?: () => number
}

export class HostSessionFold {
  private closed = false
  private again = false
  private draining: Promise<void> | undefined
  private resyncing: Promise<void> | undefined
  private resyncAgain = false
  private readonly retry: QueueRetryTimer
  private unsubscribe: (() => void) | undefined
  /** When the newest read of each session began: an event created before it is already read. */
  private readonly readAt = new LruMap<string, number>(SESSION_MEMO_ENTRIES)
  /** When the newest pending (inbox, permission, form) read of each session began. */
  private readonly observedAt = new LruMap<string, number>(SESSION_MEMO_ENTRIES)
  /** The hint sequence that last queued each session: a read begun before it leaves the entry. */
  private readonly hinted = new LruMap<string, number>(SESSION_MEMO_ENTRIES)
  private hintSeq = 0
  /** Sessions of another project: their events read nothing until one moves. */
  private readonly foreign = new LruMap<string, true>(SESSION_MEMO_ENTRIES)
  private readonly observe = new Set<string>()
  private readonly range: readonly [string, string]
  private readonly now: () => number
  /** Host reads made, by kind: a measurement for tests and diagnostics. */
  readonly reads = { get: 0, pending: 0, list: 0 }

  constructor(
    private readonly repository: TaskRepository,
    private readonly projectID: string,
    private readonly source: HostSessionSource,
    private readonly options: HostSessionFoldOptions = {},
  ) {
    this.range = hostSessionRefRange(repository.projectDirectory)
    this.now = options.now ?? Date.now
    this.retry = new QueueRetryTimer(repository, HOST_SESSION_QUEUE, this.range, this.now, () => {
      void this.drain()
    })
  }

  private get project() {
    return this.repository.projectDirectory
  }

  start(): void {
    ensureHostSessionStateSchema(this.repository)
    // Seeds are written by the seed owner's connection; any queue write wakes the drain.
    this.unsubscribe = databaseChanges.subscribeTables(this.repository.path, (tables) => {
      if (tables.has(HOST_SESSION_QUEUE)) void this.drain()
    })
    void this.drain()
  }

  /** A native event: queue its session unless a read that began after the event covers it. */
  hint(event: unknown): void {
    if (this.closed) return
    const hint = hostSessionHint(event)
    if (!hint) return
    if (hint.moved) this.foreign.delete(hint.sessionID)
    if (this.foreign.has(hint.sessionID)) return
    // A hint that can change pending counts is covered only by a read that read them.
    const readAt = (hint.observe ? this.observedAt : this.readAt).get(hint.sessionID)
    if (hint.created !== undefined && readAt !== undefined && hint.created < readAt) return
    if (hint.observe) this.observe.add(hint.sessionID)
    this.hinted.set(hint.sessionID, ++this.hintSeq)
    try {
      this.repository.atomic((db) => queueHostSession(db, this.project, hint.sessionID, "hint"))
    } catch (error) {
      // The next event or attach queues it again.
      this.options.onError?.(error)
    }
  }

  /** True when the fold holds no timer and runs nothing. */
  idle(): boolean {
    return !this.retry.pending && !this.draining && !this.resyncing
  }

  /**
   * Re-read the host by cursor: every live session of the project, one page at a time. Idle
   * sessions are written from the listed record (no pending reads: nothing is pending while a
   * session is idle); busy ones are queued for their pending reads; stored live rows the host no
   * longer lists (archived, deleted or moved since) are queued to be read and cleared.
   */
  resync(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.resyncing) {
      this.resyncAgain = true
      return this.resyncing
    }
    this.resyncing = (async () => {
      do {
        this.resyncAgain = false
        try {
          await this.resyncPass()
        } catch (error) {
          // The next attach resyncs; queued work stays queued.
          this.options.onError?.(error)
        }
      } while (this.resyncAgain && !this.closed)
    })().finally(() => {
      this.resyncing = undefined
    })
    return this.resyncing
  }

  private async resyncPass() {
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      const started = this.now()
      this.reads.list++
      const page = await this.source.list(this.projectID, cursor)
      if (this.closed) return
      await this.repository.retryBusy(() =>
        this.repository.atomic((db) => {
          for (const listed of page.records) {
            if (listed.projectID !== this.projectID) continue
            seen.add(listed.id)
            if (listed.busy) {
              this.observe.add(listed.id)
              queueHostSession(db, this.project, listed.id, "seed")
            } else {
              writeHostSession(db, this.project, this.projectID, listed.id, listed)
              this.readAt.set(listed.id, started)
            }
          }
        }),
      )
      cursor = page.next
    } while (cursor && !this.closed)
    let after = 0
    for (;;) {
      const rows = this.repository.read((db) =>
        db
          .query<{ id: number; session_id: string }, [string, number, number]>(
            `SELECT id,session_id FROM host_session_state
             WHERE project_directory=? AND archived=0 AND id>? ORDER BY id LIMIT ?`,
          )
          .all(this.project, after, RESYNC_ROWS),
      )
      const missing = rows.filter((row) => !seen.has(row.session_id))
      if (missing.length)
        this.repository.atomic((db) => {
          for (const row of missing) queueHostSession(db, this.project, row.session_id, "seed")
        })
      if (rows.length < RESYNC_ROWS || this.closed) break
      after = rows.at(-1)!.id
    }
    await this.drain()
  }

  /** Read every due queued session of this project; coalesces concurrent calls. */
  drain(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.again = true
    this.draining ??= (async () => {
      while (this.again && !this.closed) {
        this.again = false
        try {
          for (;;) {
            const batch = this.due()
            if (!batch.length || this.closed) break
            for (const entry of batch) {
              if (this.closed) break
              await this.readOne(entry.ref, entry.attempts)
            }
          }
        } catch (error) {
          // The database is busy or failing: the work stays queued for the next change or retry.
          this.options.onError?.(error)
        }
        if (!this.closed) this.retry.schedule()
      }
    })().finally(() => {
      this.draining = undefined
    })
    return this.draining
  }

  private due() {
    const [low, high] = this.range
    return this.repository.read((db) =>
      db
        .query<{ ref: string; attempts: number }, [string, string, number, number]>(
          `SELECT ref,attempts FROM ${HOST_SESSION_QUEUE}
           WHERE ref>=? AND ref<? AND next_at<=? ORDER BY next_at,ref LIMIT ?`,
        )
        .all(low, high, this.now(), DRAIN_BATCH),
    )
  }

  private async readOne(ref: string, attempts: number) {
    const sessionID = ref.slice(this.range[0].length)
    const started = this.now()
    const seq = this.hintSeq
    const observe = this.observe.delete(sessionID)
    this.readAt.set(sessionID, started)
    try {
      this.reads.get++
      const record = await this.source.get(sessionID)
      let pending: HostSessionPending | null | undefined
      if (record && record.projectID === this.projectID && !record.archived) {
        // A busy session read for the first time has no stored counts to keep.
        if (
          observe ||
          (record.busy &&
            !this.repository.read((db) => storedHostSession(db, this.project, sessionID)))
        ) {
          this.observedAt.set(sessionID, this.now())
          this.reads.pending++
          pending = await this.source.pending(sessionID)
        }
      }
      if (record && record.projectID !== this.projectID) this.foreign.set(sessionID, true)
      if (this.closed) return
      await this.repository.retryBusy(() =>
        this.repository.atomic((db) => {
          writeHostSession(db, this.project, this.projectID, sessionID, record, pending, this.now())
          // A hint that arrived during the read reset the entry: leave it for the next read.
          if ((this.hinted.get(sessionID) ?? 0) <= seq)
            db.query(`DELETE FROM ${HOST_SESSION_QUEUE} WHERE ref=?`).run(ref)
        }),
      )
    } catch (error) {
      this.readAt.delete(sessionID)
      this.observedAt.delete(sessionID)
      if (observe) this.observe.add(sessionID)
      this.options.onError?.(error)
      try {
        parkQueueEntry(this.repository, HOST_SESSION_QUEUE, { ref, attempts }, error, this.now())
      } catch {
        // Still queued and due: the next drain retries it.
      }
    }
  }

  /** Resync and drain until nothing is due: for tests and tools that must wait. */
  async settle(): Promise<void> {
    while (!this.closed && (this.resyncing || this.draining || this.due().length)) {
      await this.resyncing
      await this.drain()
    }
  }

  close(): void {
    this.closed = true
    this.retry.clear()
    this.unsubscribe?.()
  }
}

type EventContext = Parameters<typeof joinNativeEvents>[0]

export type HostSessionFoldLease = { readonly fold: HostSessionFold; release(): void }

type Held = {
  fold: HostSessionFold
  repository: TaskRepository
  seed: ProjectionLease
  leave?: () => void
  refs: number
}
const registryKey = Symbol.for("lazers.host-session-fold.v1")
const host = globalThis as typeof globalThis & { [registryKey]?: Map<string, Held> }
const held = () => (host[registryKey] ??= new Map())

/**
 * The one fold of `projectDirectory` over the database at `path` in this process, started on the
 * first acquire with its own connection, its seed backfill and, given `events`, its native event
 * subscription (every attach resyncs). The last release stops all of it.
 */
export function startHostSessionFold(
  path: string,
  projectDirectory: string,
  projectID: string,
  source: HostSessionSource,
  options: HostSessionFoldOptions & { events?: EventContext; location?: string } = {},
): HostSessionFoldLease {
  const id = JSON.stringify([path, projectDirectory])
  let entry = held().get(id)
  if (!entry) {
    const repository = new TaskRepository(path, projectDirectory)
    const fold = new HostSessionFold(repository, projectID, source, options)
    let seed: ProjectionLease | undefined
    try {
      fold.start()
      seed = startProjection(path, projectDirectory, hostSessionSeedProjection, {
        scope: projectDirectory,
        ...(options.onError ? { onError: options.onError } : {}),
      })
    } catch (error) {
      fold.close()
      repository.close()
      throw error
    }
    entry = { fold, repository, seed, refs: 0 }
    if (options.events)
      entry.leave = joinNativeEvents(
        options.events,
        HOST_SESSION_EVENT_TYPES,
        {
          attached: () => void fold.resync(),
          event: (event) => fold.hint(event),
        },
        options.location,
      )
    held().set(id, entry)
  }
  entry.refs++
  const taken = entry
  let released = false
  return {
    fold: taken.fold,
    release() {
      if (released) return
      released = true
      if (--taken.refs > 0) return
      held().delete(id)
      taken.leave?.()
      taken.seed.release()
      taken.fold.close()
      taken.repository.close()
    },
  }
}
