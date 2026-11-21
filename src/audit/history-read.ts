import type { Database } from "bun:sqlite"

/** A task's audit runs as the detail shows them: the count and the newest run, or none. */
export function auditHistoryIn(db: Database, projectDirectory: string, taskID: string) {
  if (!db.query("SELECT name FROM sqlite_master WHERE name='audit_runs'").get()) return undefined
  const row = db
    .query<{ count: number; latestRunID: string | null }, [string, string, string, string]>(
      `SELECT COUNT(*) AS count,(SELECT id FROM audit_runs WHERE project_directory=? AND task_id=? ORDER BY started_at DESC,rowid DESC LIMIT 1) AS latestRunID FROM audit_runs WHERE project_directory=? AND task_id=?`,
    )
    .get(projectDirectory, taskID, projectDirectory, taskID)
  return row?.count ? { runCount: row.count, latestRunID: row.latestRunID } : undefined
}
