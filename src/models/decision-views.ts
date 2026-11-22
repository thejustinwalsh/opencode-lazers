import { databaseChanges } from "../database-events.ts"
import { acquireSharedConnection } from "../storage.ts"
import type { SharedConnection } from "../storage.ts"
import type { BenchmarkRoute } from "./benchmark-baseline.ts"
import {
  dropIdleDecisionViews,
  ensureDecisionViewSchema,
  openDecisionView,
  recordDecisionViewError,
  storedView,
  writeDecisionView,
  type ViewWrite,
} from "./decision-store.ts"
import { PROJECTION_IDLE_DROP_MS } from "./decision-projection.ts"
import { READ_DEADLINE_MS, withReadDeadline } from "./read-deadline.ts"
import type {
  DecisionViewCall,
  DecisionViewRequest,
  DecisionViewResult,
} from "./decision-view-build.ts"

/**
 * The main-thread side of the stored decision views of one database: it opens a view when a
 * stream asks for it, has the decision worker compute it, and writes the rows (the one writer).
 *
 * ```
 * stream open ─► authorize ─► open(): view row (point write) ─► build now
 * table change (revision, candidates, evidence, mappings) ─► views a stream holds
 *     ─► build, at most once per 15 s each (the worker's warm cadence)
 * stream closed or lease expired ─► release(): one holder fewer; the last holder's release
 *     aborts a build in flight (nothing written) and the view is not built again until reopened
 * build: routes (host settings) ─► worker.view(identity stored) ─┬─ unchanged ─► nothing written
 *                                                                └─ rows ─► writeDecisionView (paged)
 * hourly, on open: views nobody opened for 7 days are dropped
 * a build that has not settled by the read deadline (a host routes read that never answers) is
 *     abandoned and recorded; the view is built again at its cadence, so one stuck read never
 *     leaves a held view on its old prices
 * ```
 *
 * With no write to a watched table an open panel costs nothing: no build, no read. A view nobody
 * holds is never built; its stored rows stay until the idle sweep, and a reopen builds it at once
 * (an unchanged identity writes nothing).
 */
const VIEW_REFRESH_MS = 15_000
const VIEW_DEBOUNCE_MS = 1_000
const SWEEP_INTERVAL_MS = 60 * 60_000
const WATCHED = new Set([
  "observation_revisions",
  "model_candidate_sets",
  "model_evidence_refreshes",
  "model_endpoint_pricing_refreshes",
  "model_mappings",
])

type ViewWorker = {
  view(
    projectDirectory: string,
    call: DecisionViewCall,
    signal?: AbortSignal,
  ): Promise<DecisionViewResult>
}
type RoutedReader = (
  projectDirectory: string,
  taskID: string | null,
  signal?: AbortSignal,
) => Promise<BenchmarkRoute[]>

type Active = {
  project: string
  request: DecisionViewRequest
  /** Streams that hold the view now (`open` without its `release`). */
  held: number
  builtAt: number
  running?: Promise<void>
  /** Aborts the build in flight when the last holder lets go. */
  abort?: AbortController
  again: boolean
  timer?: ReturnType<typeof setTimeout>
}

export type DecisionViewsOptions = {
  now?: () => number
  refreshMs?: number
  debounceMs?: number
  /** How long one build may take before it is abandoned; the Models read deadline when absent. */
  deadlineMs?: number
}

export class DecisionViews {
  private shared: SharedConnection | undefined
  private unsubscribe: (() => void) | undefined
  private readonly active = new Map<number, Active>()
  private lastSweep = 0
  private closed = false
  /** The last write of each view: rows, transactions and their times, for measurement. */
  readonly writes = new Map<number, ViewWrite>()
  lastError: Error | undefined

  constructor(
    private readonly path: string,
    private readonly worker: ViewWorker,
    private readonly routed: RoutedReader,
    private readonly options: DecisionViewsOptions = {},
  ) {}

  private now() {
    return this.options.now?.() ?? Date.now()
  }

  private connection() {
    if (!this.shared) {
      this.shared = acquireSharedConnection(this.path)
      ensureDecisionViewSchema(this.shared)
    }
    return this.shared
  }

  /** The view of `request`, created when missing; its build starts now. A point write. */
  open(projectDirectory: string, request: DecisionViewRequest): number {
    if (this.closed) throw new Error("Model decision views are closed")
    const db = this.connection().db
    const now = this.now()
    const view = db
      .transaction(() => openDecisionView(db, projectDirectory, request, now))
      .immediate()
    const entry = this.active.get(view.id)
    if (entry) entry.held++
    else
      this.active.set(view.id, {
        project: projectDirectory,
        request,
        held: 1,
        builtAt: 0,
        again: false,
      })
    this.unsubscribe ??= databaseChanges.subscribeTables(this.path, (tables) => {
      for (const table of tables) if (WATCHED.has(table)) return this.changed()
    })
    void this.build(view.id)
    if (now - this.lastSweep > SWEEP_INTERVAL_MS) {
      this.lastSweep = now
      try {
        // A held view is being read, however long ago it was opened.
        const held = [...this.active].filter(([, item]) => item.held > 0).map(([id]) => id)
        db.query(
          "UPDATE model_decision_views SET last_read_at=? WHERE id IN (SELECT value FROM json_each(?))",
        ).run(now, JSON.stringify(held))
        dropIdleDecisionViews(db, { now, idleMs: PROJECTION_IDLE_DROP_MS })
      } catch (error) {
        this.lastError = error instanceof Error ? error : new Error(String(error))
      }
    }
    return view.id
  }

  /**
   * A stream that held the view closed or expired (`release` of the Models sources). When it was
   * the last holder the view stops: a build in flight is aborted and writes nothing, a scheduled
   * one is cancelled, and no table change builds it again until a stream reopens it.
   */
  release(viewID: number) {
    const entry = this.active.get(viewID)
    if (!entry || entry.held === 0) return
    entry.held--
    if (entry.held > 0) return
    clearTimeout(entry.timer)
    entry.abort?.abort(new Error("Model decision view released"))
    this.active.delete(viewID)
  }

  /** Streams holding a view now; for tests and diagnostics. */
  holders(viewID: number) {
    return this.active.get(viewID)?.held ?? 0
  }

  /** Build a held view again at its cadence, unless a build is already scheduled. */
  private schedule(viewID: number, entry: Active) {
    if (entry.timer || entry.held === 0 || this.closed) return
    const now = this.now()
    const at = Math.max(
      now + (this.options.debounceMs ?? VIEW_DEBOUNCE_MS),
      entry.builtAt + (this.options.refreshMs ?? VIEW_REFRESH_MS),
    )
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      void this.build(viewID)
    }, at - now)
    entry.timer.unref()
  }

  /** A watched table changed: rebuild the views a stream holds, each at its cadence. */
  private changed() {
    for (const [viewID, entry] of this.active) this.schedule(viewID, entry)
    if (!this.active.size) {
      this.unsubscribe?.()
      this.unsubscribe = undefined
    }
  }

  /** Build one view; concurrent calls coalesce into one more pass. Never throws. */
  build(viewID: number): Promise<void> {
    const entry = this.active.get(viewID)
    if (!entry || entry.held === 0 || this.closed) return Promise.resolve()
    if (entry.running) {
      entry.again = true
      return entry.running
    }
    entry.running = (async () => {
      do {
        entry.again = false
        await this.buildOnce(viewID, entry)
      } while (entry.again && entry.held > 0 && !this.closed)
    })().finally(() => {
      entry.running = undefined
    })
    return entry.running
  }

  private async buildOnce(viewID: number, entry: Active) {
    const db = this.connection().db
    const abort = new AbortController()
    entry.abort = abort
    try {
      const stored = storedView(db, viewID)
      if (!stored) {
        // Dropped by the idle sweep: the next open creates it again.
        this.active.delete(viewID)
        return
      }
      // A build in flight holds the view's `running`: every later change only asks for one more
      // pass. A read that never settles would hold it for good, so a build has the read deadline.
      const result = await withReadDeadline(
        abort.signal,
        async (signal) => {
          const routed = await this.routed(entry.project, entry.request.taskID, signal)
          signal.throwIfAborted()
          return this.worker.view(
            entry.project,
            { ...entry.request, routed, known: stored.identity },
            signal,
          )
        },
        this.options.deadlineMs ?? READ_DEADLINE_MS,
      )
      abort.signal.throwIfAborted()
      entry.builtAt = this.now()
      if ("unchanged" in result || this.closed || !storedView(db, viewID)) return
      this.writes.set(viewID, writeDecisionView(db, viewID, result, this.now()))
    } catch (error) {
      // Released mid-build: nobody holds the view, so there is nothing to report.
      if (abort.signal.aborted) return
      this.lastError = error instanceof Error ? error : new Error(String(error))
      try {
        db.transaction(() =>
          recordDecisionViewError(db, viewID, this.lastError!.message),
        ).immediate()
      } catch {
        // The database is unavailable; the next change or open retries.
      }
      // Built again at the cadence, change or not: a failed build is not the view's last word.
      entry.builtAt = this.now()
      this.schedule(viewID, entry)
    } finally {
      if (entry.abort === abort) entry.abort = undefined
    }
  }

  /** Wait for every build in flight; tests and tools that must see the rows use it. */
  async settle() {
    while ([...this.active.values()].some((entry) => entry.running))
      await Promise.all([...this.active.values()].map((entry) => entry.running))
  }

  close() {
    this.closed = true
    for (const entry of this.active.values()) {
      clearTimeout(entry.timer)
      entry.abort?.abort(new Error("Model decision views are closed"))
    }
    this.active.clear()
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.shared?.release()
    this.shared = undefined
  }
}
