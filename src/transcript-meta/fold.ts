import { coalescedDrain, leaseFold, type QueueEntry } from "../core/async-fold.ts"
import { joinNativeEvents } from "../core/event-hub.ts"
import type { HostMessageClient } from "../core/host-messages.ts"
import { HOST_MESSAGE_PAGE_SIZE } from "../core/host-messages.ts"
import { hostPage } from "../core/host-page.ts"
import { LruMap, SESSION_MEMO_ENTRIES } from "../core/process-shared.ts"
import { parkQueueEntry, QueueRetryTimer } from "../core/queue-retry.ts"
import { databaseChanges } from "../database-events.ts"
import { startProjection, type ProjectionLease } from "../projections/owner.ts"
import { TaskRepository } from "../storage.ts"
import {
  ensureTranscriptMetaSchema,
  isAttemptSession,
  isShownSession,
  resetTranscriptCursor,
  resyncHostSessions,
  windowCutoff,
  markTranscriptUnavailable,
  queueTranscript,
  storedTranscriptSession,
  TRANSCRIPT_META_QUEUE,
  transcriptMetaSeedProjection,
  transcriptRefRange,
  writeTranscriptPage,
  type StoredTranscriptSession,
} from "./schema.ts"

/**
 * The fold that keeps `transcript_steps` and `transcript_sessions` current: one per project and
 * database in this process, the only writer of the tables.
 *
 * ```
 * native step/turn event (hint) ─┐
 * attempt inserted or state moved ├─► transcript_meta_dirty ─► fold: message.list after the stored
 * attach resync, seed backfill ──┘       (ref, next_at)          cursor, a page at a time; each
 *                                                                 page and its cursor in one
 *                                                                 transaction
 * ```
 *
 * - An event is a hint, never a fact: it names a session to read from its cursor. A hint created
 *   before the newest read of the session began reads nothing; a busy session is read at most
 *   once per {@link HINT_SPACING_MS} (the entry waits, nothing is dropped).
 * - Lost event: an attempt's insert and every state change queue its session (trigger), so the
 *   last messages of a finished attempt are read without an event; every subscription attach
 *   queues the active attempts and the sessions not read in full.
 * - Idle (nothing queued or parked): no timer and no read; one table subscription.
 * - A failed read stays queued with its error and a backoff (1 s to 5 min); the rows already
 *   folded stay. A session the host no longer has leaves the queue and keeps its rows.
 */
export const HINT_EVENT_TYPES = [
  "session.step.started",
  "session.step.streamed",
  "session.step.ended",
  "session.step.failed",
  "session.retry.scheduled",
  "session.inbox.delivered",
  "session.shell.ended",
  "session.compaction.ended",
  "session.revert.committed",
  "session.idle",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const

/**
 * The least time between two hinted reads of one session. A running attempt sends several step
 * events a second; each read costs one host page (the tail, at most 50 messages) and writes only
 * what changed, so this bounds a busy session to one page read per 2 s. The attempt's own state
 * change queues the final read without waiting.
 */
const HINT_SPACING_MS = 2_000
/** Queue entries per read of the queue: a unit of work, the rest wait for the next read. */
const DRAIN_BATCH = 20
/** Attempt rows per resync page: an index range scan and queue inserts. */
const RESYNC_ROWS = 500

const record = (value: unknown) =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined

/** The session a native event names, and when the host created the event. */
function transcriptHint(event: unknown) {
  const info = record(event)
  const sessionID = record(info?.data)?.sessionID
  if (typeof sessionID !== "string" || !sessionID || sessionID.length > 200) return undefined
  const created = info?.created
  return {
    sessionID,
    created: typeof created === "number" && Number.isFinite(created) ? created : undefined,
  }
}

/**
 * `message.list` of a session the host no longer has fails with `SessionNotFoundError` (HTTP
 * 404; `@opencode/protocol` groups/message.js declares it), which the client rejects with.
 */
const notFound = (error: unknown) => {
  const info = record(error)
  return (
    info?._tag === "SessionNotFoundError" ||
    info?.name === "SessionNotFoundError" ||
    info?.status === 404 ||
    record(info?.response)?.status === 404
  )
}

/** `message.list` refuses a cursor it no longer knows (HTTP 400). */
const invalidCursor = (error: unknown) => record(error)?._tag === "InvalidCursorError"

export type TranscriptMetaFoldOptions = {
  onError?: (error: unknown) => void
  now?: () => number
  /** Hinted read spacing; tests set 0. */
  spacingMs?: number
  pageSize?: number
}

export class TranscriptMetaFold {
  private closed = false
  private readonly loop: ReturnType<typeof coalescedDrain>
  private readonly retry: QueueRetryTimer
  private unsubscribe: (() => void) | undefined
  /** When the newest read of each session began: an event created before it is already read. */
  private readonly readAt = new LruMap<string, number>(SESSION_MEMO_ENTRIES)
  /** The hint sequence that last queued each session: a read begun before it leaves the entry. */
  private readonly hinted = new LruMap<string, number>(SESSION_MEMO_ENTRIES)
  private hintSeq = 0
  /** Sessions the product shows (a point read, memoized when true). */
  private readonly shown = new LruMap<string, boolean>(SESSION_MEMO_ENTRIES)
  private readonly range: readonly [string, string]
  private readonly now: () => number
  private readonly spacing: number
  private readonly pageSize: number
  /** Host page reads and pages written: a measurement for tests and diagnostics. */
  readonly reads = { pages: 0, sessions: 0 }

  constructor(
    private readonly repository: TaskRepository,
    private readonly client: HostMessageClient,
    private readonly options: TranscriptMetaFoldOptions = {},
  ) {
    this.range = transcriptRefRange(repository.projectDirectory)
    this.now = options.now ?? Date.now
    this.spacing = options.spacingMs ?? HINT_SPACING_MS
    this.pageSize = options.pageSize ?? HOST_MESSAGE_PAGE_SIZE
    this.retry = new QueueRetryTimer(
      repository,
      TRANSCRIPT_META_QUEUE,
      this.range,
      this.now,
      () => {
        void this.drain()
      },
    )
    this.loop = coalescedDrain({
      closed: () => this.closed,
      due: () => this.due(),
      read: (entry) => this.readOne(entry),
      schedule: () => this.retry.schedule(),
      onError: options.onError,
    })
  }

  private get project() {
    return this.repository.projectDirectory
  }

  start(): void {
    ensureTranscriptMetaSchema(this.repository)
    // Seeds and attempt triggers write the queue on other connections; any queue write wakes it.
    this.unsubscribe = databaseChanges.subscribeTables(this.repository.path, (tables) => {
      if (tables.has(TRANSCRIPT_META_QUEUE)) void this.drain()
    })
    void this.drain()
  }

  /** A native event: queue its session, when shown, unless a read begun after the event covers it. */
  hint(event: unknown): void {
    if (this.closed) return
    const hint = transcriptHint(event)
    if (!hint) return
    try {
      let known = this.shown.get(hint.sessionID)
      if (known === undefined) {
        known = this.repository.read((db) =>
          isShownSession(db, this.project, hint.sessionID, windowCutoff(db, this.now())),
        )
        // An unknown session may be shown later (its host row is written, then its trigger queues
        // it); only a shown one is remembered.
        if (known) this.shown.set(hint.sessionID, true)
      }
      if (!known) return
      const readAt = this.readAt.get(hint.sessionID)
      if (hint.created !== undefined && readAt !== undefined && hint.created < readAt) return
      this.hinted.set(hint.sessionID, ++this.hintSeq)
      const at = readAt !== undefined && this.spacing > 0 ? readAt + this.spacing : 0
      this.repository.atomic((db) =>
        queueTranscript(db, this.project, hint.sessionID, "hint", at > this.now() ? at : 0),
      )
    } catch (error) {
      // The next event, state change or attach queues it again.
      this.options.onError?.(error)
    }
  }

  /** True when the fold holds no timer and runs nothing. */
  idle(): boolean {
    return !this.retry.pending && !this.loop.running()
  }

  /**
   * After a subscription attach: queue the active attempts' sessions and every attempt session
   * not yet read in full, a page of attempt rows at a time (finished, fully read attempt sessions
   * were queued by their last state change), then the windowed host sessions that are busy or not
   * read in full.
   */
  resync(): void {
    if (this.closed) return
    try {
      let after = 0
      for (;;) {
        const rows = this.repository.read((db) =>
          db
            .query<{ id: number; session_id: string }, [string, number, string]>(
              `SELECT a.rowid AS id, a.session_id FROM runner_attempts a
               LEFT JOIN transcript_sessions t
                 ON t.project_directory=? AND t.session_id=a.session_id
               WHERE a.rowid>?
                 AND (a.state IN ('preparing','running','verifying')
                      OR t.read_state IS NULL OR t.read_state<>'available')
                 AND COALESCE(a.project_directory,(SELECT p.project_directory FROM runner_plans p WHERE p.id=a.plan_id))=?
               ORDER BY a.rowid LIMIT ${RESYNC_ROWS}`,
            )
            .all(this.project, after, this.project),
        )
        if (rows.length)
          this.repository.atomic((db) => {
            for (const row of rows)
              if (isAttemptSession(db, this.project, row.session_id))
                queueTranscript(db, this.project, row.session_id, "seed")
          })
        if (rows.length < RESYNC_ROWS || this.closed) break
        after = rows.at(-1)!.id
      }
      if (!this.closed)
        resyncHostSessions(
          (run) => this.repository.read(run),
          (run) => this.repository.atomic(run),
          this.project,
          this.now(),
        )
    } catch (error) {
      this.options.onError?.(error)
    }
    void this.drain()
  }

  /** Read every due queued session of this project; coalesces concurrent calls. */
  drain(): Promise<void> {
    return this.loop.drain()
  }

  /**
   * The next due entries: hints first (`next_at` 0), then seeds and resyncs, newest host update
   * first, so the sessions the Monitor shows now are read before old lineages.
   */
  private due(): QueueEntry[] {
    const [low, high] = this.range
    return this.repository.read((db) =>
      db
        .query<QueueEntry, [string, string, string, string, number, number]>(
          `SELECT q.ref,q.attempts FROM ${TRANSCRIPT_META_QUEUE} q
           LEFT JOIN host_session_state h
             ON h.project_directory=? AND h.session_id=substr(q.ref, length(?)+1)
           WHERE q.ref>=? AND q.ref<? AND q.next_at<=?
           ORDER BY q.next_at, h.host_updated_at DESC, q.ref LIMIT ?`,
        )
        .all(this.project, low, low, high, this.now(), DRAIN_BATCH),
    )
  }

  /** Leave the queue unless a hint arrived during the read (it reset the entry for the next). */
  private settled(ref: string, sessionID: string, seq: number) {
    if ((this.hinted.get(sessionID) ?? 0) <= seq)
      this.repository.atomic((db) =>
        db.query(`DELETE FROM ${TRANSCRIPT_META_QUEUE} WHERE ref=?`).run(ref),
      )
  }

  private async readOne({ ref, attempts }: QueueEntry) {
    const sessionID = ref.slice(this.range[0].length)
    const seq = this.hintSeq
    this.readAt.set(sessionID, this.now())
    this.reads.sessions++
    /** The cursor of the page being read: a refused cursor is reset only when there was one. */
    let reading: string | null = null
    try {
      let from: StoredTranscriptSession = this.repository.read((db) =>
        storedTranscriptSession(db, this.project, sessionID),
      ) ?? { cursor: null, base: 0, messageCount: 0, state: "not-read" }
      const seen = new Set<string>()
      for (;;) {
        this.reads.pages++
        reading = from.cursor
        const page = await this.client.message.list({
          sessionID: sessionID as never,
          limit: this.pageSize,
          ...hostPage("asc", from.cursor ?? undefined),
        })
        if (this.closed) return
        const next = page.cursor.next
        const end = !next || next === from.cursor || seen.has(next)
        if (next) seen.add(next)
        const start = from
        from = await this.repository.retryBusy(() =>
          this.repository.atomic((db) =>
            writeTranscriptPage(
              db,
              this.project,
              sessionID,
              start,
              page.data,
              end ? undefined : next,
            ),
          ),
        )
        if (end) break
      }
      this.settled(ref, sessionID, seq)
    } catch (error) {
      this.readAt.delete(sessionID)
      if (invalidCursor(error) && reading !== null) {
        // The host no longer accepts the stored cursor: read again from the start (the rows are
        // upserted by message id); the entry stays due.
        this.repository.atomic((db) => resetTranscriptCursor(db, this.project, sessionID))
        return
      }
      try {
        this.repository.atomic((db) => markTranscriptUnavailable(db, this.project, sessionID))
        if (notFound(error)) {
          // Gone from the host: the rows already folded stay; nothing is left to read.
          this.settled(ref, sessionID, seq)
          return
        }
      } catch {
        // Still queued: the next drain retries it.
      }
      this.options.onError?.(error)
      try {
        parkQueueEntry(this.repository, TRANSCRIPT_META_QUEUE, { ref, attempts }, error, this.now())
      } catch {
        // Still queued and due: the next drain retries it.
      }
    }
  }

  /** Drain until nothing is due: for tests and tools that must wait. */
  async settle(): Promise<void> {
    do await this.drain()
    while (!this.closed && (this.loop.running() || this.due().length))
  }

  close(): void {
    this.closed = true
    this.retry.clear()
    this.unsubscribe?.()
  }
}

type EventContext = Parameters<typeof joinNativeEvents>[0]

export type TranscriptMetaFoldLease = { readonly fold: TranscriptMetaFold; release(): void }

const registryKey = Symbol.for("lazers.transcript-meta-fold.v1")

/**
 * The one fold of `projectDirectory` over the database at `path` in this process, started on the
 * first acquire with its own connection, its seed backfill and, given `events`, its native event
 * subscription (every attach resyncs). The last release stops all of it.
 */
export function startTranscriptMetaFold(
  path: string,
  projectDirectory: string,
  client: HostMessageClient,
  options: TranscriptMetaFoldOptions & { events?: EventContext; location?: string } = {},
): TranscriptMetaFoldLease {
  return leaseFold(registryKey, JSON.stringify([path, projectDirectory]), () => {
    const repository = new TaskRepository(path, projectDirectory)
    const fold = new TranscriptMetaFold(repository, client, options)
    let seed: ProjectionLease | undefined
    try {
      fold.start()
      seed = startProjection(path, projectDirectory, transcriptMetaSeedProjection, {
        scope: projectDirectory,
        ...(options.onError ? { onError: options.onError } : {}),
      })
    } catch (error) {
      fold.close()
      repository.close()
      throw error
    }
    const leave = options.events
      ? joinNativeEvents(
          options.events,
          HINT_EVENT_TYPES,
          { attached: () => fold.resync(), event: (event) => fold.hint(event) },
          options.location,
        )
      : undefined
    const taken = seed
    return {
      fold,
      stop() {
        leave?.()
        taken.release()
        fold.close()
        repository.close()
      },
    }
  })
}
