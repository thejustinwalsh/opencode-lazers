import { existsSync } from "node:fs"
import { databaseChanges } from "../database-events.ts"
import {
  advanceProjectionState,
  openProjectionState,
  projectionStatus,
  recordProjectionError,
} from "../projections/lifecycle.ts"
import { acquireSharedConnection } from "../storage.ts"
import type { SharedConnection } from "../storage.ts"
import {
  finishCandidateBuild,
  MODEL_CANDIDATES,
  MODEL_CANDIDATES_GENERATION,
  MODEL_CANDIDATES_QUEUE,
  writeCandidatePage,
  type CandidateFinish,
  type CandidateRow,
} from "./candidate-store.ts"

/**
 * The main-thread side of the candidate projection (`candidate-store.ts`) of one database: the
 * decision worker parses the five snapshot bodies and builds the candidates on its read-only
 * connection; this writes the rows it returns, a page per transaction.
 *
 * ```
 * saveSnapshot ─trigger─► model_candidates_dirty(project) ─► (next turn) build(project)
 * build: worker.candidates(project) ─┬─ null (stored set is the latest) ─► dequeue
 *                                    └─ pages of changed rows (CANDIDATE_PAGE_BYTES), each written in
 *                                       its own transaction as its message arrives
 *                                    └─ last message ─► finish: deletions, set stamp, dequeue
 * a build that fails or is closed part way stamps nothing; the next build recompares digests
 * a refresh during the build ─► the set moved again ─► one more pass
 * failure ─► the entry stays queued with its error and a backoff; a timer retries it
 * ```
 *
 * Each project's `projection_state` row (scope: the project) is `backfilling` until its first
 * build is written, then `ready`, moved only through the `projection` lifecycle.
 */
type CandidateWorker = {
  candidates(
    projectDirectory: string,
    onPage: (rows: CandidateRow[]) => void,
    signal?: AbortSignal,
  ): Promise<CandidateFinish | null>
}

const BACKOFF_FIRST_MS = 1_000
const BACKOFF_CEILING_MS = 5 * 60_000

type CandidateWrite = { transactions: number; rows: number; ms: number[] }

export class CandidateBuilds {
  private shared: SharedConnection | undefined
  private unsubscribe: (() => void) | undefined
  private readonly projects = new Map<
    string,
    { running?: Promise<void>; again: boolean; retry?: ReturnType<typeof setTimeout> }
  >()
  private closed = false
  /** The last build's writes per project, for measurement. */
  readonly writes = new Map<string, CandidateWrite>()
  lastError: Error | undefined

  constructor(
    private readonly path: string,
    private readonly worker: CandidateWorker,
  ) {}

  private connection() {
    this.shared ??= acquireSharedConnection(this.path)
    return this.shared
  }

  /**
   * This process serves `projectDirectory`: open its state and bring it current now. A database
   * without the projection (the project core installs it) is left alone: nothing is created here.
   */
  ensure(projectDirectory: string) {
    if (this.closed) return
    if (!this.projects.has(projectDirectory)) {
      if (!existsSync(this.path)) return
      const db = this.connection().db
      const installed = db
        .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_candidate_sets'")
        .get()
      if (!installed) return
      this.projects.set(projectDirectory, { again: false })
      db.transaction(() =>
        openProjectionState(db, MODEL_CANDIDATES, MODEL_CANDIDATES_GENERATION, projectDirectory),
      ).immediate()
    }
    this.unsubscribe ??= databaseChanges.subscribeTables(this.path, (tables) => {
      if (tables.has(MODEL_CANDIDATES_QUEUE)) this.due()
    })
    void this.build(projectDirectory)
  }

  /** Build the served projects with a due queue entry. */
  private due() {
    const db = this.connection().db
    const now = Date.now()
    const queued = db
      .query<{ ref: string }, [number]>(
        `SELECT ref FROM ${MODEL_CANDIDATES_QUEUE} WHERE next_at<=? ORDER BY next_at,ref`,
      )
      .all(now)
    for (const { ref } of queued) if (this.projects.has(ref)) void this.build(ref)
  }

  /** One build of a project; concurrent calls coalesce into one more pass. Never throws. */
  build(projectDirectory: string): Promise<void> {
    const entry = this.projects.get(projectDirectory)
    if (!entry || this.closed) return Promise.resolve()
    if (entry.running) {
      entry.again = true
      return entry.running
    }
    entry.running = (async () => {
      do {
        entry.again = false
        entry.again = (await this.buildOnce(projectDirectory)) || entry.again
      } while (entry.again && !this.closed)
    })().finally(() => {
      entry.running = undefined
    })
    return entry.running
  }

  /** Returns true when the set moved during the build, so another pass is due. */
  private async buildOnce(projectDirectory: string): Promise<boolean> {
    const db = this.connection().db
    try {
      const write: CandidateWrite = { transactions: 0, rows: 0, ms: [] }
      const run = <T>(work: () => T): T => {
        const started = performance.now()
        const result = db.transaction(work).immediate()
        write.ms.push(performance.now() - started)
        write.transactions++
        return result
      }
      const changes = await this.worker.candidates(projectDirectory, (page) => {
        if (!this.closed) write.rows += run(() => writeCandidatePage(db, projectDirectory, page))
      })
      if (this.closed) return false
      let current = true
      if (changes) {
        current = run(() => {
          const finished = finishCandidateBuild(db, projectDirectory, changes)
          this.ready(projectDirectory)
          return finished.current
        })
        this.writes.set(projectDirectory, write)
      } else
        run(() => {
          db.query(`DELETE FROM ${MODEL_CANDIDATES_QUEUE} WHERE ref=?`).run(projectDirectory)
          this.ready(projectDirectory)
        })
      return !current
    } catch (error) {
      this.fail(projectDirectory, error)
      return false
    }
  }

  private ready(projectDirectory: string) {
    const db = this.connection().db
    const status = projectionStatus(db, MODEL_CANDIDATES, projectDirectory)
    if (status?.state === "backfilling" && status.generation === MODEL_CANDIDATES_GENERATION)
      advanceProjectionState(db, MODEL_CANDIDATES, projectDirectory, {
        phase: 0,
        after: 0,
        ready: true,
      })
  }

  /** Park the project's entry with its error and a backoff, and retry when it comes due. */
  private fail(projectDirectory: string, error: unknown) {
    this.lastError = error instanceof Error ? error : new Error(String(error))
    const message = this.lastError.message.slice(0, 500)
    let wait = BACKOFF_FIRST_MS
    try {
      const db = this.connection().db
      db.transaction(() => {
        const queued = db
          .query<{ attempts: number }, [string]>(
            `SELECT attempts FROM ${MODEL_CANDIDATES_QUEUE} WHERE ref=?`,
          )
          .get(projectDirectory)
        wait = Math.min(BACKOFF_FIRST_MS * 2 ** (queued?.attempts ?? 0), BACKOFF_CEILING_MS)
        db.query(
          `INSERT INTO ${MODEL_CANDIDATES_QUEUE}(ref,next_at,attempts,error) VALUES(?,?,1,?)
           ON CONFLICT(ref) DO UPDATE SET next_at=excluded.next_at,attempts=attempts+1,error=excluded.error`,
        ).run(projectDirectory, Date.now() + wait, message)
        recordProjectionError(db, MODEL_CANDIDATES, projectDirectory, message)
      }).immediate()
    } catch {
      // The database is unavailable; the timer below retries.
    }
    const entry = this.projects.get(projectDirectory)
    if (!entry || this.closed) return
    clearTimeout(entry.retry)
    entry.retry = setTimeout(() => void this.build(projectDirectory), wait)
    entry.retry.unref()
  }

  /** Wait for the builds in flight; tests and tools use it. */
  async settle() {
    while ([...this.projects.values()].some((entry) => entry.running))
      await Promise.all([...this.projects.values()].map((entry) => entry.running))
  }

  close() {
    this.closed = true
    for (const entry of this.projects.values()) clearTimeout(entry.retry)
    this.projects.clear()
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.shared?.release()
    this.shared = undefined
  }
}
