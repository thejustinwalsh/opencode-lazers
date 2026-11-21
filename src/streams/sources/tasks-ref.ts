import type { Columns } from "../frame.ts"
import { sourceRef, type SourceRef } from "../source.ts"

/**
 * The Tasks sources, the part a consumer without a database needs: names, columns and filters.
 * The GUI imports this file; `tasks.ts` defines the sources from the same columns, so they cannot
 * drift apart.
 */
export const TASK_SOURCES = {
  schedule: "tasks.schedule",
  dependencies: "tasks.dependencies",
  plans: "tasks.plans",
  blockers: "tasks.blockers",
  waits: "tasks.waits",
  bucketCounts: "tasks.bucketCounts",
  sessionBucketCounts: "tasks.sessionBucketCounts",
  index: "tasks.index",
} as const

/** A state chip, or a union of chips; `legacy` is `Tasks.query`'s default. Omitted is every task. */
export type TaskStateFilter =
  | "open"
  | "queued"
  | "running"
  | "blocked"
  | "paused"
  | "completed"
  | "accepted"
  | "integrated"
  | "failed"
  | "cancelled"
  | "all"
  | "legacy"

/** The view a caller reads from. A session view reads the tasks that session is linked to. */
export type TaskScope = { kind: "session" | "project"; sessionID: string }

export type TaskScheduleFilter = {
  /** Set by the service for a stream opened over RPC: whatever the caller sends is replaced. */
  project: string
  /** Required over RPC; ignored by server-side callers, which name `session` directly. */
  scope?: TaskScope
  state?: TaskStateFilter
  /** Explicit union, applied before ordering/windowing; empty means All. */
  states?: readonly Exclude<TaskStateFilter, "all" | "legacy">[]
  /** One task by id. */
  taskID?: string
  /** The tasks of one plan; read them with order `plan`. */
  planID?: string
  includeRetired?: boolean
  /** Tasks the session created, owns a plan of, or ran an attempt of. */
  session?: string
  /** Tasks the session created. */
  creator?: string
  /** Case-insensitive substring of the id, reference, objective, scope, acceptance or context. */
  search?: string
  /** Case-insensitive substring of a write-scope path. */
  scopePath?: string
}

export const taskScheduleColumns = {
  task_id: "text",
  seq: "int",
  sort_key: "text",
  reference: "text",
  title: "text",
  objective: "text",
  status: "text",
  reason: "text",
  node_reason: "text",
  plan_reason: "text",
  node_state: "text",
  plan_state: "text",
  bucket: "text",
  plan_id: "text",
  ordinal: "int",
  priority_key: "int",
  started_at: "int",
  takeover: "bool",
  classification: "json",
  concern: "json",
  /** The totals of the open concern, across every attempt; null with no open concern. */
  concern_totals: "json",
  dispatch_pause: "json",
  dispatch_pause_plan_id: "text",
  dependency_count: "int",
  blocker_count: "int",
  wait_plans_count: "int",
  wait_plan_ids: "json",
  blocker_task_ids: "json",
  dependency_waiting: "bool",
  decision: "text",
  decision_reason: "text",
  disposition: "json",
  retired: "bool",
  /** The last refresh of this row failed: the values are the last good ones. */
  stale: "bool",
  source_plan: "json",
  revision: "int",
  session_id: "text",
  created_at: "text",
} as const satisfies Columns

const taskDependencyColumns = {
  parent_task_id: "text",
  ord: "int",
  child_task_id: "text",
  kind: "text",
  child_reference: "text",
  child_title: "text",
  child_state: "text",
  waiting: "bool",
  child_plan_id: "text",
  parent_reference: "text",
  parent_title: "text",
} as const satisfies Columns

/** The child's own list row, so a nested row renders exactly as a listed one. */
const childOf = <C extends Record<string, string>>(columns: C) =>
  Object.fromEntries(Object.entries(columns).map(([name, type]) => [`c_${name}`, type])) as {
    [K in keyof C & string as `c_${K}`]: C[K]
  }
const taskDependencyChildColumns = childOf({
  status: "text",
  reason: "text",
  node_reason: "text",
  plan_reason: "text",
  node_state: "text",
  plan_state: "text",
  ordinal: "int",
  priority_key: "int",
  started_at: "int",
  takeover: "bool",
  concern: "json",
  dispatch_pause: "json",
  dispatch_pause_plan_id: "text",
  dependency_count: "int",
  wait_plans_count: "int",
  wait_plan_ids: "json",
  blocker_task_ids: "json",
  dependency_waiting: "bool",
  decision: "text",
  decision_reason: "text",
  stale: "bool",
  source_plan: "json",
  session_id: "text",
} as const)

export const taskDependencyRowColumns = {
  ...taskDependencyColumns,
  ...taskDependencyChildColumns,
} as const satisfies Columns

export const taskPlanColumns = {
  plan_id: "text",
  seq: "int",
  title: "text",
  state: "text",
  reason: "text",
  priority: "int",
  priority_key: "int",
  owner_session_id: "text",
  workspace_mode: "text",
  after_plans: "json",
  after_plans_count: "int",
  pause: "json",
  plan_revision: "int",
  node_count: "int",
  open_count: "int",
} as const satisfies Columns

export const taskBlockerColumns = {
  task_id: "text",
  blocker_task_id: "text",
  reference: "text",
  title: "text",
} as const satisfies Columns

export const taskWaitColumns = {
  task_id: "text",
  ord: "int",
  plan_id: "text",
  title: "text",
  state: "text",
  version: "int",
  reason: "text",
} as const satisfies Columns

export const taskBucketCountColumns = {
  project_directory: "text",
  bucket: "text",
  n: "int",
} as const satisfies Columns
export const taskSessionBucketCountColumns = {
  session_id: "text",
  project_directory: "text",
  bucket: "text",
  n: "int",
} as const satisfies Columns
export const taskIndexColumns = {
  project_directory: "text",
  ready: "bool",
} as const satisfies Columns

export type TaskChildFilter = {
  scope?: TaskScope
  /** Set by the service: the project the task belongs to. */
  project?: string
  /** Set by the service in a session view: the session the task is linked to. */
  session?: string
  task?: string
  parent?: string
}
export type TaskPlansFilter = {
  scope?: TaskScope
  project: string
  planID?: string
  /** Several plans by id, as the plans a plan runs after. */
  planIDs?: readonly string[]
  state?: string
  /** Set by the service in a session view: plans with a task linked to the session. */
  session?: string
}
export type TaskCountsFilter = { scope?: TaskScope; project: string; session?: string }
export type TaskIndexFilter = { scope?: TaskScope; project: string }

export const taskScheduleRef: SourceRef<TaskScheduleFilter, typeof taskScheduleColumns> = sourceRef(
  {
    name: TASK_SOURCES.schedule,
    columns: taskScheduleColumns,
  },
)
export const taskDependenciesRef: SourceRef<TaskChildFilter, typeof taskDependencyRowColumns> =
  sourceRef({
    name: TASK_SOURCES.dependencies,
    columns: taskDependencyRowColumns,
  })
export const taskPlansRef: SourceRef<TaskPlansFilter, typeof taskPlanColumns> = sourceRef({
  name: TASK_SOURCES.plans,
  columns: taskPlanColumns,
})
export const taskBlockersRef: SourceRef<TaskChildFilter, typeof taskBlockerColumns> = sourceRef({
  name: TASK_SOURCES.blockers,
  columns: taskBlockerColumns,
})
export const taskWaitsRef: SourceRef<TaskChildFilter, typeof taskWaitColumns> = sourceRef({
  name: TASK_SOURCES.waits,
  columns: taskWaitColumns,
})
export const taskBucketCountsRef: SourceRef<TaskCountsFilter, typeof taskBucketCountColumns> =
  sourceRef({
    name: TASK_SOURCES.bucketCounts,
    columns: taskBucketCountColumns,
  })
export const taskSessionBucketCountsRef: SourceRef<
  TaskCountsFilter,
  typeof taskSessionBucketCountColumns
> = sourceRef({ name: TASK_SOURCES.sessionBucketCounts, columns: taskSessionBucketCountColumns })
export const taskIndexRef: SourceRef<TaskIndexFilter, typeof taskIndexColumns> = sourceRef({
  name: TASK_SOURCES.index,
  columns: taskIndexColumns,
})

export type TaskScheduleRow = { readonly [K in keyof typeof taskScheduleColumns]: unknown }
