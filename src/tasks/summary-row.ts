import type { TaskSummary } from "./contract.ts"
import { taskTitle } from "./presentation.ts"

const optional = <T>(value: unknown): T | undefined =>
  value === null || value === undefined ? undefined : (value as T)

/**
 * A task summary from the stored columns of a `tasks.schedule` row. `matches` is what the caller
 * found in the stored specification, which the row does not carry.
 */
export function summaryOf(
  row: Record<string, unknown>,
  matches: TaskSummary["matches"] = [],
): TaskSummary {
  const taskID = String(row.task_id)
  const reference = String(row.reference)
  const status = String(row.status)
  const nodeState = optional<string>(row.node_state)
  const running = ["running", "verifying"].includes(String(nodeState))
  return {
    taskID,
    reference,
    ...(optional(row.source_plan) ? { sourcePlan: row.source_plan as never } : {}),
    ...(optional(row.dispatch_pause)
      ? {
          dispatchPause: row.dispatch_pause as never,
          ...(row.dispatch_pause_plan_id
            ? { dispatchPausePlanID: String(row.dispatch_pause_plan_id) }
            : {}),
        }
      : {}),
    revision: 1,
    status: status as TaskSummary["status"],
    ...(nodeState ? { recordedState: nodeState as never } : {}),
    ...(running && row.started_at != null ? { startedAt: Number(row.started_at) } : {}),
    ...(row.takeover ? { takeover: true as const } : {}),
    reason: optional<string>(row.reason) ?? null,
    ...(optional(row.disposition) ? { disposition: row.disposition as never } : {}),
    classification: row.classification as never,
    title: String(row.title ?? taskTitle(String(row.objective ?? ""))).slice(0, 120),
    objective: String(row.objective ?? "").slice(0, 400),
    createdAt: String(row.created_at),
    sessionID: String(row.session_id),
    matches,
  }
}
