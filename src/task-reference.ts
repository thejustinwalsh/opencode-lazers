import type { Database } from "bun:sqlite"

/**
 * The one lookup of a task's human reference (LZ-137) in a project. Shared by the repository
 * and by read-only readers that do not construct a repository.
 */
export function taskReferenceFor(
  db: Database,
  projectDirectory: string,
  taskID: string,
): string | undefined {
  return db
    .query<{ reference: string }, [string, string]>(
      "SELECT reference FROM task_references WHERE project_directory=? AND task_id=?",
    )
    .get(projectDirectory, taskID)?.reference
}
