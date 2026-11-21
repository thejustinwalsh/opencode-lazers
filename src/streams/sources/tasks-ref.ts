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
  detail: "tasks.detail",
  attempts: "tasks.attempts",
  activity: "tasks.activity",
  activityPayloads: "tasks.activityPayloads",
  attemptCalls: "tasks.attemptCalls",
  currentActivity: "tasks.currentActivity",
  searchFields: "tasks.searchFields",
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
  /** The open concern's recommended action (`acknowledge`, `steer`, `takeover`, `cancel`), when its rule recorded one. */
  concern_action: "text",
  /** Why the rule recommends `concern_action` (at most 600 characters). */
  concern_because: "text",
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

/**
 * One task's detail (`tasks.detail`, always read at window 1). A filter names the task by id or
 * by `<CODE>-<n>` reference; `creator` keeps only a task the session created (the agent tool's
 * `sessionID`), `session` a task linked to it (the panel's session view).
 */
export type TaskDetailFilter = {
  scope?: TaskScope
  project?: string
  task?: string
  reference?: string
  creator?: string
  session?: string
}
export const taskDetailColumns = {
  task_id: "text",
  reference: "text",
  revision: "int",
  status: "text",
  /** The node's own state in the task's current plan; null when unplanned. */
  node_state: "text",
  plan_id: "text",
  session_id: "text",
  retired: "bool",
} as const satisfies Columns
export const taskDetailColdColumns = {
  /** The task specification as submitted (`tasks.body`). */
  body: "json",
  /** The execution the detail shows; null when unplanned. */
  execution: "json",
  classification: "json",
  classification_history: "json",
  advice: "json",
  audit_history: "json",
  disposition: "json",
  /** The current plan's owner: the Architect session. */
  architect_session_id: "text",
} as const satisfies Columns

/** The attempts of a task in one plan, oldest first, as the detail lists them. */
export type TaskAttemptsFilter = TaskChildFilter & { plan?: string }
export const taskAttemptColumns = {
  id: "text",
  number: "int",
  state: "text",
  started_at: "int",
  artifact: "text",
  token_count: "float",
  tool_count: "int",
  session_id: "text",
  /** The attempt is the Architect finishing the task (its policy names a takeover). */
  takeover: "bool",
  /** The recorded `policy.model` object, unvalidated; the consumer checks its shape. */
  model: "json",
} as const satisfies Columns

/** A task's transitions in one plan, by transition id; `events` narrows to those names. */
export type TaskActivityFilter = TaskChildFilter & { plan?: string; events?: readonly string[] }
export const taskActivityColumns = {
  /** The `runner_transitions` id: the order and the key. */
  transition_id: "int",
  task_id: "text",
  event: "text",
  at: "float",
} as const satisfies Columns
/** The raw transition payload: cold on `tasks.activity`, a list column on `tasks.activityPayloads`. */
export const taskActivityPayloadColumns = { payload: "text" } as const satisfies Columns

/** One attempt's progress rows (`runner_progress_display`), for the latest attempt's summary. */
export type TaskAttemptCallsFilter = TaskChildFilter & {
  attempt?: string
  sessionID?: string
  /** Only tool calls (`kind = 'tool'` with a call id): the summary's ticks. */
  toolsOnly?: boolean
}
export const taskAttemptCallColumns = {
  seq: "int",
  at: "float",
  status: "text",
  file_targets_json: "json",
} as const satisfies Columns

/**
 * What a row's current activity shows: the task's node and latest attempt, joined to the attempt
 * session's stored host facts (`host_session_state`). `tasks` names the rows in view.
 */
export type TaskCurrentActivityFilter = {
  scope?: TaskScope
  project?: string
  session?: string
  tasks: readonly string[]
}
export const taskCurrentActivityColumns = {
  task_id: "text",
  node_state: "text",
  plan_state: "text",
  node_reason: "text",
  plan_reason: "text",
  attempt_id: "text",
  attempt_session_id: "text",
  attempt_workspace: "text",
  /** Null when the host fold holds no row for the attempt session. */
  host_agent: "text",
  host_attempt_id: "text",
  host_directory: "text",
  busy: "bool",
  pending_input: "bool",
  pending_permissions: "int",
  pending_forms: "int",
  outcome: "text",
  archived: "bool",
  /** When the fold last changed a shown host column. */
  observed_at: "int",
} as const satisfies Columns

/** The six fields a search matches, as written, for the tasks of one page. */
export type TaskSearchFieldsFilter = { project?: string; tasks: readonly string[] }
export const taskSearchFieldColumns = {
  task_id: "text",
  ord: "int",
  field: "text",
  text: "text",
} as const satisfies Columns

export const taskDetailRef: SourceRef<TaskDetailFilter, typeof taskDetailColumns> = sourceRef({
  name: TASK_SOURCES.detail,
  columns: taskDetailColumns,
  detail: taskDetailColdColumns,
})
export const taskAttemptsRef: SourceRef<TaskAttemptsFilter, typeof taskAttemptColumns> = sourceRef({
  name: TASK_SOURCES.attempts,
  columns: taskAttemptColumns,
})
export const taskActivityRef: SourceRef<TaskActivityFilter, typeof taskActivityColumns> = sourceRef(
  {
    name: TASK_SOURCES.activity,
    columns: taskActivityColumns,
    detail: taskActivityPayloadColumns,
  },
)
export const taskActivityPayloadsRef: SourceRef<
  TaskActivityFilter,
  typeof taskActivityColumns & typeof taskActivityPayloadColumns
> = sourceRef({
  name: TASK_SOURCES.activityPayloads,
  columns: { ...taskActivityColumns, ...taskActivityPayloadColumns },
})
export const taskAttemptCallsRef: SourceRef<TaskAttemptCallsFilter, typeof taskAttemptCallColumns> =
  sourceRef({ name: TASK_SOURCES.attemptCalls, columns: taskAttemptCallColumns })
export const taskCurrentActivityRef: SourceRef<
  TaskCurrentActivityFilter,
  typeof taskCurrentActivityColumns
> = sourceRef({ name: TASK_SOURCES.currentActivity, columns: taskCurrentActivityColumns })

export const taskSearchFieldsRef: SourceRef<TaskSearchFieldsFilter, typeof taskSearchFieldColumns> =
  sourceRef({ name: TASK_SOURCES.searchFields, columns: taskSearchFieldColumns })

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
