import type { AttemptRow, NodeRow, RunnerStore } from "../store.ts"

export type IntegrationTaskSource = { node: NodeRow; attempts: AttemptRow[] }

/** Load accepted sources by project task identity, not by the command's plan. */
export function integrationTaskSources(
  store: RunnerStore,
  taskIDs: readonly string[],
  selectedAttemptIDs: ReadonlyMap<string, string>,
): Map<string, IntegrationTaskSource> {
  const sources = new Map<string, IntegrationTaskSource>()
  if (!taskIDs.length) return sources
  if (new Set(taskIDs).size !== taskIDs.length)
    throw new Error("Integration task IDs must be unique")

  for (let offset = 0; offset < taskIDs.length; offset += 100) {
    const batch = taskIDs.slice(offset, offset + 100)
    const placeholders = batch.map(() => "?").join(",")
    const nodes = store.repository.read((db) =>
      db
        .query<NodeRow, [string, ...string[]]>(
          `SELECT n.plan_id,n.task_id,n.ordinal,n.state,n.version,n.reason,n.artifact,
                  n.snapshot,n.machine_version
           FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id
           WHERE p.project_directory=? AND n.task_id IN (${placeholders})
           ORDER BY n.task_id,n.plan_id LIMIT 101`,
        )
        .all(store.repository.projectDirectory, ...batch),
    )
    if (nodes.length > 100)
      throw new Error("Integration task membership is ambiguous or exceeds its retained limit")

    for (const node of nodes) {
      if (sources.has(node.task_id))
        throw new Error(`Task ${node.task_id} has ambiguous integration plan membership`)
      const selectedAttemptID = selectedAttemptIDs.get(node.task_id)
      const artifact = node.artifact
      const attempts = artifact
        ? store.repository.read((db) => {
            const query = db.query<AttemptRow, string[]>(
              `SELECT a.id,a.plan_id,a.task_id,a.number,a.session_id,a.message_id,a.workspace,
                      a.base_commit,a.artifact,a.policy,a.state,a.started_at,a.token_count,
                      a.tool_count,a.retry_count,a.cost
               FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id
               WHERE p.project_directory=? AND a.plan_id=? AND a.task_id=? AND a.artifact=?
                 ${selectedAttemptID ? "AND a.id=?" : ""}
               ORDER BY a.started_at DESC,a.number DESC,a.id DESC LIMIT ${selectedAttemptID ? 1 : 2}`,
            )
            return selectedAttemptID
              ? query.all(
                  store.repository.projectDirectory,
                  node.plan_id,
                  node.task_id,
                  artifact,
                  selectedAttemptID,
                )
              : query.all(store.repository.projectDirectory, node.plan_id, node.task_id, artifact)
          })
        : []
      sources.set(node.task_id, {
        node,
        attempts,
      })
    }
  }

  return sources
}
