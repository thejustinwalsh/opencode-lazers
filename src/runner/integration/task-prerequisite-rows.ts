import type { RunnerStore } from "../store.ts"
import { planIs } from "../identity-read.ts"
import type { TaskPrerequisiteIntegrationRow } from "../prerequisite-proof.ts"

/** Latest task receipts across the project, preserving each task's owning plan identity. */
export function projectTaskPrerequisiteIntegrationRows(
  store: RunnerStore,
  taskIDs: readonly string[],
): TaskPrerequisiteIntegrationRow[] {
  if (!taskIDs.length || new Set(taskIDs).size !== taskIDs.length) return []
  const rows: TaskPrerequisiteIntegrationRow[] = []
  for (let offset = 0; offset < taskIDs.length; offset += 100) {
    const batch = taskIDs.slice(offset, offset + 100)
    const selected = store.repository.read((db) =>
      db
        .query<TaskPrerequisiteIntegrationRow, [string, ...string[]]>(
          `SELECT p.id AS plan_id,n.task_id,p.project_directory,n.state AS node_state,
               n.artifact,
               (SELECT tr.id FROM runner_transitions tr
                WHERE ${planIs(db, "runner_transitions", "tr", "n.plan_id")}
                  AND tr.task_id=n.task_id AND tr.event='TASK_INTEGRATION_RECORDED'
                ORDER BY tr.id DESC LIMIT 1) AS integration_id,
               (SELECT tr.payload FROM runner_transitions tr
                WHERE ${planIs(db, "runner_transitions", "tr", "n.plan_id")}
                  AND tr.task_id=n.task_id AND tr.event='TASK_INTEGRATION_RECORDED'
                ORDER BY tr.id DESC LIMIT 1) AS integration_payload
             FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id
             WHERE p.project_directory=? AND n.task_id IN (${batch.map(() => "?").join(",")})
             LIMIT ${batch.length + 1}`,
        )
        .all(store.repository.projectDirectory, ...batch),
    )
    if (selected.length > batch.length) return []
    rows.push(...selected)
  }
  return rows
}
