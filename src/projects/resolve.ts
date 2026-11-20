import type { TaskRepository } from "../storage.ts"
import type { CanRead, ProjectUnit } from "./scope.ts"

/** What an all-projects read of one task or attempt names. */
export type OwnerQuery =
  { taskID: string } | { reference: string } | { attemptID: string } | { sessionID: string }

/**
 * The checkouts holding a task or attempt, from the shared database, restricted to `units`.
 * A reference matches a current reference first; only when none does is an old reference (an alias
 * of a re-coded project) tried, and an alias that more than one project holds names no task.
 */
function directoriesFor(repository: TaskRepository, query: OwnerQuery): string[] {
  return repository.read((db) => {
    if ("taskID" in query)
      return db
        .query<{ d: string }, [string]>("SELECT project_directory AS d FROM tasks WHERE id=?")
        .all(query.taskID)
        .map((row) => row.d)
    if ("attemptID" in query)
      return db
        .query<{ d: string }, [string]>(
          "SELECT p.project_directory AS d FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id WHERE a.id=?",
        )
        .all(query.attemptID)
        .map((row) => row.d)
    if ("sessionID" in query)
      return db
        .query<{ d: string }, [string]>(
          `SELECT p.project_directory AS d FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id
            WHERE a.session_id=? ORDER BY a.started_at DESC`,
        )
        .all(query.sessionID)
        .map((row) => row.d)
    const current = db
      .query<{ d: string }, [string]>(
        "SELECT project_directory AS d FROM task_references WHERE reference=?",
      )
      .all(query.reference)
    if (current.length) return current.map((row) => row.d)
    const aliased = db
      .query<{ d: string }, [string]>(
        `SELECT DISTINCT r.project_directory AS d FROM task_reference_aliases al
           JOIN task_references r ON r.task_id=al.task_id
           JOIN lazers_project_paths pp ON pp.path=r.project_directory AND pp.key=al.project_key
          WHERE al.alias=?`,
      )
      .all(query.reference)
    const projects = new Set(aliased.map((row) => row.d))
    return projects.size === 1 ? [...projects] : []
  })
}

/**
 * The unit that owns a task or attempt, or undefined when none exists or the caller may not read
 * it. The two cases are indistinguishable on purpose: a refused project is never confirmed.
 */
export async function findOwner(
  repository: TaskRepository,
  units: readonly ProjectUnit[],
  canRead: CanRead,
  query: OwnerQuery,
): Promise<ProjectUnit | undefined> {
  for (const directory of directoriesFor(repository, query)) {
    const unit = units.find((candidate) => candidate.directory === directory)
    if (unit && (await canRead(unit))) return unit
  }
  return undefined
}
