import type { TaskRepository } from "../storage.ts"
import type { ProjectUnit } from "./scope.ts"

/** What an all-projects read of one task or attempt names. */
export type OwnerQuery =
  { taskID: string } | { reference: string } | { attemptID: string } | { sessionID: string }

/**
 * The checkouts holding a task or attempt, from the shared database.
 * A reference matches a current reference first; only when none does is an old reference (an alias
 * of a re-coded project) tried, and an alias that more than one project holds names no task.
 */
function directoriesFor(
  repository: TaskRepository,
  query: OwnerQuery,
): { directory: string; taskID?: string }[] {
  const plain = (rows: { d: string }[]) => rows.map((row) => ({ directory: row.d }))
  return repository.read((db) => {
    if ("taskID" in query)
      return plain(
        db
          .query<{ d: string }, [string]>("SELECT project_directory AS d FROM tasks WHERE id=?")
          .all(query.taskID),
      )
    if ("attemptID" in query)
      return plain(
        db
          .query<{ d: string }, [string]>(
            "SELECT p.project_directory AS d FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id WHERE a.id=?",
          )
          .all(query.attemptID),
      )
    if ("sessionID" in query)
      return plain(
        db
          .query<{ d: string }, [string]>(
            `SELECT p.project_directory AS d FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id
              WHERE a.session_id=? ORDER BY a.started_at DESC`,
          )
          .all(query.sessionID),
      )
    const current = db
      .query<{ d: string; t: string }, [string]>(
        "SELECT project_directory AS d, task_id AS t FROM task_references WHERE reference=?",
      )
      .all(query.reference)
    if (current.length) return current.map((row) => ({ directory: row.d, taskID: row.t }))
    const aliased = db
      .query<{ d: string; t: string }, [string]>(
        `SELECT DISTINCT r.project_directory AS d, r.task_id AS t FROM task_reference_aliases al
           JOIN task_references r ON r.task_id=al.task_id
           JOIN lazers_project_paths pp ON pp.path=r.project_directory AND pp.key=al.project_key
          WHERE al.alias=?`,
      )
      .all(query.reference)
    return new Set(aliased.map((row) => row.d)).size === 1
      ? aliased.slice(0, 1).map((row) => ({ directory: row.d, taskID: row.t }))
      : []
  })
}

/** The unit that owns a task or attempt, and the task id a reference named, or undefined. */
export function findOwner(
  repository: TaskRepository,
  units: readonly ProjectUnit[],
  query: OwnerQuery,
): { unit: ProjectUnit; taskID?: string } | undefined {
  for (const { directory, taskID } of directoriesFor(repository, query)) {
    const unit = units.find((candidate) => candidate.directory === directory)
    if (unit) return { unit, ...(taskID ? { taskID } : {}) }
  }
  return undefined
}
