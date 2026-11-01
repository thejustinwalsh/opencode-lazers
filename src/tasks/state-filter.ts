import { z } from "zod"

export const TaskStateFilter = z.enum(["open", "completed", "failed", "cancelled", "all"])
export type TaskStateFilter = z.infer<typeof TaskStateFilter>
export type TaskQueryState = TaskStateFilter | "legacy"

/** Keep the pre-filter query contract distinct from the new explicit `open` filter. */
export function effectiveTaskStateFilter(
  state: TaskQueryState | undefined,
  includeCompleted: boolean | undefined,
): TaskQueryState {
  return state ?? (includeCompleted ? "all" : "legacy")
}

/** Old Tasks preferences had only a history toggle; true meant include every execution state. */
export function preferredTaskStateFilter(
  state: TaskStateFilter | undefined,
  history: boolean | undefined,
): TaskStateFilter {
  return state ?? (history ? "all" : "open")
}

/** SQL predicate for a correlated `tasks` (or `t`) row; plan-level terminal states are effective. */
export function taskStatePredicate(state: TaskQueryState, taskAlias: "tasks" | "t"): string {
  if (state === "all") return ""
  if (state === "legacy")
    return `NOT EXISTS (
      SELECT 1 FROM runner_nodes n
      WHERE n.task_id=${taskAlias}.id AND n.state IN ('accepted','incorporated','cancelled')
    ) AND NOT EXISTS (
      SELECT 1 FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id
      WHERE n.task_id=${taskAlias}.id
        AND p.project_directory=${taskAlias}.project_directory AND p.state='cancelled'
    )`
  const effective = `CASE
    WHEN p.state='cancelled' OR n.state='cancelled' THEN 'cancelled'
    WHEN p.state='blocked' AND n.state IN ('queued','ready') THEN 'blocked'
    ELSE n.state
  END`
  const matchingExecution = (predicate: string) => `EXISTS (
    SELECT 1 FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id
    WHERE n.task_id=${taskAlias}.id AND p.project_directory=${taskAlias}.project_directory
      AND (${predicate})
  )`
  if (state === "completed") return matchingExecution(`${effective} IN ('accepted','incorporated')`)
  if (state === "failed") return matchingExecution(`${effective} IN ('failed','exhausted')`)
  if (state === "cancelled") return matchingExecution(`${effective}='cancelled'`)
  return `NOT ${matchingExecution(`${effective} IN ('accepted','incorporated','failed','exhausted','cancelled')`)}`
}
