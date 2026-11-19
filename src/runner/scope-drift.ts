import type { Database } from "bun:sqlite"
import { scopeViolations } from "./artifacts.ts"

/**
 * Files a running attempt has already edited outside its write scope, read from the progress
 * journal while the worker still runs. Verification finds the same violation only after the
 * attempt ends, which cost one attempt 75 minutes. Only edit and patch targets count: they are
 * the writes the host reports with file paths; shell writes stay for verification to catch.
 */
export function readScopeDrift(
  db: Database,
  projectDirectory: string,
  attemptID: string,
  scope: string[],
): string[] {
  const rows = db
    .query<{ paths: string | null }, [string, string]>(
      `SELECT json_extract(payload,'$.fileTargets.paths') AS paths
         FROM runner_progress
        WHERE project_directory=? AND attempt_id=? AND kind='tool'
          AND json_extract(payload,'$.fileTargets.operation') IN ('edit','patch')
          AND coalesce(json_extract(payload,'$.status'),'') <> 'failed'`,
    )
    .all(projectDirectory, attemptID)
  const edited = new Set<string>()
  for (const row of rows) {
    try {
      const paths = JSON.parse(row.paths ?? "[]") as unknown
      if (Array.isArray(paths))
        for (const path of paths) if (typeof path === "string" && path) edited.add(path)
    } catch {
      /* an unreadable target list names no file */
    }
  }
  return scopeViolations([...edited], scope).toSorted()
}
