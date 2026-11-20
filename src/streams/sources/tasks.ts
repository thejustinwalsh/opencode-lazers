import {
  effectiveTaskStateFilter,
  taskStatePredicate,
  type TaskQueryState,
} from "../../tasks/state-filter.ts"
import { defineSource } from "../source.ts"

/**
 * `tasks.list`: one project's tasks, newest first, with the facts SQL can derive from the task
 * tables and the runner's persisted node, plan and attempt rows. It carries no field that needs
 * main-thread memory or TypeScript derivation (effective status with reservation blockers,
 * concerns, takeover, classification, search matches): those wait for a stored projection.
 *
 * Filters are the index-backed ones only: project (required), task id, the state predicates over
 * `runner_nodes` and `runner_plans`, and retirement. Search text, write-scope path and session id
 * have no index or stored column and are not offered.
 */
export type TasksListFilter = {
  projectDirectory: string
  /** One task by id. */
  taskID?: string
  /** The panel's state filter; omitted reads as the legacy filter, like `Tasks.query`. */
  state?: TaskQueryState
  includeRetired?: boolean
}

const latestNode = (field: string) =>
  `(SELECT ${field} FROM runner_nodes n JOIN runner_plans p ON p.id=n.plan_id
     WHERE n.task_id=t.id AND p.project_directory=t.project_directory ORDER BY p.rowid DESC LIMIT 1)`

export const tasksListSource = defineSource({
  name: "tasks.list",
  // An aliased subquery named `tasks`, so the state predicates (written for `tasks.id`) apply.
  table: `(SELECT t.project_directory AS project_directory, t.id AS id, t.rowid AS position,
      r.reference AS reference,
      json_extract(t.body,'$.proposal.objective') AS objective,
      t.created_at AS createdAt,
      json_extract(t.body,'$.provenance.sessionID') AS sessionID,
      json_extract(t.body,'$.revision') AS revision,
      ${latestNode("n.state")} AS nodeState,
      ${latestNode("n.reason")} AS nodeReason,
      ${latestNode("p.id")} AS planID,
      ${latestNode("p.state")} AS planState,
      (SELECT a.started_at FROM runner_attempts a
        WHERE a.plan_id=${latestNode("p.id")} AND a.task_id=t.id
        ORDER BY a.number DESC, a.started_at DESC LIMIT 1) AS attemptStartedAt,
      (SELECT d.reason FROM task_dispositions d
        WHERE d.project_directory=t.project_directory AND d.task_id=t.id
        ORDER BY d.id DESC LIMIT 1) AS dispositionReason
    FROM tasks t JOIN task_references r
      ON r.project_directory=t.project_directory AND r.task_id=t.id) AS tasks`,
  tables: [
    "tasks",
    "task_references",
    "task_dispositions",
    "runner_nodes",
    "runner_plans",
    "runner_attempts",
    "runner_dispatch_controls",
    "lazers_dispatch_pause",
    "lazers_project_paths",
  ],
  key: ["id"],
  orders: {
    recent: [
      { column: "position", direction: "desc" },
      { column: "id", direction: "asc" },
    ],
  },
  filter(input: TasksListFilter) {
    const clauses = ["tasks.project_directory = ?"]
    const params: (string | number | null)[] = [input.projectDirectory]
    if (input.taskID !== undefined) {
      clauses.push("tasks.id = ?")
      params.push(input.taskID)
    }
    const state = taskStatePredicate(effectiveTaskStateFilter(input.state, undefined), "tasks")
    if (state) clauses.push(state)
    if (input.includeRetired !== true)
      clauses.push(
        "NOT EXISTS (SELECT 1 FROM task_dispositions d WHERE d.project_directory=tasks.project_directory AND d.task_id=tasks.id)",
      )
    return { where: clauses.join(" AND "), params }
  },
  columns: {
    id: "text",
    position: "int",
    reference: "text",
    objective: "text",
    createdAt: "text",
    sessionID: "text",
    revision: "int",
    nodeState: "text",
    nodeReason: "text",
    planID: "text",
    planState: "text",
    attemptStartedAt: "int",
    dispositionReason: "text",
  },
  count: "more",
})
