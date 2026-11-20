import type { Database } from "bun:sqlite"
import { databaseChanges } from "../database-events.ts"
import { schemaModules } from "../database-schema.ts"
import { acquireSharedConnection } from "../storage.ts"
import type { SharedConnection } from "../storage.ts"
import { privacyStats } from "../trajectory/privacy.ts"
import { projectDecisionProgressRow } from "./decision-progress-fact.ts"
import type { DecisionProgressSource } from "./decision-progress-fact.ts"

/**
 * The stored projection behind the Models decision ledger (docs: design/data-handling.md,
 * principle 2). A decision read values every retained `step` and `usage-snapshot` progress row of
 * a project. Rebuilding those facts from `runner_progress` on every revision parsed the whole
 * table each time; this module keeps the facts in `model_decision_progress` and brings them
 * current from a watermark.
 *
 *   runner_progress ──insert──► rowid above `folded_seq` ──► fold ──► model_decision_progress
 *                  └─update/delete─► trigger ──► model_decision_progress_dirty ──► fold
 *
 * Owner and readers. The fold is a write, so it runs here, on the process's write connection, in
 * `DecisionProjectionOwner`; the decision worker's connection is read-only and only reads. A read
 * never waits for the owner: it takes the stored rows up to `folded_seq`, skips the rows named in
 * the dirty queue, and computes those and every row above the watermark from `runner_progress`
 * itself, all inside one read transaction. The result is the same facts however far the fold lags;
 * the fold only decides how many rows a read must parse.
 *
 * Rebuild. A projection is never rebuilt on a timer. The first fold of a project starts at
 * watermark 0 and pages through the table; that paged pass is the migration, it resumes from the
 * stored watermark after a restart, and it is the only time the whole table is read.
 *
 * Columns of `runner_progress` this depends on: seq (rowid), project_directory, plan_id, task_id,
 * attempt_id, session_id, at, recorded_at, source, sources_json, kind, event_ids_json,
 * message_id, payload.
 */

/** Progress kinds a decision fact is built from. */
export const DECISION_PROGRESS_KINDS = ["step", "usage-snapshot"] as const
const KINDS_SQL = DECISION_PROGRESS_KINDS.map((kind) => `'${kind}'`).join(",")

/**
 * Rows folded per write transaction and per read page. A unit of work, not a ceiling: the fold
 * keeps paging until the project is caught up. Not measured; it changes only how many
 * transactions a catch-up takes (512 rows is roughly a few milliseconds of parsing).
 */
export const FOLD_BATCH_SIZE = 512

const MODULE = schemaModules["model-decision-projection"]
const TABLES = {
  facts: "model_decision_progress",
  state: "model_decision_progress_state",
  dirty: "model_decision_progress_dirty",
} as const

/** Columns the fold reads from a progress row. */
const SOURCE_COLUMNS =
  "r.seq,r.project_directory,r.plan_id,r.task_id,r.attempt_id,r.session_id,r.at,r.recorded_at," +
  "r.source,r.sources_json,r.kind,r.event_ids_json,r.message_id,r.payload"

type SourceRow = DecisionProgressSource & {
  project_directory: string
  plan_id: string
  task_id: string
}

/** Counters for diagnostics and tests: what the fold and the reads touched. */
export const decisionProjectionStats = {
  /** Rows read from runner_progress by folds. */
  foldSourceRows: 0,
  /** Rows written to the projection by folds. */
  foldWrites: 0,
  /** Projected rows removed because their source row left the projection's kinds or the table. */
  foldRemovals: 0,
  /** Fold transactions committed. */
  foldPages: 0,
  /** Projected rows read by decision reads. */
  readProjectionRows: 0,
  /** runner_progress rows read (and parsed) by decision reads: the tail and the dirty rows. */
  readSourceRows: 0,
  reset() {
    this.foldSourceRows = 0
    this.foldWrites = 0
    this.foldRemovals = 0
    this.foldPages = 0
    this.readProjectionRows = 0
    this.readSourceRows = 0
  },
}

/**
 * Tables, indexes and the update/delete triggers. Idempotent; runs on a generation change on the
 * write connection and recreates the triggers so a changed definition takes effect after a reload.
 */
export function installDecisionProjectionSchema(db: Database) {
  const hasTable = (name: string) =>
    Boolean(
      db
        .query<{ name: string }, [string]>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        )
        .get(name),
    )
  if (!hasTable("runner_progress")) return false
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLES.facts} (
        project_directory TEXT NOT NULL,
        seq INTEGER NOT NULL,
        plan_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        flags INTEGER NOT NULL,
        fact TEXT,
        PRIMARY KEY(project_directory, seq)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS ${TABLES.state} (
        project_directory TEXT PRIMARY KEY,
        folded_seq INTEGER NOT NULL CHECK(folded_seq >= 0),
        folded_at INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS ${TABLES.dirty} (
        project_directory TEXT NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY(project_directory, seq)
      ) WITHOUT ROWID;
      DROP TRIGGER IF EXISTS model_decision_progress_updated;
      DROP TRIGGER IF EXISTS model_decision_progress_deleted;
      -- A row above the watermark is read live, so only rows already folded are queued. The
      -- recency trigger writes latest_observed_at only, which is not in this column list.
      CREATE TRIGGER model_decision_progress_updated
      AFTER UPDATE OF kind,payload,sources_json,event_ids_json,message_id,at,recorded_at,
                      attempt_id,session_id,source,plan_id,task_id ON runner_progress
      WHEN OLD.kind IN (${KINDS_SQL}) OR NEW.kind IN (${KINDS_SQL})
      BEGIN
        INSERT OR IGNORE INTO ${TABLES.dirty}(project_directory,seq)
        SELECT NEW.project_directory, NEW.seq FROM ${TABLES.state}
        WHERE project_directory=NEW.project_directory AND folded_seq>=NEW.seq;
      END;
      CREATE TRIGGER model_decision_progress_deleted
      AFTER DELETE ON runner_progress
      WHEN OLD.kind IN (${KINDS_SQL})
      BEGIN
        INSERT OR IGNORE INTO ${TABLES.dirty}(project_directory,seq)
        SELECT OLD.project_directory, OLD.seq FROM ${TABLES.state}
        WHERE project_directory=OLD.project_directory AND folded_seq>=OLD.seq;
      END;
    `)
    if (hasTable("schema_modules"))
      db.query(
        `INSERT INTO schema_modules VALUES(?,?,?,?) ON CONFLICT(module)
         DO UPDATE SET generation=excluded.generation,tables_json=excluded.tables_json,installed_at=excluded.installed_at`,
      ).run(
        "model-decision-projection",
        MODULE.generation,
        JSON.stringify(MODULE.tables),
        Date.now(),
      )
  }).immediate()
  return true
}

/** Install once per connection and declared generation; a reload with a newer generation reruns. */
export function ensureDecisionProjectionSchema(shared: SharedConnection) {
  const hasProgress = shared.db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='runner_progress'",
    )
    .get()
  if (!hasProgress) return false
  shared.once(`model-decision-projection@${MODULE.generation}`, (db) => {
    installDecisionProjectionSchema(db)
  })
  return true
}

export type FoldStats = {
  pages: number
  sourceRows: number
  written: number
  removed: number
  /** The watermark after the fold; every project row at or below it is projected. */
  foldedSeq: number
}

const upsertFact = (db: Database, project: string, row: SourceRow, stats: FoldStats) => {
  const { flags, fact } = projectDecisionProgressRow(row, privacyStats())
  db.query(
    `INSERT INTO ${TABLES.facts}(project_directory,seq,plan_id,task_id,flags,fact)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(project_directory,seq) DO UPDATE SET plan_id=excluded.plan_id,
       task_id=excluded.task_id,flags=excluded.flags,fact=excluded.fact`,
  ).run(project, row.seq, row.plan_id, row.task_id, flags, fact ? JSON.stringify(fact) : null)
  stats.written++
}

/**
 * One fold transaction: the queued updates and deletes first, then the next page of rows above
 * the watermark. Returns whether more work remains. Runs inside BEGIN IMMEDIATE, so no writer
 * interleaves between reading a row and clearing its queue entry.
 */
function foldPage(db: Database, project: string, batch: number, stats: FoldStats): boolean {
  db.query(
    `INSERT OR IGNORE INTO ${TABLES.state}(project_directory,folded_seq,folded_at) VALUES(?,0,?)`,
  ).run(project, Date.now())
  const watermark = db
    .query<{ folded_seq: number }, [string]>(
      `SELECT folded_seq FROM ${TABLES.state} WHERE project_directory=?`,
    )
    .get(project)!.folded_seq

  const queued = db
    .query<{ seq: number }, [string, number]>(
      `SELECT seq FROM ${TABLES.dirty} WHERE project_directory=? ORDER BY seq LIMIT ?`,
    )
    .all(project, batch)
  const readOne = db.query<SourceRow, [number]>(
    `SELECT ${SOURCE_COLUMNS} FROM runner_progress r WHERE r.seq=?`,
  )
  for (const { seq } of queued) {
    const row = readOne.get(seq)
    stats.sourceRows++
    decisionProjectionStats.foldSourceRows++
    if (
      row &&
      row.project_directory === project &&
      (DECISION_PROGRESS_KINDS as readonly string[]).includes(row.kind)
    ) {
      upsertFact(db, project, row, stats)
      decisionProjectionStats.foldWrites++
    } else {
      stats.removed += db
        .query(`DELETE FROM ${TABLES.facts} WHERE project_directory=? AND seq=?`)
        .run(project, seq).changes
      decisionProjectionStats.foldRemovals++
    }
    db.query(`DELETE FROM ${TABLES.dirty} WHERE project_directory=? AND seq=?`).run(project, seq)
  }

  // The rowid scan seeks past the watermark; the project's dedupe index would re-sort on every page.
  const tail = db
    .query<SourceRow, [string, number, number]>(
      `SELECT ${SOURCE_COLUMNS} FROM runner_progress r NOT INDEXED
       WHERE r.project_directory=? AND r.seq>? AND r.kind IN (${KINDS_SQL})
       ORDER BY r.seq LIMIT ?`,
    )
    .all(project, watermark, batch)
  for (const row of tail) {
    upsertFact(db, project, row, stats)
    decisionProjectionStats.foldWrites++
  }
  stats.sourceRows += tail.length
  decisionProjectionStats.foldSourceRows += tail.length

  // A short page means no matching row is left: the watermark may pass the non-matching rows too.
  const next =
    tail.length >= batch
      ? tail[tail.length - 1]!.seq
      : (db.query<{ seq: number | null }, []>("SELECT MAX(seq) AS seq FROM runner_progress").get()
          ?.seq ?? 0)
  const foldedSeq = Math.max(watermark, next)
  db.query(`UPDATE ${TABLES.state} SET folded_seq=?,folded_at=? WHERE project_directory=?`).run(
    foldedSeq,
    Date.now(),
    project,
  )
  stats.foldedSeq = foldedSeq
  stats.pages++
  decisionProjectionStats.foldPages++
  return tail.length >= batch || queued.length >= batch
}

/**
 * Bring one project's projection current, a page per transaction, yielding between pages. Safe to
 * repeat: with nothing new it reads one empty page and writes the unchanged state row.
 */
export async function foldDecisionProgress(
  db: Database,
  projectDirectory: string,
  options: { batch?: number; signal?: AbortSignal } = {},
): Promise<FoldStats> {
  const batch = options.batch ?? FOLD_BATCH_SIZE
  const stats: FoldStats = { pages: 0, sourceRows: 0, written: 0, removed: 0, foldedSeq: 0 }
  for (;;) {
    options.signal?.throwIfAborted()
    const more = db.transaction(() => foldPage(db, projectDirectory, batch, stats)).immediate()
    if (!more) return stats
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

const observationRevision = (db: Database, project: string) =>
  db
    .query<{ revision: number }, [string]>(
      "SELECT revision FROM observation_revisions WHERE project_directory=?",
    )
    .get(project)?.revision ?? 0

/**
 * Debounce between a database change and the fold it triggers. Folds are cheap and incremental,
 * so this only batches a burst of progress writes into one pass; it is not a poll.
 */
const FOLD_DEBOUNCE_MS = 1_000
/** A project nobody has read for this long stops being folded (its next read folds it again). */
const ACTIVE_IDLE_MS = 10 * 60_000

/**
 * The write-side owner of the decision projections of one database in this process. Created and
 * released with the database's decision worker lease (decision-worker-registry.ts). A decision
 * read `touch`es its project; from then on every database change that moved the project's
 * observation revision folds it, until the project has not been read for ACTIVE_IDLE_MS. With the
 * revision unchanged a change event reads nothing.
 */
export class DecisionProjectionOwner {
  private shared: SharedConnection | undefined
  private unsubscribe: (() => void) | undefined
  private readonly active = new Map<
    string,
    { lastRead: number; foldedRevision: number | null; running?: Promise<unknown>; dirty: boolean }
  >()
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  lastError: Error | undefined

  constructor(private readonly path: string) {}

  private connection() {
    this.shared ??= acquireSharedConnection(this.path)
    return this.shared
  }

  /** A decision read of this project happened: keep it folded and start folding it now. */
  touch(projectDirectory: string) {
    if (this.closed) return
    const entry = this.active.get(projectDirectory)
    if (entry) entry.lastRead = Date.now()
    else {
      this.active.set(projectDirectory, {
        lastRead: Date.now(),
        foldedRevision: null,
        dirty: true,
      })
      this.unsubscribe ??= databaseChanges.subscribe(
        this.path,
        () => this.schedule(),
        (error) => {
          this.lastError = error
        },
      )
      // The first read of a project folds it at once (the paged migration for a new project).
      this.schedule(0)
    }
  }

  private schedule(delayMs = FOLD_DEBOUNCE_MS) {
    if (this.closed || (this.timer && delayMs > 0)) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.pass()
    }, delayMs)
    this.timer.unref()
  }

  private async pass() {
    const now = Date.now()
    for (const [project, entry] of this.active) {
      if (now - entry.lastRead > ACTIVE_IDLE_MS) this.active.delete(project)
      else await this.foldIfMoved(project, entry).catch(() => undefined)
    }
    if (!this.active.size) {
      this.unsubscribe?.()
      this.unsubscribe = undefined
    }
  }

  /**
   * Fold a project if its observation revision moved since its last complete fold. Returns
   * whether a fold ran; with the revision unchanged it reads one revision row and no history.
   */
  async foldWhenMoved(projectDirectory: string): Promise<boolean> {
    let entry = this.active.get(projectDirectory)
    if (!entry) {
      entry = { lastRead: Date.now(), foldedRevision: null, dirty: false }
      this.active.set(projectDirectory, entry)
    }
    const before = decisionProjectionStats.foldPages
    await this.foldIfMoved(projectDirectory, entry)
    return decisionProjectionStats.foldPages > before
  }

  private foldIfMoved(
    project: string,
    entry: { foldedRevision: number | null; running?: Promise<unknown>; dirty: boolean },
  ) {
    if (entry.running) {
      entry.dirty = true
      return entry.running
    }
    const run = (async () => {
      do {
        entry.dirty = false
        const shared = this.connection()
        if (!ensureDecisionProjectionSchema(shared)) return
        // Read before folding: a write that lands during the fold leaves the stamp behind the
        // revision, so the next change event folds again.
        const revision = shared.db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='observation_revisions'",
          )
          .get()
          ? observationRevision(shared.db, project)
          : null
        if (revision !== null && revision === entry.foldedRevision) return
        try {
          await foldDecisionProgress(shared.db, project)
          entry.foldedRevision = revision
          this.lastError = undefined
        } catch (error) {
          // SQLITE_BUSY and the like: reads stay correct from the live tail; retry on the next change.
          this.lastError = error instanceof Error ? error : new Error(String(error))
        }
      } while (entry.dirty && !this.closed)
    })().finally(() => {
      entry.running = undefined
    })
    entry.running = run
    return run
  }

  close() {
    this.closed = true
    clearTimeout(this.timer)
    this.timer = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.active.clear()
    this.shared?.release()
    this.shared = undefined
  }
}

export const DECISION_PROJECTION_TABLES = TABLES
