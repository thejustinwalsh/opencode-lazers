/** Read the scheduler's plan priority/FIFO and node ordinal; never mutate scheduling. */
export function scheduledTaskPageSQL(alias: "t" | "tasks", where: string, before: boolean) {
  return `WITH scheduled AS (
    SELECT ${alias}.body,r.reference,
      COUNT(*) OVER () - ROW_NUMBER() OVER (ORDER BY
        CASE WHEN schedule_node.state IN ('running','verifying')
          AND schedule_plan.state NOT IN ('blocked','cancelled') THEN 1 ELSE 0 END DESC,
        CASE WHEN schedule_plan.state='cancelling' THEN 1 ELSE 0 END DESC,
        CASE WHEN schedule_plan.id IS NULL THEN 1 ELSE 0 END,
        COALESCE(json_extract(schedule_plan.body,'$.priority'),0) DESC,
        schedule_plan.rowid,schedule_node.ordinal,${alias}.rowid
      ) + 1 AS position
    FROM tasks ${alias}
    JOIN task_references r ON r.project_directory=${alias}.project_directory AND r.task_id=${alias}.id
    LEFT JOIN runner_nodes schedule_node ON schedule_node.task_id=${alias}.id
    LEFT JOIN runner_plans schedule_plan ON schedule_plan.id=schedule_node.plan_id
      AND schedule_plan.project_directory=${alias}.project_directory
    WHERE ${where}
  ) SELECT body,reference,position FROM scheduled
    ${before ? "WHERE position<?" : ""} ORDER BY position DESC LIMIT ?`
}
