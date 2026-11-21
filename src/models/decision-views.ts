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
import type { DecisionViewCall, DecisionViewRequest, DecisionViewResult } from "./decision-view.ts"

/**
 * The main-thread side of the stored decision views of one database: it opens a view when a
 * stream asks for it, has the decision worker compute it, and writes the rows (the one writer).
 *
 * ```
 * stream open ─► authorize ─► open(): view row (point write) ─► build now
 * table change (revision, candidates, evidence, mappings) ─► views a stream holds, or let go of
 *     in the last 10 min ─► build, at most once per 15 s each (the worker's warm cadence)
 * stream closed or lease expired ─► release(): one holder fewer
 * build: routes (host settings) ─► worker.view(identity stored) ─┬─ unchanged ─► nothing written
 *                                                                └─ rows ─► writeDecisionView (paged)
 * hourly, on open: views nobody opened for 7 days are dropped
 * ```
 *
 * With no write to a watched table an open panel costs nothing: no build, no read.
 */
const VIEW_ACTIVE_MS = 10 * 60_000
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
  /** When the last holder let go (or, while held, the last open). */
  openedAt: number
  /** Streams that hold the view now (`open` without its `release`). */
  held: number
  builtAt: number
  running?: Promise<void>
  again: boolean
  timer?: ReturnType<typeof setTimeout>
}

export type DecisionViewsOptions = {
  now?: () => number
  refreshMs?: number
  debounceMs?: number
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
    if (entry) {
      entry.openedAt = now
      entry.held++
    } else
      this.active.set(view.id, {
        project: projectDirectory,
        request,
        openedAt: now,
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
   * A stream that held the view closed or expired (`release` of the Models sources). The view
   * stays current for VIEW_ACTIVE_MS more, so a panel that reopens it finds it current.
   */
  release(viewID: number) {
    const entry = this.active.get(viewID)
    if (!entry || entry.held === 0) return
    entry.held--
    if (entry.held === 0) entry.openedAt = this.now()
  }

  /** Streams holding a view now; for tests and diagnostics. */
  holders(viewID: number) {
    return this.active.get(viewID)?.held ?? 0
  }

  /** A watched table changed: rebuild the views held or let go of recently, each at its cadence. */
  private changed() {
    const now = this.now()
    for (const [viewID, entry] of this.active) {
      if (entry.held === 0 && now - entry.openedAt > VIEW_ACTIVE_MS) {
        clearTimeout(entry.timer)
        this.active.delete(viewID)
        continue
      }
      if (entry.timer) continue
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
    if (!this.active.size) {
      this.unsubscribe?.()
      this.unsubscribe = undefined
    }
  }

  /** Build one view; concurrent calls coalesce into one more pass. Never throws. */
  build(viewID: number): Promise<void> {
    const entry = this.active.get(viewID)
    if (!entry || this.closed) return Promise.resolve()
    if (entry.running) {
      entry.again = true
      return entry.running
    }
    entry.running = (async () => {
      do {
        entry.again = false
        await this.buildOnce(viewID, entry)
      } while (entry.again && !this.closed)
    })().finally(() => {
      entry.running = undefined
    })
    return entry.running
  }

  private async buildOnce(viewID: number, entry: Active) {
    const db = this.connection().db
    try {
      const stored = storedView(db, viewID)
      if (!stored) {
        // Dropped by the idle sweep: the next open creates it again.
        this.active.delete(viewID)
        return
      }
      const routed = await this.routed(entry.project, entry.request.taskID)
      const result = await this.worker.view(entry.project, {
        ...entry.request,
        routed,
        known: stored.identity,
      })
      entry.builtAt = this.now()
      if ("unchanged" in result || this.closed || !storedView(db, viewID)) return
      this.writes.set(viewID, writeDecisionView(db, viewID, result, this.now()))
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error))
      try {
        db.transaction(() =>
          recordDecisionViewError(db, viewID, this.lastError!.message),
        ).immediate()
      } catch {
        // The database is unavailable; the next change or open retries.
      }
    }
  }

  /** Wait for every build in flight; tests and tools that must see the rows use it. */
  async settle() {
    while ([...this.active.values()].some((entry) => entry.running))
      await Promise.all([...this.active.values()].map((entry) => entry.running))
  }

  close() {
    this.closed = true
    for (const entry of this.active.values()) clearTimeout(entry.timer)
    this.active.clear()
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.shared?.release()
    this.shared = undefined
  }
}
