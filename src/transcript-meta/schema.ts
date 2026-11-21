import type { Database } from "bun:sqlite"
import { schemaModules } from "../database-schema.ts"
import { ensureProjectionStateSchema, resetProjectionState } from "../projections/lifecycle.ts"
import type { ProjectionSpec } from "../projections/owner.ts"
import { queueRef, queueTableSQL } from "../projections/queue.ts"
import { isTakeoverAttempt } from "../recovery/detector.ts"
import { RunnerStore } from "../runner/store.ts"
import type { TaskRepository } from "../storage.ts"
import { transcriptStep, type TranscriptStep } from "./step.ts"

/**
 * `transcript_steps` and `transcript_sessions`: the metadata LAZERS derives from the transcripts
 * of worker attempt sessions, folded by host cursor (`fold.ts`) and stored once (data-handling
 * principle 4; owner decision 2026-11-21: store the metadata the product requires, skip the
 * text). OpenCode owns message text: no column here holds text, tool input or output, reasoning
 * or an error message.
 *
 * ```
 * message.list(cursor) page ─► one transaction: steps of the page (upsert, compare first),
 *                                               steps the page no longer holds (deleted),
 *                                               the session row (cursor, base, count, state)
 * ```
 *
 * - `transcript_steps`: one row per assistant message. `ordinal` is the message's position in the
 *   whole transcript (every message type counts), so the report's transcript bound applies to it.
 * - `transcript_sessions`: the cursor (the host cursor of the page the next read starts at: the
 *   tail page is read again, as `core/host-messages.ts` does), `base_ordinal` (messages before
 *   that page), `message_count` (every message type) and `read_state`: `not-read` until a pass
 *   reaches the end of the transcript, then `available`; `unavailable` when reads fail before
 *   one has. A session OpenCode no longer has keeps its rows and state.
 * - Tool calls are not stored here: `native_tool_call_display` holds them (session, message, call).
 */
const MODULE = schemaModules["transcript-meta"]
const TRANSCRIPT_META = "transcript-meta"
export const TRANSCRIPT_META_QUEUE = "transcript_meta_dirty"

/** Raise when the stored derivation changes: the seed queues every attempt session again. */
const TRANSCRIPT_META_GENERATION = 1

const TABLES_SQL = `
  CREATE TABLE transcript_steps (
    id INTEGER PRIMARY KEY,
    project_directory TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    provider_id TEXT, model_id TEXT, variant TEXT,
    created_at INTEGER, streamed_at INTEGER, completed_at INTEGER,
    input_tokens INTEGER, output_tokens INTEGER,
    error_type TEXT, retry_at INTEGER, retry_attempt INTEGER, retry_error_type TEXT,
    UNIQUE(project_directory, session_id, message_id)
  );
  CREATE INDEX transcript_steps_order ON transcript_steps(project_directory, session_id, ordinal);
  CREATE TABLE transcript_sessions (
    id INTEGER PRIMARY KEY,
    project_directory TEXT NOT NULL, session_id TEXT NOT NULL,
    cursor TEXT, base_ordinal INTEGER NOT NULL, message_count INTEGER NOT NULL,
    read_state TEXT NOT NULL CHECK(read_state IN ('not-read','available','unavailable')),
    UNIQUE(project_directory, session_id)
  );
  ${queueTableSQL(TRANSCRIPT_META_QUEUE)}
`

/** A worker attempt, not an Architect takeover (`isTakeoverAttempt` in SQL; invalid JSON is not). */
const workerPolicy = (row: "NEW") =>
  `COALESCE(CASE WHEN json_valid(${row}.policy) THEN json_type(${row}.policy,'$.takeover') END,'null')='null'`
const attemptRef = (row: "NEW") =>
  `COALESCE(${row}.project_directory,(SELECT p.project_directory FROM runner_plans p WHERE p.id=${row}.plan_id))||char(0)||${row}.session_id`

/**
 * An attempt's insert and each change of its state queue its session, so the start and the last
 * messages of an attempt are read without depending on a native event.
 */
const TRIGGERS = [
  { name: "transcript_meta_q_attempt_insert", event: "INSERT" },
  { name: "transcript_meta_q_attempt_update", event: "UPDATE OF state,session_id" },
] as const

/** The tables and triggers, rebuilt from nothing; the seed and the fold refill them. */
function installTranscriptMetaSchema(db: Database) {
  for (const trigger of TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`)
  db.exec(
    `DROP TABLE IF EXISTS transcript_steps; DROP TABLE IF EXISTS transcript_sessions;
     DROP TABLE IF EXISTS ${TRANSCRIPT_META_QUEUE};`,
  )
  db.exec(TABLES_SQL)
  resetProjectionState(db, TRANSCRIPT_META)
  for (const trigger of TRIGGERS)
    db.exec(
      `CREATE TRIGGER ${trigger.name} AFTER ${trigger.event} ON runner_attempts
       WHEN ${workerPolicy("NEW")} BEGIN
         ${queueRef(TRANSCRIPT_META_QUEUE, attemptRef("NEW"))}
       END;`,
    )
}

/** Install through the module registry; the attempt triggers need the runner's tables first. */
export function ensureTranscriptMetaSchema(repository: TaskRepository) {
  void new RunnerStore(repository)
  ensureProjectionStateSchema(repository)
  repository.installSchema("transcript-meta", MODULE.generation, MODULE.tables, (db) =>
    installTranscriptMetaSchema(db),
  )
}

export type TranscriptReadState = "not-read" | "available" | "unavailable"
export type StoredTranscriptSession = {
  cursor: string | null
  base: number
  messageCount: number
  state: TranscriptReadState
}

export function storedTranscriptSession(
  db: Database,
  project: string,
  sessionID: string,
): StoredTranscriptSession | undefined {
  const row = db
    .query<
      { cursor: string | null; base_ordinal: number; message_count: number; read_state: string },
      [string, string]
    >(
      `SELECT cursor,base_ordinal,message_count,read_state FROM transcript_sessions
       WHERE project_directory=? AND session_id=?`,
    )
    .get(project, sessionID)
  return row
    ? {
        cursor: row.cursor,
        base: row.base_ordinal,
        messageCount: row.message_count,
        state: row.read_state as TranscriptReadState,
      }
    : undefined
}

const STEP_COLUMNS = [
  "ordinal",
  "provider_id",
  "model_id",
  "variant",
  "created_at",
  "streamed_at",
  "completed_at",
  "input_tokens",
  "output_tokens",
  "error_type",
  "retry_at",
  "retry_attempt",
  "retry_error_type",
] as const

const stepValues = (step: TranscriptStep) => [
  step.ordinal,
  step.providerID,
  step.modelID,
  step.variant,
  step.createdAt,
  step.streamedAt,
  step.completedAt,
  step.inputTokens,
  step.outputTokens,
  step.errorType,
  step.retryAt,
  step.retryAttempt,
  step.retryErrorType,
]

function writeSession(
  db: Database,
  project: string,
  sessionID: string,
  row: StoredTranscriptSession,
) {
  db.query(
    `INSERT INTO transcript_sessions(project_directory,session_id,cursor,base_ordinal,message_count,read_state)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(project_directory,session_id) DO UPDATE SET
       cursor=excluded.cursor,base_ordinal=excluded.base_ordinal,
       message_count=excluded.message_count,read_state=excluded.read_state
     WHERE cursor IS NOT excluded.cursor OR base_ordinal IS NOT excluded.base_ordinal
       OR message_count IS NOT excluded.message_count OR read_state IS NOT excluded.read_state`,
  ).run(project, sessionID, row.cursor, row.base, row.messageCount, row.state)
}

/**
 * One page read from `from` (the stored cursor and base) in the caller's transaction: its steps,
 * the steps it no longer holds, and the session row. `next` is the host cursor after the page, or
 * undefined at the end of the transcript, where the cursor stays so the tail page is read again.
 * Returns the state the next page starts from. A step or session row that is unchanged is not
 * written.
 */
export function writeTranscriptPage(
  db: Database,
  project: string,
  sessionID: string,
  from: StoredTranscriptSession,
  page: readonly unknown[],
  next: string | undefined,
): StoredTranscriptSession {
  const upsert = db.query(
    `INSERT INTO transcript_steps(project_directory,session_id,message_id,${STEP_COLUMNS.join(",")})
     VALUES(?,?,?,${STEP_COLUMNS.map(() => "?").join(",")})
     ON CONFLICT(project_directory,session_id,message_id) DO UPDATE SET
       ${STEP_COLUMNS.map((column) => `${column}=excluded.${column}`).join(",")}
     WHERE ${STEP_COLUMNS.map((column) => `${column} IS NOT excluded.${column}`).join(" OR ")}`,
  )
  const ids: string[] = []
  for (const [index, raw] of page.entries()) {
    const step = transcriptStep(raw, from.base + index)
    if (!step) continue
    ids.push(step.messageID)
    upsert.run(project, sessionID, step.messageID, ...(stepValues(step) as never[]))
  }
  const end = from.base + page.length
  // A message the host no longer lists at these positions (a revert) is not a step any more.
  db.query(
    `DELETE FROM transcript_steps WHERE project_directory=? AND session_id=?
       AND ordinal>=? AND ordinal<? AND message_id NOT IN (SELECT value FROM json_each(?))`,
  ).run(project, sessionID, from.base, end, JSON.stringify(ids))
  if (next === undefined)
    db.query(
      "DELETE FROM transcript_steps WHERE project_directory=? AND session_id=? AND ordinal>=?",
    ).run(project, sessionID, end)
  const state: StoredTranscriptSession =
    next === undefined
      ? { cursor: from.cursor, base: from.base, messageCount: end, state: "available" }
      : {
          cursor: next,
          base: end,
          messageCount: Math.max(from.messageCount, end),
          state: from.state,
        }
  writeSession(db, project, sessionID, state)
  return state
}

/** A failed or impossible read: rows stay; a session never read in full reads `unavailable`. */
export function markTranscriptUnavailable(db: Database, project: string, sessionID: string) {
  const stored = storedTranscriptSession(db, project, sessionID)
  if (stored?.state === "available") return
  writeSession(db, project, sessionID, {
    cursor: stored?.cursor ?? null,
    base: stored?.base ?? 0,
    messageCount: stored?.messageCount ?? 0,
    state: "unavailable",
  })
}

/** The route facts of a session's steps below `ordinal`, in transcript order. */
export type TranscriptRouteRow = {
  message_id: string
  provider_id: string | null
  model_id: string | null
  variant: string | null
  created_at: number | null
}

/** Steps per route page: an index range of `transcript_steps_order`. */
const ROUTE_PAGE = 1_000

/**
 * One page of a session's step routes, in transcript order, from `ordinal` (inclusive) to `below`
 * (exclusive). The caller pages by the last ordinal + 1 until a page is short.
 */
function transcriptRoutePage(
  db: Database,
  project: string,
  sessionID: string,
  from: number,
  below: number,
): Array<TranscriptRouteRow & { ordinal: number }> {
  return db
    .query<TranscriptRouteRow & { ordinal: number }, [string, string, number, number, number]>(
      `SELECT ordinal,message_id,provider_id,model_id,variant,created_at FROM transcript_steps
       WHERE project_directory=? AND session_id=? AND ordinal>=? AND ordinal<?
       ORDER BY ordinal LIMIT ?`,
    )
    .all(project, sessionID, from, below, ROUTE_PAGE)
}

/** Every step route of a session below `below`, read a page at a time through `read`. */
export function* transcriptRoutes(
  read: <T>(run: (db: Database) => T) => T,
  project: string,
  sessionID: string,
  below: number,
): Generator<TranscriptRouteRow> {
  let from = 0
  for (;;) {
    const page = read((db) => transcriptRoutePage(db, project, sessionID, from, below))
    yield* page
    if (page.length < ROUTE_PAGE) return
    from = page.at(-1)!.ordinal + 1
  }
}

/** A queue ref names the project and the session: one queue serves every project of a database. */
const transcriptRef = (project: string, sessionID: string) => `${project}\u0000${sessionID}`
export const transcriptRefRange = (project: string) =>
  [`${project}\u0000`, `${project}\u0001`] as const

/**
 * Queue a session for a read at `at`. A hint resets a parked entry's backoff; a seed (at 1) goes
 * after hints and never moves an entry already queued.
 */
export function queueTranscript(
  db: Database,
  project: string,
  sessionID: string,
  kind: "hint" | "seed",
  at = 0,
) {
  const ref = transcriptRef(project, sessionID)
  if (kind === "hint")
    db.query(
      `INSERT INTO ${TRANSCRIPT_META_QUEUE}(ref,next_at) VALUES(?,?)
       ON CONFLICT(ref) DO UPDATE SET next_at=MIN(next_at,excluded.next_at),attempts=0,error=NULL`,
    ).run(ref, at)
  else db.query(`INSERT OR IGNORE INTO ${TRANSCRIPT_META_QUEUE}(ref,next_at) VALUES(?,1)`).run(ref)
}

/** True when `sessionID` is a worker attempt session of the project (not an Architect takeover). */
export function isAttemptSession(db: Database, project: string, sessionID: string) {
  const row = db
    .query<{ policy: string }, [string, string]>(
      `SELECT a.policy FROM runner_attempts a
       WHERE a.session_id=?
         AND COALESCE(a.project_directory,(SELECT p.project_directory FROM runner_plans p WHERE p.id=a.plan_id))=?`,
    )
    .get(sessionID, project)
  return row !== null && !isTakeoverAttempt(row.policy)
}

/**
 * Attempts per seed page: queue inserts only, no host read. Measured in `fold.test.ts` (seed):
 * 252 attempts, 2 pages.
 */
const SEED_ROWS = 200

/**
 * The seed: every worker attempt session of the project is queued once per generation; the fold
 * reads them by cursor. Scope: the project directory.
 */
export const transcriptMetaSeedProjection: ProjectionSpec = {
  name: TRANSCRIPT_META,
  generation: TRANSCRIPT_META_GENERATION,
  backfill: [
    {
      name: "attempts",
      page(db, scope, after) {
        const rows = db
          .query<{ id: number; session_id: string; policy: string }, [number, string, number]>(
            `SELECT a.rowid AS id, a.session_id, a.policy FROM runner_attempts a
             WHERE a.rowid>?
               AND COALESCE(a.project_directory,(SELECT p.project_directory FROM runner_plans p WHERE p.id=a.plan_id))=?
             ORDER BY a.rowid LIMIT ?`,
          )
          .all(after, scope, SEED_ROWS)
        for (const row of rows)
          if (!isTakeoverAttempt(row.policy)) queueTranscript(db, scope, row.session_id, "seed")
        return { next: rows.at(-1)?.id ?? after, done: rows.length < SEED_ROWS }
      },
    },
  ],
}
