import { schemaModules } from "../database-schema.ts"
import type { TaskRepository } from "../storage.ts"

/**
 * The native `time.updated` a session had at its last complete reconstruction, per attempt.
 * An unchanged stamp proves the retained context is the one already reconciled, so the boot
 * baseline and every later check can skip the `session.context` read. `handoff` keeps the one
 * fact the stale-handoff reminder derives from that context.
 */
export type SessionStamp = { updated: number; handoff: boolean }

export function installSessionStampSchema(repository: TaskRepository) {
  const module = schemaModules["progress-reconcile"]
  repository.installSchema("progress-reconcile", module.generation, module.tables, (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS runner_progress_session_stamps (
        project_directory TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        updated INTEGER NOT NULL,
        handoff INTEGER NOT NULL,
        PRIMARY KEY(project_directory, attempt_id)
      ) WITHOUT ROWID;
    `)
  })
}

export function readSessionStamp(
  repository: TaskRepository,
  attemptID: string,
): SessionStamp | undefined {
  const row = repository.read((db) =>
    db
      .query<{ updated: number; handoff: number }, [string, string]>(
        `SELECT updated,handoff FROM runner_progress_session_stamps
         WHERE project_directory=? AND attempt_id=?`,
      )
      .get(repository.projectDirectory, attemptID),
  )
  return row ? { updated: row.updated, handoff: row.handoff === 1 } : undefined
}

export function writeSessionStamp(
  repository: TaskRepository,
  attemptID: string,
  sessionID: string,
  stamp: SessionStamp,
) {
  repository.atomic((db) => {
    db.query(
      `INSERT INTO runner_progress_session_stamps(project_directory,attempt_id,session_id,updated,handoff)
       VALUES(?,?,?,?,?)
       ON CONFLICT(project_directory,attempt_id)
       DO UPDATE SET updated=excluded.updated,handoff=excluded.handoff,session_id=excluded.session_id`,
    ).run(repository.projectDirectory, attemptID, sessionID, stamp.updated, stamp.handoff ? 1 : 0)
  })
}
