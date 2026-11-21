import type { SchedulingNode } from "./scheduling-contract.ts"
import type { TaskConcern, TaskSummary } from "./contract.ts"
import type { TaskScheduleRow } from "../streams/sources/tasks-ref.ts"

export type ExecutionListRow = {
  taskID: string
  title: string
  status: string
  reason: string | null
  waiting: boolean
  holdReason: string | null
  ordinal: number
  reference?: string
  /** Epoch ms the running task's current attempt began; absent unless the read supplied it. */
  startedAt?: number
  /** Present when the task's recorded effort trips a concern rule; totals come with the detail. */
  concern?: Omit<TaskConcern, "totals"> & {
    totals?: TaskConcern["totals"]
    /** The rule's recommended action and why (`concernRecommendation`), when it recorded one. */
    recommendation?: string
  }
  /** The latest attempt is the Architect finishing the task itself. */
  takeover?: true
  sourcePlan?: TaskSummary["sourcePlan"]
  dispatchPause?: TaskSummary["dispatchPause"]
  dispatchPausePlanID?: string
  /** Stored dependencies the row can expand into; a listed row needs no other source for this. */
  dependencyCount?: number
  /** The row's last refresh failed: its values are the last good ones. */
  stale?: true
  contextOnly: boolean
  prerequisites: string[]
  successors: string[]
  dependencyTasks?: Array<{
    taskID: string
    reference?: string
    title: string
    state: string
    waiting: boolean
  }>
  scheduling?: {
    decision: SchedulingNode["decision"]
    reason: string | null
    waitingOn: string[]
    waitingOnPlans?: string[]
    waitingOnPlansCount?: number
    waitingOnPlansComplete?: boolean
    reservationTaskIDs: string[]
    reservationTaskCount?: number
    reservationTaskIDsComplete?: boolean
    reservationTaskIDsScopeLimited?: boolean
  }
}

const TERMINAL = new Set(["accepted", "incorporated", "failed", "exhausted", "cancelled"])
const PAUSABLE = new Set(["queued", "ready"])
/** `priority_key` of a plan without a priority (`MAX_PRIORITY + 1`). */
const NO_PRIORITY_KEY = 2147483648

const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])

/**
 * One list row from the stored columns of a `tasks.schedule` row (or the `c_`-prefixed child
 * columns of a `tasks.dependencies` row). It applies the rules the merged model applied to a
 * topology node and a task summary (the former merged model), now over stored
 * columns: the displayed status is the recorded node state, and `waiting` is the held-back test.
 */
export function listRowOf(
  read: (column: string) => unknown,
  taskID: string,
  prefix = "",
): ExecutionListRow {
  const f = (column: string) => read(`${prefix}${column}`)
  const nodeState = (f("node_state") as string | null) ?? null
  const planState = (f("plan_state") as string | null) ?? null
  const effective = String(f("status") ?? "")
  const pause = (f("dispatch_pause") as ExecutionListRow["dispatchPause"] | null) ?? undefined
  const status = nodeState ?? effective
  const dependencyWaiting = Boolean(f("dependency_waiting"))
  const waiting =
    nodeState !== null &&
    planState !== "cancelled" &&
    !TERMINAL.has(nodeState) &&
    (nodeState === "blocked" ||
      effective === "blocked" ||
      planState === "blocked" ||
      (!pause && PAUSABLE.has(nodeState) && dependencyWaiting))
  const nodeReason = (f("node_reason") as string | null) ?? null
  const planReason = (f("plan_reason") as string | null) ?? null
  const reason = (f("reason") as string | null) ?? null
  const stored = f("concern") as { line: string; reasons: string[] } | null
  const recommendation = concernRecommendation(f("concern_action"), f("concern_because"))
  const concern = stored ? { ...stored, ...(recommendation ? { recommendation } : {}) } : null
  const decision = String(f("decision") ?? "not-applicable") as SchedulingNode["decision"]
  const waitPlans = list<string>(f("wait_plan_ids"))
  const startedAt = f("started_at")
  const sourcePlan = f("source_plan") as ExecutionListRow["sourcePlan"] | null
  const dependencyCount = Number(f("dependency_count") ?? 0)
  return {
    taskID,
    title: String(f("objective") ?? ""),
    status,
    reason: waiting ? (nodeReason ?? planReason ?? reason) : (nodeReason ?? reason),
    waiting,
    holdReason: waiting ? (planReason ?? nodeReason ?? reason) : null,
    ordinal: Number(f("ordinal") ?? 0),
    ...(read(prefix ? "child_reference" : "reference")
      ? { reference: String(read(prefix ? "child_reference" : "reference")) }
      : {}),
    ...(startedAt != null ? { startedAt: Number(startedAt) } : {}),
    ...(concern ? { concern } : {}),
    ...(f("takeover") ? { takeover: true as const } : {}),
    ...(sourcePlan ? { sourcePlan } : {}),
    ...(pause && nodeState !== null && PAUSABLE.has(nodeState) ? { dispatchPause: pause } : {}),
    ...(pause && f("dispatch_pause_plan_id")
      ? { dispatchPausePlanID: String(f("dispatch_pause_plan_id")) }
      : {}),
    dependencyCount,
    ...(f("stale") ? { stale: true as const } : {}),
    contextOnly: false,
    prerequisites: [],
    successors: [],
    scheduling: {
      decision,
      reason: (f("decision_reason") as string | null) ?? null,
      // Every task the row waits behind, so the presentation lists them as before.
      waitingOn: list<string>(f("blocker_task_ids")),
      waitingOnPlans: waitPlans,
      waitingOnPlansCount: Number(f("wait_plans_count") ?? waitPlans.length),
      reservationTaskIDs: [],
    },
  }
}

/** The row of a dependency edge: the child's own list row, or what the edge records of it. */
export function childRowOf(read: (column: string) => unknown): ExecutionListRow {
  const taskID = String(read("child_task_id"))
  if (read("c_status") == null)
    return {
      taskID,
      title: String(read("child_title") ?? `Task ${taskID.slice(0, 8)}`),
      status: String(read("child_state") ?? ""),
      reason: null,
      waiting: false,
      holdReason: null,
      ordinal: 0,
      ...(read("child_reference") ? { reference: String(read("child_reference")) } : {}),
      contextOnly: true,
      prerequisites: [],
      successors: [],
    }
  const row = listRowOf(read, taskID, "c_")
  return { ...row, title: String(read("child_title") ?? row.title), contextOnly: true }
}

export const priorityOfRow = (row: Pick<TaskScheduleRow, "priority_key">) =>
  typeof row.priority_key === "number" && row.priority_key < NO_PRIORITY_KEY
    ? row.priority_key
    : undefined
export type { TaskSummary }

/**
 * The open concern's recommended action as the worker pane and the Tasks row word it, from the
 * stored `task_schedule.concern_action` and `concern_because`; undefined when none was recorded.
 */
export function concernRecommendation(action: unknown, because: unknown): string | undefined {
  if (typeof action !== "string" || !action) return undefined
  return `Recommended: ${action}${typeof because === "string" && because ? `. ${because}` : ""}`
}
