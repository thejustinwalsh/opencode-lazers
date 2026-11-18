import { planPrioritySortSQL } from "../runner/priority.ts"

/**
 * State rank of a task for the list, from the same effective-state rules as `state-filter.ts`:
 * a cancelled plan or node is cancelled, a blocked plan holds its running node out of Running.
 *
 *   0 running or verifying   1 other open (queued, ready, waiting, blocked, paused, unplanned)
 *   2 accepted   3 integrated   4 failed or exhausted   5 cancelled
 */
export const STATE_RANK_SQL = (node: string, plan: string) => `CASE
  WHEN ${node}.state='cancelled' OR ${plan}.state='cancelled' THEN 5
  WHEN ${node}.state IN ('failed','exhausted') THEN 4
  WHEN ${node}.state='incorporated' THEN 3
  WHEN ${node}.state='accepted' THEN 2
  WHEN ${node}.state IN ('running','verifying') AND ${plan}.state!='blocked' THEN 0
  ELSE 1
END`

/**
 * One sort key for every filter and page, computed in the read; never mutates scheduling.
 *
 *   1. state rank (above)
 *   2a. open ranks: plan priority (1 first, none last), plan FIFO, node ordinal, task rowid;
 *       unplanned tasks follow all planned work, most recent first
 *   2b. finished ranks: most recently finished first, then plan priority, then task rowid
 *       (newest first). Finished time is the latest recorded transition of the node into its
 *       current state (`runner_transitions.created_at`); a task cancelled with its plan uses the
 *       plan's latest transition; with no record it sorts as oldest.
 *
 * `position` pages over the whole key, so cursors stay stable and gap-free.
 */
export function scheduledTaskPageSQL(alias: "t" | "tasks", where: string, before: boolean) {
  return `WITH ranked AS (
    SELECT ${alias}.body AS body,r.reference AS reference,${alias}.rowid AS task_rowid,
      schedule_plan.id AS plan_id,schedule_plan.rowid AS plan_rowid,
      schedule_node.ordinal AS ordinal,schedule_node.plan_id AS node_plan,schedule_node.task_id AS node_task,
      schedule_node.state AS node_state,
      ${planPrioritySortSQL("schedule_plan.body")} AS priority_key,
      ${STATE_RANK_SQL("schedule_node", "schedule_plan")} AS rank
    FROM tasks ${alias}
    JOIN task_references r ON r.project_directory=${alias}.project_directory AND r.task_id=${alias}.id
    LEFT JOIN runner_nodes schedule_node ON schedule_node.task_id=${alias}.id
    LEFT JOIN runner_plans schedule_plan ON schedule_plan.id=schedule_node.plan_id
      AND schedule_plan.project_directory=${alias}.project_directory
    WHERE ${where}
  ), timed AS (
    SELECT *,CASE WHEN rank>=2 THEN COALESCE(
        (SELECT MAX(tr.created_at) FROM runner_transitions tr
          WHERE tr.plan_id=node_plan AND tr.task_id=node_task
            AND json_extract(tr.payload,'$.to')=node_state),
        (SELECT MAX(tr.created_at) FROM runner_transitions tr WHERE tr.plan_id=node_plan),0)
      ELSE 0 END AS finished
    FROM ranked
  ), scheduled AS (
    SELECT body,reference,
      COUNT(*) OVER () - ROW_NUMBER() OVER (ORDER BY
        rank,
        CASE WHEN rank<=1 AND plan_id IS NULL THEN 1 ELSE 0 END,
        -finished,
        priority_key,
        CASE WHEN rank<=1 THEN COALESCE(plan_rowid,0) ELSE 0 END,
        CASE WHEN rank<=1 THEN COALESCE(ordinal,0) ELSE 0 END,
        CASE WHEN rank>=2 OR plan_id IS NULL THEN -task_rowid ELSE task_rowid END
      ) + 1 AS position
    FROM timed
  ) SELECT body,reference,position FROM scheduled
    ${before ? "WHERE position<?" : ""} ORDER BY position DESC LIMIT ?`
}
