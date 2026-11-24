import type { Database } from "bun:sqlite"

/**
 * Open takeovers own their source worker until handoff finishes. Keep this predicate aligned
 * with `TakeoverExecution.open` and the runner-takeover lifecycle's nonterminal states.
 */
export function hasOpenTakeoverForAttempt(
  db: Database,
  projectDirectory: string,
  planID: string,
  attemptID: string,
): boolean {
  return Boolean(
    db
      .query<{ held: number }, [string, string, string]>(
        `SELECT 1 AS held FROM runner_takeovers
         WHERE project_directory=? AND plan_id=? AND attempt_id=?
           AND state IN ('notifying','awaiting-handoff','stopping')
         LIMIT 1`,
      )
      .get(projectDirectory, planID, attemptID),
  )
}
