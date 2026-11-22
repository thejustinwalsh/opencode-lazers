import type { Database } from "bun:sqlite"
import { databaseChanges } from "../database-events.ts"
import { workIsActive } from "../retention/store.ts"
import type { BackfillPacing } from "../progress/display-backfill.ts"
import { TaskRepository } from "../storage.ts"
import {
  advanceProjectionState,
  ensureProjectionStateSchema,
  openProjectionState,
  projectionStatus,
  recordProjectionError,
  type ProjectionStatus,
} from "./lifecycle.ts"
import { nextDueAt, type QueueDrain } from "./queue.ts"

/**
 * The shared owner of a stored projection: it pages the projection's backfill until the
 * `projection` lifecycle is `ready`, and drains the dirty queue entries no writer drained (another
 * connection's writes fire the triggers but not this process's drain hook) or that a failed refresh
 * parked. Idle (ready, queue empty, nothing parked) it holds one table-change subscription and no
 * timer.
 *
 * ```
 * start ─► open state ─┬─ backfilling ─► timer: slice of pages (≤ sliceMs) ─► wait ─► … ─► ready
 *                      └─ ready ───────► nothing
 * queue table written (any connection) ─► drain loop, one transaction per budget ─► empty
 * entry parked ─► one timer at the earliest next_at ─► drain loop
 * ```
 *
 * One owner per database, projection and scope in this process, shared by every project core that
 * loads it (like the schedule owner); the last release stops it and closes its connection.
 */
export type BackfillPage = { next: number; done: boolean }
export type BackfillPhase = {
  name: string
  /**
   * One page in the owner's write transaction, from watermark `after` (0 when the phase starts).
   * Returns the watermark the next page starts from, and whether the phase passed its last row.
   * A page is a unit of work: keep it well under 50 ms on a live-sized table.
   */
  page(db: Database, scope: string, after: number): BackfillPage
}
export type ProjectionSpec = {
  /** The `projection_state` name. */
  name: string
  /** The derivation's generation: raising it rewrites every row through the backfill again. */
  generation: number
  /** Ordered phases; the projection is `ready` when the last one is done. */
  backfill: readonly BackfillPhase[]
  /** The dirty queue table and one transaction's drain of it. */
  queue?: { table: string; drain(db: Database): QueueDrain }
}

/** The progress display backfill's pacing (`src/progress/display-backfill.ts`), measured there. */
const DEFAULT_PROJECTION_PACING: BackfillPacing = {
  startMs: 2_000,
  quiet: { sliceMs: 40, waitMs: 25 },
  busy: { sliceMs: 6, waitMs: 500 },
  retryMs: 30_000,
}

export type ProjectionOptions = {
  /** `""` for a database-wide projection, else the project directory it covers. */
  scope?: string
  pacing?: BackfillPacing
  onError?: (error: unknown) => void
  /** Clock for slices; tests replace it. */
  now?: () => number
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export class ProjectionOwner {
  private closed = false
  private backfillTimer: ReturnType<typeof setTimeout> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private unsubscribe: (() => void) | undefined
  private draining: Promise<void> | undefined
  private again = false
  private readonly scope: string
  private readonly pacing: BackfillPacing
  private readonly now: () => number

  constructor(
    private readonly repository: TaskRepository,
    private readonly spec: ProjectionSpec,
    private readonly options: ProjectionOptions = {},
  ) {
    this.scope = options.scope ?? ""
    this.pacing = options.pacing ?? DEFAULT_PROJECTION_PACING
    this.now = options.now ?? performance.now.bind(performance)
  }

  start(): void {
    ensureProjectionStateSchema(this.repository)
    const queue = this.spec.queue
    if (queue)
      this.unsubscribe = databaseChanges.subscribeTables(this.repository.path, (tables) => {
        if (tables.has(queue.table)) void this.drain()
      })
    // Read first: a current state row (the load's prepare step opened it) takes no write lock.
    const current = this.repository.read((db) => projectionStatus(db, this.spec.name, this.scope))
    const state =
      current && current.generation >= this.spec.generation
        ? current
        : this.repository.atomic((db) =>
            openProjectionState(db, this.spec.name, this.spec.generation, this.scope),
          )
    if (state.state === "backfilling" && state.generation === this.spec.generation)
      this.scheduleBackfill(this.pacing.startMs)
    void this.drain()
  }

  status(): ProjectionStatus | undefined {
    return this.repository.read((db) => projectionStatus(db, this.spec.name, this.scope))
  }

  /** True when the owner holds no timer and runs nothing: what an idle projection costs. */
  idle(): boolean {
    return !this.backfillTimer && !this.retryTimer && !this.draining
  }

  /**
   * One page in its own write transaction. Returns true while more pages remain. A stored
   * generation other than the code's (a newer plugin copy owns it) stops this copy's backfill.
   */
  backfillPage(): boolean {
    const { name, generation, backfill } = this.spec
    return this.repository.atomic((db) => {
      const row = projectionStatus(db, name, this.scope)
      if (!row || row.state === "ready" || row.generation !== generation) return false
      const phase = backfill[row.phase]
      if (!phase) {
        advanceProjectionState(db, name, this.scope, { phase: row.phase, after: 0, ready: true })
        return false
      }
      const page = phase.page(db, this.scope, row.after)
      const last = row.phase === backfill.length - 1
      if (!page.done)
        advanceProjectionState(db, name, this.scope, {
          phase: row.phase,
          after: page.next,
          ready: false,
        })
      else
        advanceProjectionState(db, name, this.scope, {
          phase: last ? row.phase : row.phase + 1,
          after: last ? page.next : 0,
          ready: last,
        })
      return !(page.done && last)
    })
  }

  /** Pages until `budgetMs` has passed (at least one page); true while more remain. */
  slice(budgetMs: number): boolean {
    const deadline = this.now() + budgetMs
    let more: boolean
    do more = this.backfillPage()
    while (more && this.now() < deadline && !this.closed)
    return more
  }

  private scheduleBackfill(ms: number) {
    if (this.closed || this.backfillTimer) return
    this.backfillTimer = setTimeout(() => {
      this.backfillTimer = undefined
      this.backfillStep()
    }, ms)
    this.backfillTimer.unref?.()
  }

  private backfillStep() {
    if (this.closed) return
    let wait: number
    try {
      const quiet = !this.repository.read((db) => {
        try {
          return workIsActive(db)
        } catch {
          // No runner schema in this database: nothing can be active.
          return false
        }
      })
      const pace = quiet ? this.pacing.quiet : this.pacing.busy
      if (!this.slice(pace.sliceMs)) return
      wait = pace.waitMs
    } catch (error) {
      this.fail(error)
      wait = this.pacing.retryMs
    }
    this.scheduleBackfill(wait)
  }

  private fail(error: unknown) {
    this.options.onError?.(error)
    try {
      this.repository.atomic((db) =>
        recordProjectionError(db, this.spec.name, this.scope, message(error)),
      )
    } catch {
      // The database is unavailable; the next slice or drain tries again.
    }
  }

  /** Drain until nothing is due; coalesces concurrent calls. */
  drain(): Promise<void> {
    const queue = this.spec.queue
    if (!queue || this.closed) return Promise.resolve()
    this.again = true
    this.draining ??= (async () => {
      while (this.again && !this.closed) {
        this.again = false
        try {
          for (;;) {
            const result = await this.repository.retryBusy(() =>
              this.repository.atomic((db) => queue.drain(db)),
            )
            if (result.failed.length) this.fail(new Error(result.failed[0]!.error))
            if (!result.remaining || this.closed) break
            await Bun.sleep(0)
          }
        } catch (error) {
          // A busy or failing database leaves the work queued; the next change or retry resumes it.
          this.fail(error)
        }
        this.scheduleRetry()
      }
    })().finally(() => {
      this.draining = undefined
    })
    return this.draining
  }

  /** One timer, only while an entry is parked; it fires at the earliest backoff. */
  private scheduleRetry() {
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    const queue = this.spec.queue
    if (!queue || this.closed) return
    let at: number | undefined
    try {
      at = this.repository.read((db) => nextDueAt(db, queue.table))
    } catch {
      return
    }
    if (at === undefined) return
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = undefined
        void this.drain()
      },
      Math.max(0, at - Date.now()),
    )
    this.retryTimer.unref?.()
  }

  /** Backfill to the end without pacing, then drain: for tests and tools that must wait. */
  async settle(): Promise<void> {
    while (!this.closed && this.backfillPage()) await Bun.sleep(0)
    if (this.backfillTimer) {
      clearTimeout(this.backfillTimer)
      this.backfillTimer = undefined
    }
    await this.drain()
  }

  close(): void {
    this.closed = true
    clearTimeout(this.backfillTimer)
    clearTimeout(this.retryTimer)
    this.backfillTimer = this.retryTimer = undefined
    this.unsubscribe?.()
  }
}

export type ProjectionLease = {
  readonly owner: ProjectionOwner
  release(): void
}

type Held = { owner: ProjectionOwner; repository: TaskRepository; refs: number }
const registryKey = Symbol.for("lazers.projections.owners.v1")
const host = globalThis as typeof globalThis & { [registryKey]?: Map<string, Held> }
const held = () => (host[registryKey] ??= new Map())

/**
 * The one owner of `spec` (and scope) over the database at `path` in this process, started on the
 * first acquire. Its own connection; the last release stops it and closes the connection.
 */
export function startProjection(
  path: string,
  projectDirectory: string,
  spec: ProjectionSpec,
  options: ProjectionOptions = {},
): ProjectionLease {
  const id = JSON.stringify([path, spec.name, options.scope ?? ""])
  let entry = held().get(id)
  if (!entry) {
    const repository = new TaskRepository(path, projectDirectory)
    const owner = new ProjectionOwner(repository, spec, options)
    entry = { owner, repository, refs: 0 }
    held().set(id, entry)
    try {
      owner.start()
    } catch (error) {
      held().delete(id)
      owner.close()
      repository.close()
      throw error
    }
  }
  entry.refs++
  const taken = entry
  let released = false
  return {
    owner: taken.owner,
    release() {
      if (released) return
      released = true
      if (--taken.refs > 0) return
      held().delete(id)
      taken.owner.close()
      taken.repository.close()
    },
  }
}
