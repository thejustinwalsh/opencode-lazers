import { schemaModules } from "../database-schema.ts"
import type { TaskRepository } from "../storage.ts"

/** Append-only record families a session may write against. */
export type ObservedKind = "classification" | "correction" | "advice"

const READ_TOOL: Record<ObservedKind, string> = {
  classification: "lz-get-task",
  correction: "lz-inspect-task-corrections",
  advice: "lz-get-task",
}

/**
 * Durable per-session view of each task's record revisions. Models never supply a revision: the
 * runtime records what a session read or wrote and hands that to storage's compare-and-set, so a
 * session acting on an out-of-date view conflicts instead of superseding a newer record. The table
 * is shared by every process using the project database.
 */
export function installObservedRevisionsSchema(repository: TaskRepository) {
  repository.installSchema(
    "task-observations",
    schemaModules["task-observations"].generation,
    schemaModules["task-observations"].tables,
    (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_observed_revisions (
          project_directory TEXT NOT NULL,
          session_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('classification','correction','advice')),
          revision INTEGER NOT NULL CHECK(revision >= 0),
          PRIMARY KEY(project_directory, session_id, task_id, kind)
        ) WITHOUT ROWID;
      `)
    },
  )
}

/** Revisions only grow, so a late or stale observation never lowers what a session has seen. */
export function observeRevision(
  repository: TaskRepository,
  sessionID: string,
  taskID: string,
  kind: ObservedKind,
  revision: number,
) {
  repository.atomic((db) => {
    db.query(
      `INSERT INTO task_observed_revisions(project_directory,session_id,task_id,kind,revision)
       VALUES(?,?,?,?,?)
       ON CONFLICT(project_directory,session_id,task_id,kind)
       DO UPDATE SET revision=MAX(revision, excluded.revision)`,
    ).run(repository.projectDirectory, sessionID, taskID, kind, revision)
  })
}

function observedRevision(
  repository: TaskRepository,
  sessionID: string,
  taskID: string,
  kind: ObservedKind,
): number | undefined {
  return repository.atomic(
    (db) =>
      db
        .query<{ revision: number }, [string, string, string, string]>(
          "SELECT revision FROM task_observed_revisions WHERE project_directory=? AND session_id=? AND task_id=? AND kind=?",
        )
        .get(repository.projectDirectory, sessionID, taskID, kind)?.revision,
  )
}

type GuardedReceipt =
  | { status: "recorded" | "replayed"; [record: string]: unknown }
  | {
      status: "conflict"
      message: string
      expectedRevision?: number
      currentRevision?: number
      [field: string]: unknown
    }

/**
 * Run one write against the revision this session last observed (0 when it has observed none; a
 * task with no records is at 0, so a first write needs no prior read). Storage compares inside its
 * write transaction. A recorded write becomes the session's observation.
 */
export function guardedWrite<R extends GuardedReceipt>(
  repository: TaskRepository,
  scope: { sessionID: string; taskID: string; kind: ObservedKind; recordKey: string },
  write: (expectedRevision: number) => R,
): R {
  const observed = observedRevision(repository, scope.sessionID, scope.taskID, scope.kind)
  const receipt = write(observed ?? 0)
  const record = receipt[scope.recordKey] as
    { revision: number; sessionID?: string; provenance?: { sessionID: string } } | undefined
  if (receipt.status === "recorded" && record)
    observeRevision(repository, scope.sessionID, scope.taskID, scope.kind, record.revision)
  else if (
    receipt.status === "replayed" &&
    record &&
    (record.sessionID ?? record.provenance?.sessionID) === scope.sessionID
  )
    observeRevision(repository, scope.sessionID, scope.taskID, scope.kind, record.revision)
  else if (receipt.status === "conflict" && receipt.expectedRevision !== undefined) {
    const current = receipt.currentRevision
    const tool = READ_TOOL[scope.kind]
    const why =
      observed === undefined
        ? `This session has not inspected this task's ${scope.kind} history`
        : `This session last saw ${scope.kind} revision ${observed}`
    return {
      ...receipt,
      message: `${why}, but it is at revision ${current}. Nothing was written. Read the task with ${tool}, decide whether the change still applies, then retry with a new requestID.`,
    }
  }
  return receipt
}
