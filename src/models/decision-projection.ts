import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { databaseChanges } from "../database-events.ts"
import { schemaModules } from "../database-schema.ts"
import { acquireSharedConnection } from "../storage.ts"
import type { SharedConnection } from "../storage.ts"
import { privacyStats } from "../trajectory/privacy.ts"
import { projectDecisionProgressRow } from "./decision-progress-fact.ts"
import {
  DECISION_PROGRESS_KINDS,
  DECISION_PROJECTION_TABLES,
  decisionProjectionStats,
} from "./decision-projection-tables.ts"
import type { DecisionProgressSource } from "./decision-progress-fact.ts"
import { computeDecisionTasks, inspectDecisionSources } from "./observation-ledger-read.ts"

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

/**
 * Rows folded per write transaction and per read page. A unit of work, not a ceiling: the fold
 * keeps paging until the project is caught up. Not measured; it changes only how many
 * transactions a catch-up takes (512 rows is roughly a few milliseconds of parsing).
 */
export const FOLD_BATCH_SIZE = 512

const KINDS_SQL = DECISION_PROGRESS_KINDS.map((kind) => `'${kind}'`).join(",")
const MODULE = schemaModules["model-decision-projection"]
const TABLES = DECISION_PROJECTION_TABLES

/** Columns the fold reads from a progress row. */
const SOURCE_COLUMNS =
  "r.seq,r.project_directory,r.plan_id,r.task_id,r.attempt_id,r.session_id,r.at,r.recorded_at," +
  "r.source,r.sources_json,r.kind,r.event_ids_json,r.message_id,r.payload"

type SourceRow = DecisionProgressSource & {
  project_directory: string
  plan_id: string
  task_id: string
}

/** The source tables the projection reads; it installs only when every one exists. */
const SOURCE_TABLES = [
  "tasks",
  "task_references",
  "task_classifications",
  "task_dispositions",
  "runner_plans",
  "runner_nodes",
  "runner_attempts",
  "runner_transitions",
  "runner_adoptions",
  "runner_progress",
] as const

const hasTable = (db: Database, name: string) =>
  Boolean(
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get(name),
  )

/**
 * A task is queued for a re-derive when a row it is derived from changes. `project` and `task`
 * are SQL expressions over OLD or NEW. Only projects with a state row are queued: without one
 * every task is derived live, so there is nothing stored to go stale.
 */
const queueTask = (project: string, task: string) => `
        INSERT OR IGNORE INTO ${TABLES.taskDirty}(project_directory,task_id)
        SELECT ${project}, ${task}
        WHERE ${task} IS NOT NULL AND EXISTS (
          SELECT 1 FROM ${TABLES.state} WHERE project_directory=${project} AND dropping=0);`

const viaPlan = (row: "OLD" | "NEW") =>
  `(SELECT project_directory FROM runner_plans WHERE id=${row}.plan_id)`

/** Triggers that queue the tasks whose source rows change: table, project expression per row. */
const TASK_TRIGGERS: Array<{
  table: string
  project: (row: "OLD" | "NEW") => string
  task: string
  /** Columns whose update re-derives the task; omitted, any update does. */
  updateOf?: string
}> = [
  { table: "task_references", project: (row) => `${row}.project_directory`, task: "task_id" },
  { table: "task_classifications", project: (row) => `${row}.project_directory`, task: "task_id" },
  { table: "task_dispositions", project: (row) => `${row}.project_directory`, task: "task_id" },
  { table: "runner_nodes", project: viaPlan, task: "task_id" },
  { table: "runner_attempts", project: viaPlan, task: "task_id" },
  {
    table: "runner_transitions",
    project: viaPlan,
    task: "task_id",
    // Not `plan_n`: the integer-key backfill updates every older row and changes no fact.
    updateOf: "plan_id,task_id,version,event,payload,created_at",
  },
  { table: "runner_adoptions", project: viaPlan, task: "task_id" },
]

function taskTriggerSQL() {
  const sql: string[] = []
  for (const { table, project, task, updateOf } of TASK_TRIGGERS)
    for (const event of ["INSERT", "UPDATE", "DELETE"] as const) {
      const rows = event === "INSERT" ? ["NEW"] : event === "DELETE" ? ["OLD"] : ["NEW", "OLD"]
      const name = `model_decision_task_${table}_${event.toLowerCase()}`
      sql.push(
        `DROP TRIGGER IF EXISTS ${name};
      CREATE TRIGGER ${name} AFTER ${event}${event === "UPDATE" && updateOf ? ` OF ${updateOf}` : ""} ON ${table} BEGIN${rows
        .map((row) => queueTask(project(row as "OLD" | "NEW"), `${row}.${task}`))
        .join("")}
      END;`,
      )
    }
  // A task body is immutable, so only an update or a delete can change what a stored task says.
  for (const event of ["UPDATE", "DELETE"] as const) {
    const name = `model_decision_task_tasks_${event.toLowerCase()}`
    sql.push(
      `DROP TRIGGER IF EXISTS ${name};
      CREATE TRIGGER ${name} AFTER ${event} ON tasks BEGIN${queueTask("OLD.project_directory", "OLD.id")}
      END;`,
    )
  }
  // A plan's route and body feed the accounting of every attempt and node that names it.
  sql.push(
    `DROP TRIGGER IF EXISTS model_decision_task_runner_plans_update;
      CREATE TRIGGER model_decision_task_runner_plans_update
      AFTER UPDATE OF body,model,project_directory ON runner_plans BEGIN
        INSERT OR IGNORE INTO ${TABLES.taskDirty}(project_directory,task_id)
        SELECT NEW.project_directory, linked.task_id FROM (
          SELECT task_id FROM runner_nodes WHERE plan_id=NEW.id
          UNION SELECT task_id FROM runner_attempts WHERE plan_id=NEW.id
        ) linked WHERE EXISTS (
          SELECT 1 FROM ${TABLES.state} WHERE project_directory=NEW.project_directory AND dropping=0);
      END;`,
  )
  return sql.join("\n")
}

/**
 * Tables, indexes and the triggers that feed the dirty queues. Idempotent; runs on a generation
 * change on the write connection and recreates the triggers so a changed definition takes effect
 * after a reload. Installs only when every source table exists, so a trigger is never missing for
 * a table that is created later.
 */
export function installDecisionProjectionSchema(db: Database) {
  if (!SOURCE_TABLES.every((name) => hasTable(db, name))) return false
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLES.facts} (
        project_directory TEXT NOT NULL,
        seq INTEGER NOT NULL,
        plan_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        flags INTEGER NOT NULL,
        fact TEXT,
        session_id TEXT,
        PRIMARY KEY(project_directory, seq)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS ${TABLES.state} (
        project_directory TEXT PRIMARY KEY,
        folded_seq INTEGER NOT NULL CHECK(folded_seq >= 0),
        folded_at INTEGER NOT NULL,
        tasks_folded_rowid INTEGER NOT NULL DEFAULT 0,
        last_read_at INTEGER NOT NULL DEFAULT 0,
        dropping INTEGER NOT NULL DEFAULT 0,
        epoch TEXT NOT NULL DEFAULT '',
        session_clock INTEGER NOT NULL DEFAULT 0,
        sessions_ready INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS ${TABLES.sessions} (
        project_directory TEXT NOT NULL,
        session_id TEXT NOT NULL,
        changed INTEGER NOT NULL,
        PRIMARY KEY(project_directory, session_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS model_decision_session_changed
        ON ${TABLES.sessions}(project_directory, changed, session_id);
      CREATE TABLE IF NOT EXISTS ${TABLES.dirty} (
        project_directory TEXT NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY(project_directory, seq)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS ${TABLES.tasks} (
        project_directory TEXT NOT NULL,
        created_at TEXT NOT NULL,
        task_id TEXT NOT NULL,
        task TEXT NOT NULL,
        notes TEXT NOT NULL,
        PRIMARY KEY(project_directory, created_at, task_id)
      ) WITHOUT ROWID;
      CREATE UNIQUE INDEX IF NOT EXISTS model_decision_task_id
        ON ${TABLES.tasks}(project_directory, task_id);
      CREATE TABLE IF NOT EXISTS ${TABLES.taskDirty} (
        project_directory TEXT NOT NULL,
        task_id TEXT NOT NULL,
        PRIMARY KEY(project_directory, task_id)
      ) WITHOUT ROWID;`)
    // Generation 1 had no task watermark, last-read time or drop mark; generation 2 had no
    // session stamps. A project's existing state row keeps `sessions_ready=0` until the fold has
    // labelled its stored facts with their session (a paged backfill), and reads use the live
    // path for it until then.
    const addColumns = (table: string, wanted: ReadonlyArray<readonly [string, string]>) => {
      const columns = new Set(
        db
          .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`)
          .all()
          .map((column) => column.name),
      )
      for (const [name, definition] of wanted)
        if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
    }
    addColumns(TABLES.state, [
      ["tasks_folded_rowid", "INTEGER NOT NULL DEFAULT 0"],
      ["last_read_at", "INTEGER NOT NULL DEFAULT 0"],
      ["dropping", "INTEGER NOT NULL DEFAULT 0"],
      ["epoch", "TEXT NOT NULL DEFAULT ''"],
      ["session_clock", "INTEGER NOT NULL DEFAULT 0"],
      ["sessions_ready", "INTEGER NOT NULL DEFAULT 0"],
    ])
    addColumns(TABLES.facts, [["session_id", "TEXT"]])
    db.exec(`
      CREATE INDEX IF NOT EXISTS model_decision_progress_session
        ON ${TABLES.facts}(project_directory, session_id, seq);
      CREATE INDEX IF NOT EXISTS model_decision_progress_task
        ON ${TABLES.facts}(project_directory, task_id, session_id);
      CREATE INDEX IF NOT EXISTS model_decision_progress_unlabelled
        ON ${TABLES.facts}(project_directory, seq) WHERE session_id IS NULL;
      CREATE INDEX IF NOT EXISTS model_decision_progress_flagged
        ON ${TABLES.facts}(project_directory, seq) WHERE flags<>0;`)
    db.exec(`
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
        WHERE project_directory=NEW.project_directory AND folded_seq>=NEW.seq AND dropping=0;
      END;
      CREATE TRIGGER model_decision_progress_deleted
      AFTER DELETE ON runner_progress
      WHEN OLD.kind IN (${KINDS_SQL})
      BEGIN
        INSERT OR IGNORE INTO ${TABLES.dirty}(project_directory,seq)
        SELECT OLD.project_directory, OLD.seq FROM ${TABLES.state}
        WHERE project_directory=OLD.project_directory AND folded_seq>=OLD.seq AND dropping=0;
      END;
      ${taskTriggerSQL()}
    `)
    if (hasTable(db, "schema_modules"))
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
  if (!SOURCE_TABLES.every((name) => hasTable(shared.db, name))) return false
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
  /** Tasks derived from their source rows and stored. */
  tasks: number
}

/** The session a stored fact belongs to; facts of a malformed row have none. */
const sessionOfRow = (row: { session_id: string | null }) => row.session_id ?? ""

const upsertFact = (
  db: Database,
  project: string,
  row: SourceRow,
  stats: FoldStats,
  touched: Set<string>,
) => {
  const { flags, fact } = projectDecisionProgressRow(row, privacyStats())
  const previous = db
    .query<{ session_id: string | null }, [string, number]>(
      `SELECT session_id FROM ${TABLES.facts} WHERE project_directory=? AND seq=?`,
    )
    .get(project, row.seq)
  // A fact that changes session leaves a change behind in both.
  if (previous?.session_id != null) touched.add(previous.session_id)
  touched.add(sessionOfRow(row))
  db.query(
    `INSERT INTO ${TABLES.facts}(project_directory,seq,plan_id,task_id,flags,fact,session_id)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(project_directory,seq) DO UPDATE SET plan_id=excluded.plan_id,
       task_id=excluded.task_id,flags=excluded.flags,fact=excluded.fact,
       session_id=excluded.session_id`,
  ).run(
    project,
    row.seq,
    row.plan_id,
    row.task_id,
    flags,
    fact ? JSON.stringify(fact) : null,
    sessionOfRow(row),
  )
  stats.written++
}

/**
 * Stamp sessions as changed at the project's next change-clock value. A read compares the
 * clock it last saw with the stored one and asks only for sessions stamped above it.
 */
function touchSessions(db: Database, project: string, sessions: ReadonlySet<string>) {
  if (!sessions.size) return
  const clock =
    db
      .query<{ session_clock: number }, [string]>(
        `SELECT session_clock FROM ${TABLES.state} WHERE project_directory=?`,
      )
      .get(project)!.session_clock + 1
  const stamp = db.query(
    `INSERT INTO ${TABLES.sessions}(project_directory,session_id,changed) VALUES(?,?,?)
     ON CONFLICT(project_directory,session_id) DO UPDATE SET changed=excluded.changed`,
  )
  for (const session of sessions) stamp.run(project, session, clock)
  db.query(`UPDATE ${TABLES.state} SET session_clock=? WHERE project_directory=?`).run(
    clock,
    project,
  )
}

/** The session id inside a stored fact (a database from before facts carried one). */
function sessionOfStoredFact(fact: string | null) {
  if (fact === null) return ""
  try {
    const value = (JSON.parse(fact) as { sessionID?: unknown }).sessionID
    return typeof value === "string" ? value : ""
  } catch {
    return ""
  }
}

/**
 * Label the stored facts of a project upgraded from generation 2 with their session, a page at a
 * time, and stamp their sessions. Reads treat the project as unlabelled (live path) until the
 * last page. Returns whether more work remains.
 */
function backfillSessions(db: Database, project: string, batch: number, touched: Set<string>) {
  const rows = db
    .query<{ seq: number; fact: string | null }, [string, number]>(
      `SELECT seq,fact FROM ${TABLES.facts}
       WHERE project_directory=? AND session_id IS NULL ORDER BY seq LIMIT ?`,
    )
    .all(project, batch)
  const label = db.query(
    `UPDATE ${TABLES.facts} SET session_id=? WHERE project_directory=? AND seq=?`,
  )
  for (const row of rows) {
    const session = sessionOfStoredFact(row.fact)
    label.run(session, project, row.seq)
    touched.add(session)
  }
  if (rows.length >= batch) return true
  db.query(
    `UPDATE ${TABLES.state} SET sessions_ready=1,epoch=CASE WHEN epoch='' THEN ? ELSE epoch END
     WHERE project_directory=?`,
  ).run(randomUUID(), project)
  return false
}

/**
 * One fold transaction: the queued updates and deletes first, then the next page of rows above
 * the watermark. Returns whether more work remains. Runs inside BEGIN IMMEDIATE, so no writer
 * interleaves between reading a row and clearing its queue entry.
 */
function foldPage(db: Database, project: string, batch: number, stats: FoldStats): boolean {
  db.query(
    `INSERT OR IGNORE INTO ${TABLES.state}
       (project_directory,folded_seq,folded_at,last_read_at,epoch,sessions_ready)
     VALUES(?,0,?,?,?,1)`,
  ).run(project, Date.now(), Date.now(), randomUUID())
  const touched = new Set<string>()
  const ready = db
    .query<{ sessions_ready: number }, [string]>(
      `SELECT sessions_ready FROM ${TABLES.state} WHERE project_directory=?`,
    )
    .get(project)!.sessions_ready
  const backfilling = ready ? false : backfillSessions(db, project, batch, touched)
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
  const sessionOf = db.query<{ session_id: string | null }, [string, number]>(
    `SELECT session_id FROM ${TABLES.facts} WHERE project_directory=? AND seq=?`,
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
      upsertFact(db, project, row, stats, touched)
      decisionProjectionStats.foldWrites++
    } else {
      const removedSession = sessionOf.get(project, seq)?.session_id
      if (removedSession != null) touched.add(removedSession)
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
    upsertFact(db, project, row, stats, touched)
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
  touchSessions(db, project, touched)
  stats.foldedSeq = foldedSeq
  stats.pages++
  decisionProjectionStats.foldPages++
  return tail.length >= batch || queued.length >= batch || backfilling
}

/**
 * One transaction's share of the task projection: the queued tasks and the tasks above the rowid
 * watermark are derived from their source rows (a few statements per batch, not per task) and
 * stored; a queued task that no longer exists is removed. Returns whether more work remains.
 */
function foldTaskPage(db: Database, project: string, foldBatch: number, stats: FoldStats): boolean {
  // A task costs far more to derive than a progress row (plan bodies are parsed), so a page holds
  // fewer of them. 64 is not measured; it only sets how long one write transaction holds the lock.
  const batch = Math.min(foldBatch, 64)
  const sources = inspectDecisionSources(db)
  // A source table that lacks columns means reads derive every task live; nothing to store.
  if (!sources.statuses.every((source) => source.status === "available")) return false
  const watermark = db
    .query<{ tasks_folded_rowid: number }, [string]>(
      `SELECT tasks_folded_rowid FROM ${TABLES.state} WHERE project_directory=?`,
    )
    .get(project)!.tasks_folded_rowid
  const queued = db
    .query<{ task_id: string }, [string, number]>(
      `SELECT task_id FROM ${TABLES.taskDirty} WHERE project_directory=? ORDER BY task_id LIMIT ?`,
    )
    .all(project, batch)
    .map((row) => row.task_id)
  const tail = db
    .query<{ rowid: number; id: string }, [string, number, number]>(
      "SELECT rowid,id FROM tasks WHERE project_directory=? AND rowid>? ORDER BY rowid LIMIT ?",
    )
    .all(project, watermark, batch)
  const ids = [...new Set([...queued, ...tail.map((row) => row.id)])]
  // A task entering, changing or leaving decides which stored facts are visible, so the sessions
  // of its facts change with it.
  const taskSessions = new Set<string>()
  const sessionsOfTask = db.query<{ session_id: string | null }, [string, string]>(
    `SELECT DISTINCT session_id FROM ${TABLES.facts}
     WHERE project_directory=? AND task_id=? AND session_id IS NOT NULL`,
  )
  for (const id of ids)
    for (const row of sessionsOfTask.all(project, id)) taskSessions.add(row.session_id!)
  touchSessions(db, project, taskSessions)
  const computed = new Map(
    computeDecisionTasks(db, project, ids, sources).map((entry) => [entry.taskID, entry]),
  )
  for (const id of ids) {
    db.query(`DELETE FROM ${TABLES.tasks} WHERE project_directory=? AND task_id=?`).run(project, id)
    const entry = computed.get(id)
    if (!entry) continue
    db.query(
      `INSERT INTO ${TABLES.tasks}(project_directory,created_at,task_id,task,notes) VALUES(?,?,?,?,?)`,
    ).run(project, entry.createdAt, id, JSON.stringify(entry.task), JSON.stringify(entry.notes))
  }
  for (const id of queued)
    db.query(`DELETE FROM ${TABLES.taskDirty} WHERE project_directory=? AND task_id=?`).run(
      project,
      id,
    )
  const next =
    tail.length >= batch
      ? tail[tail.length - 1]!.rowid
      : (db.query<{ rowid: number | null }, []>("SELECT MAX(rowid) AS rowid FROM tasks").get()
          ?.rowid ?? 0)
  db.query(`UPDATE ${TABLES.state} SET tasks_folded_rowid=? WHERE project_directory=?`).run(
    Math.max(watermark, next),
    project,
  )
  stats.tasks += ids.length
  decisionProjectionStats.foldTasks += ids.length
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
  const stats: FoldStats = {
    pages: 0,
    sourceRows: 0,
    written: 0,
    removed: 0,
    foldedSeq: 0,
    tasks: 0,
  }
  for (;;) {
    options.signal?.throwIfAborted()
    const more = db
      .transaction(() => {
        const facts = foldPage(db, projectDirectory, batch, stats)
        const tasks = foldTaskPage(db, projectDirectory, batch, stats)
        return facts || tasks
      })
      .immediate()
    if (!more) return stats
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/**
 * A project's projection is dropped once nobody has read its decision data for this long. The
 * triggers queue changes only for projects that have a state row, so a project that was folded
 * once and never read again would otherwise queue every update and delete for as long as it lives;
 * dropping bounds that, and the next read of the project rebuilds it by the paged first fold. The
 * fold costs a few milliseconds per 512 rows, paid once by the read that comes back after a week.
 */
export const PROJECTION_IDLE_DROP_MS = 7 * 24 * 60 * 60_000
/** How often an owner looks for idle projections: they only age by days. */
const SWEEP_INTERVAL_MS = 60 * 60_000

/** Rows deleted per transaction while a projection is dropped; a unit of work, not a ceiling. */
const DROP_BATCH_SIZE = 5_000

/**
 * Drop the projections idle past `idleMs`, except those in `keep`. The projection is marked
 * dropping first, which readers and triggers treat as absent, then its rows go a page per
 * transaction, then its state row.
 */
export async function dropIdleProjections(
  db: Database,
  options: { now: number; idleMs: number; keep?: ReadonlySet<string>; signal?: AbortSignal },
) {
  const cutoff = options.now - options.idleMs
  const idle = db
    .query<{ project_directory: string }, [number]>(
      `SELECT project_directory FROM ${TABLES.state}
       WHERE (CASE WHEN last_read_at>0 THEN last_read_at ELSE folded_at END)<?`,
    )
    .all(cutoff)
    .map((row) => row.project_directory)
    .filter((project) => !options.keep?.has(project))
  for (const project of idle) {
    db.query(`UPDATE ${TABLES.state} SET dropping=1 WHERE project_directory=?`).run(project)
    for (const table of [TABLES.facts, TABLES.tasks])
      for (;;) {
        options.signal?.throwIfAborted()
        const key = table === TABLES.facts ? "seq" : "task_id"
        const removed = db
          .query(
            `DELETE FROM ${table} WHERE project_directory=? AND ${key} IN
             (SELECT ${key} FROM ${table} WHERE project_directory=? LIMIT ?)`,
          )
          .run(project, project, DROP_BATCH_SIZE).changes
        if (removed < DROP_BATCH_SIZE) break
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    db.transaction(() => {
      db.query(`DELETE FROM ${TABLES.dirty} WHERE project_directory=?`).run(project)
      db.query(`DELETE FROM ${TABLES.taskDirty} WHERE project_directory=?`).run(project)
      db.query(`DELETE FROM ${TABLES.sessions} WHERE project_directory=?`).run(project)
      db.query(`DELETE FROM ${TABLES.state} WHERE project_directory=?`).run(project)
    }).immediate()
  }
  return idle
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
  private sweeping: Promise<unknown> | undefined
  private lastSweep = 0
  /** Per project, when `last_read_at` was last written; it is refreshed about once a minute. */
  private readonly readRecorded = new Map<string, number>()
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
    if (now - this.lastSweep > SWEEP_INTERVAL_MS) {
      this.lastSweep = now
      const shared = this.connection()
      if (ensureDecisionProjectionSchema(shared))
        this.sweeping = dropIdleProjections(shared.db, {
          now,
          idleMs: PROJECTION_IDLE_DROP_MS,
          keep: new Set(this.active.keys()),
        })
          .catch((error: unknown) => {
            this.lastError = error instanceof Error ? error : new Error(String(error))
          })
          .finally(() => {
            this.sweeping = undefined
          })
    }
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
      await this.sweeping
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
          this.recordRead(shared.db, project)
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

  /** Persist that the project was read (at most once a minute); it is what the idle drop ages. */
  private recordRead(db: Database, project: string) {
    const now = Date.now()
    if (now - (this.readRecorded.get(project) ?? 0) < 60_000) return
    this.readRecorded.set(project, now)
    db.query(`UPDATE ${TABLES.state} SET last_read_at=? WHERE project_directory=?`).run(
      now,
      project,
    )
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
