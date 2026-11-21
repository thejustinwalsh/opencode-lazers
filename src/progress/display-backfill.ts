import type { Database } from "bun:sqlite"
import { workIsActive } from "../retention/store.ts"
import type { TaskRepository } from "../storage.ts"
import { DISPLAY_VERSION } from "./display.ts"
import { writeProgressDisplay, type StoredProgress } from "./display-store.ts"

/**
 * Display rows for the progress rows that predate `runner_progress_display`.
 *
 * ```
 * seq:   1 ........................ below ............ max at install
 *        [ no display yet, filled newest first ] [ every row has its display ]
 * ```
 *
 * One watermark row records `below_seq`: every progress row at or above it has its display at the
 * current `DISPLAY_VERSION` (the writer stores it with the row), so only the rows under it need work.
 * A new version resets the watermark at install and the backfill rewrites the older rows. The install sets it to
 * the highest `seq` plus one; each page of the backfill reads the next rows downward, writes
 * their display and lowers the watermark in the same small transaction; a restart resumes from
 * the stored value. A reader needs no coordination: it sees the display rows that exist, newest
 * first, and an attempt's older rows appear as the backfill reaches them.
 */
const PAGE_ROWS = 100

export function installProgressDisplayBackfill(db: Database) {
  const columns = db
    .query<{ name: string }, []>("PRAGMA table_info(runner_progress_display_backfill)")
    .all()
    .map((column) => column.name)
  if (columns.length > 0 && !columns.includes("version"))
    db.exec("DROP TABLE runner_progress_display_backfill")
  db.exec(`
    CREATE TABLE IF NOT EXISTS runner_progress_display_backfill (
      only_row INTEGER PRIMARY KEY CHECK(only_row=1),
      below_seq INTEGER NOT NULL,
      version INTEGER NOT NULL
    );
  `)
  // Rows written under an older version of the display are walked again: the watermark goes back
  // to the top, and the backfill rewrites every row whose stored version is not the current one.
  db.query(
    `INSERT INTO runner_progress_display_backfill(only_row,below_seq,version)
       SELECT 1,COALESCE(MAX(seq),0)+1,? FROM runner_progress
     WHERE true
     ON CONFLICT(only_row) DO UPDATE SET below_seq=excluded.below_seq,version=excluded.version
       WHERE version<>excluded.version`,
  ).run(DISPLAY_VERSION)
}

const COLUMNS =
  "seq,project_directory,project_id,attempt_id,session_id,at,recorded_at,source,kind,event_ids_json,call_id,message_id,payload"

/**
 * One page, inside the caller's transaction: the next rows below the watermark that have no
 * display get one, and the watermark moves under them. `done` once the table's start is reached.
 */
export function backfillProgressDisplayPage(
  db: Database,
  pageRows = PAGE_ROWS,
): { written: number; done: boolean } {
  const mark = db
    .query<{ below_seq: number }, []>(
      "SELECT below_seq FROM runner_progress_display_backfill WHERE only_row=1",
    )
    .get()
  if (!mark || mark.below_seq <= 0) return { written: 0, done: true }
  const rows = db
    .query<StoredProgress, [number, number, number]>(
      `SELECT ${COLUMNS} FROM runner_progress r
        WHERE seq<? AND NOT EXISTS
          (SELECT 1 FROM runner_progress_display d WHERE d.seq=r.seq AND d.version=?)
        ORDER BY seq DESC LIMIT ?`,
    )
    .all(mark.below_seq, DISPLAY_VERSION, pageRows)
  for (const row of rows) writeProgressDisplay(db, row)
  const done = rows.length < pageRows
  const next = done ? 0 : rows.at(-1)!.seq
  db.query("UPDATE runner_progress_display_backfill SET below_seq=? WHERE only_row=1").run(next)
  return { written: rows.length, done }
}

/** Runs the backfill in slices of small transactions, for the scheduler to call at its ticks. */
export class ProgressDisplayBackfill {
  private finished = false

  constructor(
    private readonly repository: Pick<TaskRepository, "atomic">,
    private readonly now: () => number = performance.now.bind(performance),
  ) {}

  get done() {
    return this.finished
  }

  /** Pages until `budgetMs` has passed (at least one page); returns the rows written. */
  slice(budgetMs: number): number {
    if (this.finished) return 0
    const deadline = this.now() + budgetMs
    let written = 0
    do {
      const page = this.repository.atomic((db) => backfillProgressDisplayPage(db))
      written += page.written
      if (page.done) {
        this.finished = true
        break
      }
    } while (this.now() < deadline)
    return written
  }
}

/** Treat every progress row now in the table as one the backfill must cover (a rebuild, or a test). */
export function resetProgressDisplayBackfill(db: Database) {
  db.query(
    `INSERT OR REPLACE INTO runner_progress_display_backfill(only_row,below_seq,version)
       SELECT 1,COALESCE(MAX(seq),0)+1,? FROM runner_progress`,
  ).run(DISPLAY_VERSION)
}

export type BackfillPacing = {
  /** Wait before the first slice, so a starting service is not slowed by it. */
  startMs: number
  /** Time a slice may take, and the wait after it, when no attempt is preparing, running or verifying. */
  quiet: { sliceMs: number; waitMs: number }
  busy: { sliceMs: number; waitMs: number }
  /** Wait after a failed slice. */
  retryMs: number
}

const DEFAULT_BACKFILL_PACING: BackfillPacing = {
  startMs: 2_000,
  quiet: { sliceMs: 40, waitMs: 25 },
  busy: { sliceMs: 6, waitMs: 500 },
  retryMs: 30_000,
}

/**
 * Drives the backfill from timers owned by the caller (the project core): slices of small
 * transactions, longer ones when no attempt is active, until every row has its display. The
 * timer is unreferenced and `stop` ends it.
 */
export function startProgressDisplayBackfill(
  repository: Pick<TaskRepository, "atomic" | "read">,
  options: { pacing?: BackfillPacing; onError?: (error: unknown) => void } = {},
): { stop(): void; readonly done: boolean } {
  const pacing = options.pacing ?? DEFAULT_BACKFILL_PACING
  const backfill = new ProgressDisplayBackfill(repository)
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const schedule = (ms: number) => {
    if (stopped || backfill.done) return
    timer = setTimeout(step, ms)
    timer.unref?.()
  }
  const step = () => {
    let wait: number
    try {
      const quiet = !repository.read((db) => workIsActive(db))
      const pace = quiet ? pacing.quiet : pacing.busy
      backfill.slice(pace.sliceMs)
      wait = pace.waitMs
    } catch (error) {
      options.onError?.(error)
      wait = pacing.retryMs
    }
    schedule(wait)
  }
  schedule(pacing.startMs)
  return {
    stop() {
      stopped = true
      clearTimeout(timer)
    },
    get done() {
      return backfill.done
    },
  }
}
