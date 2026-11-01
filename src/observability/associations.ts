import type { Database } from "bun:sqlite"

export type SessionAssociations = {
  taskIDs: Set<string>
  planIDs: Set<string>
}

/** Resolve only durable submission, plan-owner, and worker-attempt links. */
export function sessionAssociations(
  db: Database,
  projectDirectory: string,
  sessionID: string,
): SessionAssociations {
  const taskIDs = new Set(
    db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM tasks WHERE project_directory=? AND json_extract(body,'$.provenance.sessionID')=?",
      )
      .all(projectDirectory, sessionID)
      .map((row) => row.id),
  )
  const planIDs = new Set(
    db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM runner_plans WHERE project_directory=? AND owner=?",
      )
      .all(projectDirectory, sessionID)
      .map((row) => row.id),
  )
  for (const row of db
    .query<{ task_id: string; plan_id: string }, [string, string]>(
      `SELECT DISTINCT a.task_id,a.plan_id FROM runner_attempts a
       JOIN runner_plans p ON p.id=a.plan_id
       WHERE p.project_directory=? AND a.session_id=?`,
    )
    .all(projectDirectory, sessionID)) {
    taskIDs.add(row.task_id)
    planIDs.add(row.plan_id)
  }
  for (const row of db
    .query<{ id: string }, [string, string, string]>(
      `SELECT c.plan_id AS id FROM runner_continuations c
       JOIN runner_plans p ON p.id=c.plan_id
       WHERE p.project_directory=? AND (c.session_id=? OR c.parent_id=?)`,
    )
    .all(projectDirectory, sessionID, sessionID))
    planIDs.add(row.id)

  if (taskIDs.size > 0) {
    const ids = [...taskIDs]
    const placeholders = ids.map(() => "?").join(",")
    for (const row of db
      .query<{ plan_id: string }, (string | number)[]>(
        `SELECT DISTINCT n.plan_id FROM runner_nodes n
         JOIN runner_plans p ON p.id=n.plan_id
         WHERE p.project_directory=? AND n.task_id IN (${placeholders})`,
      )
      .all(projectDirectory, ...ids))
      planIDs.add(row.plan_id)
  }

  if (planIDs.size > 0) {
    const ids = [...planIDs]
    const placeholders = ids.map(() => "?").join(",")
    for (const row of db
      .query<{ task_id: string }, (string | number)[]>(
        `SELECT task_id FROM runner_nodes WHERE plan_id IN (${placeholders})`,
      )
      .all(...ids))
      taskIDs.add(row.task_id)
  }
  return { taskIDs, planIDs }
}

export function projectAssociations(db: Database, projectDirectory: string): SessionAssociations {
  return {
    taskIDs: new Set(
      db
        .query<{ id: string }, [string]>("SELECT id FROM tasks WHERE project_directory=?")
        .all(projectDirectory)
        .map((row) => row.id),
    ),
    planIDs: new Set(
      db
        .query<{ id: string }, [string]>("SELECT id FROM runner_plans WHERE project_directory=?")
        .all(projectDirectory)
        .map((row) => row.id),
    ),
  }
}

export function associatedSessionIDs(db: Database, projectDirectory: string) {
  const ids = new Set<string>()
  for (const row of db
    .query<{ session_id: string }, [string]>(
      `SELECT json_extract(body,'$.provenance.sessionID') AS session_id
       FROM tasks WHERE project_directory=?`,
    )
    .all(projectDirectory))
    if (row.session_id) ids.add(row.session_id)
  for (const row of db
    .query<{ session_id: string }, [string]>(
      "SELECT owner AS session_id FROM runner_plans WHERE project_directory=?",
    )
    .all(projectDirectory))
    ids.add(row.session_id)
  for (const row of db
    .query<{ session_id: string }, [string]>(
      `SELECT a.session_id FROM runner_attempts a
       JOIN runner_plans p ON p.id=a.plan_id WHERE p.project_directory=?`,
    )
    .all(projectDirectory))
    ids.add(row.session_id)
  for (const row of db
    .query<{ session_id: string | null; parent_id: string | null }, [string]>(
      `SELECT c.session_id,c.parent_id FROM runner_continuations c
       JOIN runner_plans p ON p.id=c.plan_id WHERE p.project_directory=?`,
    )
    .all(projectDirectory)) {
    if (row.session_id) ids.add(row.session_id)
    if (row.parent_id) ids.add(row.parent_id)
  }
  return ids
}
