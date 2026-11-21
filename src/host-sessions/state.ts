import type { Database } from "bun:sqlite"
import { schemaModules } from "../database-schema.ts"
import { ensureProjectionStateSchema, resetProjectionState } from "../projections/lifecycle.ts"
import type { ProjectionSpec } from "../projections/owner.ts"
import { queueTableSQL } from "../projections/queue.ts"
import { contractText } from "../progress/display.ts"
import type { TaskRepository } from "../storage.ts"
import { privacyStats } from "../trajectory/privacy.ts"

/**
 * `host_session_state`: the live OpenCode facts of each session of a project, one row per
 * session, kept by a fold of host reads (`fold.ts`) so a stream reads them as rows instead of
 * asking the host per panel read.
 *
 * ```
 * native event (hint) ─┐                         ┌─ session.get            (every read)
 * attach / gap resync ─┼─► host_session_dirty ─► fold ─┤
 * seed backfill ───────┘    (ref, next_at)       └─ inbox/permissions/forms (busy, or a hint
 *                                                    that can change them)
 *                         compare, then write ─► host_session_state
 * ```
 *
 * Only what a panel shows is stored: status, counts, ids, routes, token totals, times and the
 * session's own title (the host's short label on its session record, a session attribute like
 * `agent`, redacted and cut to 200 characters as the live monitor showed it). No transcript text
 * (owner decision, 2026-11-21: OpenCode holds transcripts); nothing is derived from messages.
 *
 * `host_updated_at` is the host's `time.updated`: a read older than the stored stamp is ignored,
 * so a slow read finishing after a newer one never moves a row back. `updated_at` is when a shown
 * column last changed (this process's clock): the Radar's "recent" order.
 */
const MODULE = schemaModules["host-sessions"]
const HOST_SESSION_STATE = "host-session-state"
export const HOST_SESSION_QUEUE = "host_session_dirty"

/** Raise when the stored columns change: the seed queues every tracked session again. */
const HOST_SESSION_STATE_GENERATION = 1

const TABLES_SQL = `
  CREATE TABLE host_session_state (
    id INTEGER PRIMARY KEY,
    project_directory TEXT NOT NULL, session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    agent TEXT, title TEXT, attempt_id TEXT, task_id TEXT, parent_session_id TEXT, directory TEXT,
    busy INTEGER NOT NULL, pending_input INTEGER NOT NULL,
    pending_permissions INTEGER NOT NULL, pending_forms INTEGER NOT NULL,
    outcome TEXT, archived INTEGER NOT NULL,
    route_provider TEXT, route_model TEXT, route_variant TEXT,
    tokens_in INTEGER, tokens_out INTEGER,
    created_at INTEGER, updated_at INTEGER NOT NULL, host_updated_at INTEGER NOT NULL,
    UNIQUE(project_directory, session_id)
  );
  CREATE INDEX host_session_state_recent
    ON host_session_state(project_directory, archived, updated_at DESC, id);
  CREATE INDEX host_session_state_parent
    ON host_session_state(project_directory, parent_session_id, updated_at DESC, id);
  ${queueTableSQL(HOST_SESSION_QUEUE)}
`

/** The tables, rebuilt from nothing; the seed and the fold refill them. */
function installHostSessionStateSchema(db: Database) {
  db.exec(`DROP TABLE IF EXISTS host_session_state; DROP TABLE IF EXISTS ${HOST_SESSION_QUEUE};`)
  db.exec(TABLES_SQL)
  resetProjectionState(db, HOST_SESSION_STATE)
}

export function ensureHostSessionStateSchema(repository: TaskRepository) {
  ensureProjectionStateSchema(repository)
  repository.installSchema("host-sessions", MODULE.generation, MODULE.tables, (db) =>
    installHostSessionStateSchema(db),
  )
}

/** A session as one host record (`session.get` or a `session.list` row) shows it. */
export type HostSessionRecord = {
  id: string
  projectID: string
  parentID: string | null
  agent: string | null
  /** The session record's own `title`; never read from messages. */
  title: string | null
  directory: string | null
  archived: boolean
  /** Started executing after it last went idle (`time.busy > time.idle`). */
  busy: boolean
  outcome: string | null
  model: { providerID: string; id: string; variant: string | null } | null
  tokensIn: number | null
  tokensOut: number | null
  createdAt: number | null
  /** The host's `time.updated`: the stamp. */
  updatedAt: number
}

/** What only the inbox, permission and form reads show (`RunnerHost.session`). */
export type HostSessionPending = {
  busy: boolean
  pendingInput: boolean
  pendingPermissions: number
  pendingForms: number
  outcome: string | null
}

/** The host reads the fold makes; the native adapter is `native.ts`, tests pass a fake. */
export type HostSessionSource = {
  /** One `session.get`; null when the host has no such session. */
  get(sessionID: string): Promise<HostSessionRecord | null>
  /** The inbox, permission and form reads of one session; null when it is gone. */
  pending(sessionID: string): Promise<HostSessionPending | null>
  /** One page of the project's sessions that are not archived, by host cursor. */
  list(
    projectID: string,
    cursor: string | undefined,
  ): Promise<{ records: HostSessionRecord[]; next?: string }>
}

/** Ids, agent and route names are stored only when they are plain short identifiers. */
const idText = (value: string | null | undefined, maximum = 200) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  !/[\p{Cc}]/u.test(value)
    ? value
    : null

/** The title as the live monitor showed it: trimmed, secrets redacted, at most 200 characters. */
const titleText = (value: string | null) => {
  const trimmed = value?.trim()
  return trimmed ? contractText(trimmed, privacyStats(), 200) : null
}

export type HostSessionWrite = "written" | "unchanged" | "stale" | "deleted" | "absent"

type Row = {
  role: string
  agent: string | null
  title: string | null
  attempt_id: string | null
  task_id: string | null
  parent_session_id: string | null
  directory: string | null
  busy: number
  pending_input: number
  pending_permissions: number
  pending_forms: number
  outcome: string | null
  archived: number
  route_provider: string | null
  route_model: string | null
  route_variant: string | null
  tokens_in: number | null
  tokens_out: number | null
  created_at: number | null
  host_updated_at: number
}
const SHOWN = [
  "role",
  "agent",
  "title",
  "attempt_id",
  "task_id",
  "parent_session_id",
  "directory",
  "busy",
  "pending_input",
  "pending_permissions",
  "pending_forms",
  "outcome",
  "archived",
  "route_provider",
  "route_model",
  "route_variant",
  "tokens_in",
  "tokens_out",
  "created_at",
] as const satisfies readonly (keyof Row)[]

export function storedHostSession(db: Database, project: string, sessionID: string) {
  return (
    db
      .query<Row, [string, string]>(
        `SELECT ${SHOWN.join(",")},host_updated_at FROM host_session_state
         WHERE project_directory=? AND session_id=?`,
      )
      .get(project, sessionID) ?? undefined
  )
}

/**
 * Fold one host read into the row of `sessionID`, in the caller's write transaction. `record`
 * null (the host has no such session) or of another project deletes the row. A record older than
 * the stored stamp is ignored. `pending` absent keeps the stored counts while the session is
 * busy (only an inbox, permission, form or execution change moves them, and those reads pass
 * `pending`) and clears them when it is not. Writes only what differs.
 */
export function writeHostSession(
  db: Database,
  project: string,
  projectID: string,
  sessionID: string,
  record: HostSessionRecord | null,
  pending?: HostSessionPending | null,
  now = Date.now(),
): HostSessionWrite {
  const stored = storedHostSession(db, project, sessionID)
  if (!record || record.id !== sessionID || record.projectID !== projectID || pending === null) {
    if (!stored) return "absent"
    db.query("DELETE FROM host_session_state WHERE project_directory=? AND session_id=?").run(
      project,
      sessionID,
    )
    return "deleted"
  }
  if (stored && record.updatedAt < stored.host_updated_at) return "stale"
  const attempt = db
    .query<{ id: string; task_id: string }, [string]>(
      "SELECT id,task_id FROM runner_attempts WHERE session_id=?",
    )
    .get(sessionID)
  const agent = idText(record.agent)
  const busy = pending ? pending.busy : record.busy
  const row: Row = {
    role: attempt ? "worker" : agent === "architect" ? "architect" : "unmanaged",
    agent,
    title: titleText(record.title),
    attempt_id: attempt?.id ?? null,
    task_id: attempt?.task_id ?? null,
    parent_session_id: idText(record.parentID),
    directory: idText(record.directory, 4096),
    busy: Number(busy),
    pending_input: pending ? Number(pending.pendingInput) : busy ? (stored?.pending_input ?? 0) : 0,
    pending_permissions: pending
      ? pending.pendingPermissions
      : busy
        ? (stored?.pending_permissions ?? 0)
        : 0,
    pending_forms: pending ? pending.pendingForms : busy ? (stored?.pending_forms ?? 0) : 0,
    outcome: idText(pending ? pending.outcome : record.outcome, 32),
    archived: Number(record.archived),
    route_provider: idText(record.model?.providerID),
    route_model: idText(record.model?.id, 300),
    route_variant: idText(record.model?.variant),
    tokens_in: record.tokensIn,
    tokens_out: record.tokensOut,
    created_at: record.createdAt,
    host_updated_at: record.updatedAt,
  }
  const shownChanged = !stored || SHOWN.some((column) => stored[column] !== row[column])
  if (!shownChanged && stored.host_updated_at === row.host_updated_at) return "unchanged"
  const columns = [...SHOWN, "host_updated_at"] as const
  db.query(
    `INSERT INTO host_session_state(project_directory,session_id,${columns.join(",")},updated_at)
     VALUES(?,?,${columns.map(() => "?").join(",")},?)
     ON CONFLICT(project_directory,session_id) DO UPDATE SET
       ${columns.map((column) => `${column}=excluded.${column}`).join(",")}
       ${shownChanged ? ",updated_at=excluded.updated_at" : ""}`,
  ).run(project, sessionID, ...columns.map((column) => row[column]), now)
  return "written"
}

/** A queue ref names the project and the session: one queue serves every project of a database. */
const hostSessionRef = (project: string, sessionID: string) => `${project}\u0000${sessionID}`
export const hostSessionRefRange = (project: string) =>
  [`${project}\u0000`, `${project}\u0001`] as const

/** Queue a session for a read. A hint (`next_at` 0) goes before seeds and resyncs (1). */
export function queueHostSession(
  db: Database,
  project: string,
  sessionID: string,
  kind: "hint" | "seed",
) {
  const ref = hostSessionRef(project, sessionID)
  if (kind === "hint")
    db.query(
      `INSERT INTO ${HOST_SESSION_QUEUE}(ref,next_at) VALUES(?,0)
       ON CONFLICT(ref) DO UPDATE SET next_at=0,attempts=0,error=NULL`,
    ).run(ref)
  else db.query(`INSERT OR IGNORE INTO ${HOST_SESSION_QUEUE}(ref,next_at) VALUES(?,1)`).run(ref)
}

/**
 * Sessions per seed page: queue inserts only, no host read. Measured on a fixture of the live
 * counts (252 attempts, 763 task sessions): 6 pages, slowest 0.6 ms.
 */
const HOST_SESSION_SEED_ROWS = 200

const seedPage =
  (select: string) =>
  (db: Database, scope: string, after: number): { next: number; done: boolean } => {
    const rows = db
      .query<{ id: number; session_id: string }, [number, string, number]>(select)
      .all(after, scope, HOST_SESSION_SEED_ROWS)
    for (const row of rows) queueHostSession(db, scope, row.session_id, "seed")
    return { next: rows.at(-1)?.id ?? after, done: rows.length < HOST_SESSION_SEED_ROWS }
  }

/**
 * The seed: every session the project's work names (attempt sessions, and the creator and owner
 * sessions of its tasks: Architects and people) is queued once per generation, so archived and
 * quiet sessions get a row too. The fold reads them; sessions that no runner row names (children,
 * unmanaged sessions) come from the host inventory on attach and from their events.
 * Scope: the project directory.
 */
export const hostSessionSeedProjection: ProjectionSpec = {
  name: HOST_SESSION_STATE,
  generation: HOST_SESSION_STATE_GENERATION,
  backfill: [
    {
      name: "attempts",
      page: seedPage(
        `SELECT rowid AS id, session_id FROM runner_attempts
         WHERE rowid>? AND project_directory=? ORDER BY rowid LIMIT ?`,
      ),
    },
    {
      name: "task-sessions",
      page: seedPage(
        `SELECT s.rowid AS id, s.session_id FROM task_schedule_sessions s
           JOIN task_schedule t ON t.task_id=s.task_id
         WHERE s.rowid>? AND t.project_directory=? ORDER BY s.rowid LIMIT ?`,
      ),
    },
  ],
}
