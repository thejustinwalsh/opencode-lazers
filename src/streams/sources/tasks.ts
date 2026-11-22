import { bucketsForSelection } from "../../tasks/schedule/key.ts"
import type { Bucket } from "../../tasks/schedule/schema.ts"
import { defineSource, type StreamContext } from "../source.ts"
import {
  TASK_SOURCES,
  taskActivityColumns,
  taskActivityPayloadColumns,
  taskAttemptCallColumns,
  taskAttemptColumns,
  taskCurrentActivityColumns,
  taskDetailColdColumns,
  taskDetailColumns,
  taskSearchFieldColumns,
  taskBlockerColumns,
  taskBucketCountColumns,
  taskDependencyRowColumns,
  taskIndexColumns,
  taskPlanColumns,
  taskScheduleColumns,
  taskSessionBucketCountColumns,
  taskWaitColumns,
  type TaskActivityFilter,
  type TaskAttemptCallsFilter,
  type TaskAttemptsFilter,
  type TaskChildFilter,
  type TaskCurrentActivityFilter,
  type TaskDetailFilter,
  type TaskSearchFieldsFilter,
  type TaskCountsFilter,
  type TaskIndexFilter,
  type TaskPlansFilter,
  type TaskScheduleFilter,
  type TaskScope,
} from "./tasks-ref.ts"

/**
 * The Tasks panel's sources, over the stored projection (`design/task-schedule-projection.md`).
 * Every column a source reads is a column of a projection table, kept current in the writing
 * transaction; nothing here derives a field, reads a task body or needs main-thread memory.
 *
 * Scope checks. The reads these replace checked, on the main thread:
 * - `Tasks.query` (`src/tasks/rpc.ts:96-111`): the project is the service's own directory; a
 *   session view lists the tasks linked to the calling session (creator, plan owner, attempt
 *   session: `AssociationTaskReads.query`, `src/observability/task-reads.ts:78-125`); a project
 *   view lists every task of the project.
 * - `Tasks.get` and the topology read (`src/observability/rpc.ts:151`, `src/tasks/read.ts:296`):
 *   in a session view, only a task linked to the session.
 * - `TasksScheduling.read` (`src/tasks/rpc.ts:345-395`): the calling session exists, belongs to
 *   this OpenCode project, is not archived, has an agent, and its agent may read the project
 *   (`ctx.permission.assert`).
 * Each source's `authorize` makes the session and permission check through `context.assertRead`
 * (the same `authorizeRead` the observability reads use), overwrites the project with the
 * service's directory, and forces the session link in a session view.
 */

async function scopeOf(filter: { scope?: TaskScope }, context: StreamContext): Promise<TaskScope> {
  const scope = filter.scope
  if (!scope || (scope.kind !== "session" && scope.kind !== "project") || !scope.sessionID)
    throw new Error("A tasks read names its scope")
  await context.assertRead(scope.sessionID)
  return scope
}

/**
 * The scope check of a read about one task, as part of its filter: the task belongs to this
 * project and, in a session view, is linked to the session. A task outside the scope lists nothing,
 * and `authorize` reads no row.
 */
function taskInScope(column: string, input: { project?: string; session?: string }) {
  const linked =
    input.session !== undefined
      ? " AND EXISTS (SELECT 1 FROM task_schedule_sessions s WHERE s.task_id=t.task_id AND s.session_id=?)"
      : ""
  return {
    clause: `EXISTS (SELECT 1 FROM task_schedule t WHERE t.task_id=${column} AND t.project_directory=?${linked})`,
    params: [input.project ?? null, ...(input.session !== undefined ? [input.session] : [])],
  }
}

/** The caller's scope is checked; the project is the service's, and a session view is forced. */
async function scopedChild(
  input: TaskChildFilter,
  context: StreamContext,
  named: string | undefined,
) {
  const scope = await scopeOf(input, context)
  if (!named) throw new Error("A tasks read names its task")
  const { session: _caller, ...rest } = input as TaskChildFilter & { session?: string }
  return {
    ...rest,
    project: context.projectDirectory,
    ...(scope.kind === "session" ? { session: scope.sessionID } : {}),
  }
}

const placeholders = (values: readonly unknown[]) => values.map(() => "?").join(",")

export const taskScheduleSource = defineSource({
  name: TASK_SOURCES.schedule,
  table: "task_schedule",
  tables: ["task_schedule", "task_schedule_sessions", "task_schedule_scopes"],
  key: ["task_id"],
  orders: {
    // The old `sort: "schedule"`: one stored key holds all seven terms.
    schedule: [
      { column: "sort_key", direction: "asc" },
      { column: "task_id", direction: "asc" },
    ],
    // The tasks of one plan, in plan order (the first step first).
    plan: [
      { column: "ordinal", direction: "asc" },
      { column: "task_id", direction: "asc" },
    ],
    // The old `sort: "recent"`: newest first.
    recent: [
      { column: "seq", direction: "desc" },
      { column: "task_id", direction: "asc" },
    ],
  },
  async authorize(input: TaskScheduleFilter, context) {
    const scope = await scopeOf(input, context)
    const { session: _caller, ...rest } = input
    return {
      ...rest,
      project: context.projectDirectory,
      ...(scope.kind === "session" ? { session: scope.sessionID } : {}),
    }
  },
  filter(input: TaskScheduleFilter) {
    const clauses = ["task_schedule.project_directory = ?"]
    const params: (string | number | null)[] = [input.project]
    if (input.taskID !== undefined) {
      clauses.push("task_schedule.task_id = ?")
      params.push(input.taskID)
    }
    if (input.planID !== undefined) {
      clauses.push("task_schedule.plan_id = ?")
      params.push(input.planID)
    }
    if (input.includeRetired !== true) clauses.push("task_schedule.retired = 0")
    const buckets: readonly Bucket[] | undefined = bucketsForSelection(input.states, input.state)
    if (buckets) {
      clauses.push(`task_schedule.bucket IN (${placeholders(buckets)})`)
      params.push(...buckets)
    }
    if (input.creator !== undefined) {
      clauses.push("task_schedule.session_id = ?")
      params.push(input.creator)
    }
    if (input.session !== undefined) {
      clauses.push(
        "EXISTS (SELECT 1 FROM task_schedule_sessions s WHERE s.task_id=task_schedule.task_id AND s.session_id=?)",
      )
      params.push(input.session)
    }
    if (input.search) {
      clauses.push("instr(task_schedule.search_text, ?) > 0")
      params.push(input.search.toLowerCase())
    }
    if (input.scopePath) {
      clauses.push(
        "EXISTS (SELECT 1 FROM task_schedule_scopes c WHERE c.task_id=task_schedule.task_id AND instr(lower(c.path), ?) > 0)",
      )
      params.push(input.scopePath.toLowerCase())
    }
    return { where: clauses.join(" AND "), params }
  },
  columns: taskScheduleColumns,
})

/** The dependency children of one task, in the order the list shows them. */
export const taskDependenciesSource = defineSource({
  name: TASK_SOURCES.dependencies,
  table: `(SELECT e.parent_task_id AS parent_task_id, e.ord AS ord, e.child_task_id AS child_task_id,
      e.kind AS kind, e.child_reference AS child_reference, e.child_title AS child_title,
      e.child_state AS child_state, e.waiting AS waiting, e.child_plan_id AS child_plan_id,
      p.reference AS parent_reference, p.title AS parent_title,
      c.status AS c_status, c.reason AS c_reason, c.node_reason AS c_node_reason,
      c.plan_reason AS c_plan_reason, c.node_state AS c_node_state, c.plan_state AS c_plan_state,
      c.ordinal AS c_ordinal, c.priority_key AS c_priority_key, c.started_at AS c_started_at,
      c.takeover AS c_takeover, c.concern AS c_concern, c.dispatch_pause AS c_dispatch_pause,
      c.dispatch_pause_plan_id AS c_dispatch_pause_plan_id, c.dependency_count AS c_dependency_count,
      c.wait_plans_count AS c_wait_plans_count, c.wait_plan_ids AS c_wait_plan_ids,
      c.blocker_task_ids AS c_blocker_task_ids, c.dependency_waiting AS c_dependency_waiting,
      c.decision AS c_decision, c.decision_reason AS c_decision_reason, c.stale AS c_stale,
      c.source_plan AS c_source_plan, c.session_id AS c_session_id
    FROM task_schedule_edges e LEFT JOIN task_schedule c ON c.task_id=e.child_task_id
      LEFT JOIN task_schedule p ON p.task_id=e.parent_task_id) AS task_schedule_edges`,
  tables: ["task_schedule_edges", "task_schedule"],
  key: ["parent_task_id", "ord"],
  orders: {
    ord: [
      { column: "parent_task_id", direction: "asc" },
      { column: "ord", direction: "asc" },
    ],
  },
  authorize: (input: TaskChildFilter, context) =>
    scopedChild(input, context, input.parent ?? input.task),
  // `parent` lists a task's dependencies; `task` lists the tasks that depend on it.
  filter(input: TaskChildFilter) {
    const column =
      input.parent !== undefined
        ? "task_schedule_edges.parent_task_id"
        : "task_schedule_edges.child_task_id"
    const scoped = taskInScope(column, input)
    return {
      where: `${column} = ? AND ${scoped.clause}`,
      params: [(input.parent ?? input.task)!, ...scoped.params],
    }
  },
  columns: taskDependencyRowColumns,
})

/** Plans in scheduler order: priority (1 first, none last), then plan creation order. */
export const taskPlansSource = defineSource({
  name: TASK_SOURCES.plans,
  table: "task_schedule_plans",
  tables: ["task_schedule_plans", "task_schedule", "task_schedule_sessions"],
  key: ["plan_id"],
  orders: {
    schedule: [
      { column: "priority_key", direction: "asc" },
      { column: "seq", direction: "asc" },
      { column: "plan_id", direction: "asc" },
    ],
  },
  async authorize(input: TaskPlansFilter, context) {
    const scope = await scopeOf(input, context)
    const { session: _caller, ...rest } = input
    return {
      ...rest,
      project: context.projectDirectory,
      ...(scope.kind === "session" ? { session: scope.sessionID } : {}),
    }
  },
  filter(input: TaskPlansFilter) {
    const clauses = ["task_schedule_plans.project_directory = ?"]
    const params: (string | number | null)[] = [input.project]
    if (input.planID !== undefined) {
      clauses.push("task_schedule_plans.plan_id = ?")
      params.push(input.planID)
    }
    if (input.planIDs !== undefined) {
      clauses.push(`task_schedule_plans.plan_id IN (${placeholders(input.planIDs)})`)
      params.push(...input.planIDs)
    }
    if (input.state !== undefined) {
      clauses.push("task_schedule_plans.state = ?")
      params.push(input.state)
    }
    if (input.session !== undefined) {
      clauses.push(
        `(task_schedule_plans.owner_session_id = ? OR EXISTS (
           SELECT 1 FROM task_schedule t JOIN task_schedule_sessions s ON s.task_id=t.task_id
           WHERE t.plan_id=task_schedule_plans.plan_id AND s.session_id=?))`,
      )
      params.push(input.session, input.session)
    }
    return { where: clauses.join(" AND "), params }
  },
  columns: taskPlanColumns,
})

/** The reservations holding one queued task back, with the blocker's reference. */
defineSource({
  name: TASK_SOURCES.blockers,
  table: `(SELECT b.task_id AS task_id, b.blocker_task_id AS blocker_task_id,
      t.reference AS reference, t.title AS title
    FROM task_schedule_blockers b LEFT JOIN task_schedule t ON t.task_id=b.blocker_task_id) AS task_schedule_blockers`,
  tables: ["task_schedule_blockers", "task_schedule"],
  key: ["task_id", "blocker_task_id"],
  orders: {
    blocker: [
      { column: "task_id", direction: "asc" },
      { column: "blocker_task_id", direction: "asc" },
    ],
  },
  authorize: (input: TaskChildFilter, context) => scopedChild(input, context, input.task),
  filter(input: TaskChildFilter) {
    const scoped = taskInScope("task_schedule_blockers.task_id", input)
    return {
      where: `task_schedule_blockers.task_id = ? AND ${scoped.clause}`,
      params: [input.task!, ...scoped.params],
    }
  },
  columns: taskBlockerColumns,
})

/** The prerequisite plans one task still waits on. */
export const taskWaitsSource = defineSource({
  name: TASK_SOURCES.waits,
  table: "task_schedule_waits",
  key: ["task_id", "ord"],
  orders: {
    ord: [
      { column: "task_id", direction: "asc" },
      { column: "ord", direction: "asc" },
    ],
  },
  authorize: (input: TaskChildFilter, context) => scopedChild(input, context, input.task),
  filter(input: TaskChildFilter) {
    const scoped = taskInScope("task_schedule_waits.task_id", input)
    return {
      where: `task_schedule_waits.task_id = ? AND ${scoped.clause}`,
      params: [input.task!, ...scoped.params],
    }
  },
  columns: taskWaitColumns,
})

/** Chip counts: one stored counter per bucket of a project (retired tasks excluded). */
export const taskBucketCountsSource = defineSource({
  name: TASK_SOURCES.bucketCounts,
  table: "task_schedule_counts",
  key: ["project_directory", "bucket"],
  orders: {
    bucket: [
      { column: "project_directory", direction: "asc" },
      { column: "bucket", direction: "asc" },
    ],
  },
  async authorize(input: TaskCountsFilter, context) {
    const scope = await scopeOf(input, context)
    if (scope.kind !== "project") throw new Error("Session views read the session counts")
    return { ...input, project: context.projectDirectory }
  },
  filter: (input: TaskCountsFilter) => ({
    where: "project_directory = ?",
    params: [input.project],
  }),
  columns: taskBucketCountColumns,
})

/** Chip counts for the tasks one session created, owns a plan of, or ran an attempt of. */
export const taskSessionBucketCountsSource = defineSource({
  name: TASK_SOURCES.sessionBucketCounts,
  table: "task_schedule_session_bucket_counts",
  tables: ["task_schedule_sessions", "task_schedule"],
  key: ["session_id", "project_directory", "bucket"],
  orders: {
    bucket: [
      { column: "session_id", direction: "asc" },
      { column: "project_directory", direction: "asc" },
      { column: "bucket", direction: "asc" },
    ],
  },
  async authorize(input: TaskCountsFilter, context) {
    const scope = await scopeOf(input, context)
    if (scope.kind !== "session") throw new Error("Project views read the project counts")
    return { ...input, project: context.projectDirectory, session: scope.sessionID }
  },
  filter: (input: TaskCountsFilter) => ({
    where: "project_directory = ? AND session_id = ?",
    params: [input.project, input.session!],
  }),
  columns: taskSessionBucketCountColumns,
})

/** Whether this project's list is indexed yet; false while the owner backfills. */
defineSource({
  name: TASK_SOURCES.index,
  table: "task_schedule_state",
  key: ["project_directory"],
  orders: { project: [{ column: "project_directory", direction: "asc" }] },
  async authorize(input: TaskIndexFilter, context) {
    await scopeOf(input, context)
    return { ...input, project: context.projectDirectory }
  },
  filter: (input: TaskIndexFilter) => ({
    where: "project_directory = ?",
    params: [input.project],
  }),
  columns: taskIndexColumns,
})

/** A session view forces the session link; the project is always the service's. */
async function scopedTo<T extends { scope?: TaskScope; session?: string; project?: string }>(
  input: T,
  context: StreamContext,
): Promise<T> {
  const scope = await scopeOf(input, context)
  const { session: _caller, ...rest } = input
  return {
    ...rest,
    project: context.projectDirectory,
    ...(scope.kind === "session" ? { session: scope.sessionID } : {}),
  } as T
}

/**
 * One task's detail at window 1: the stored row, the task body and the plan's owner. Replaces
 * `Tasks.get` (`TaskReads.get`, `AssociationTaskReads`): a reference resolves in this project,
 * `creator` is the old `sessionID` check of the agent tool, `session` the panel's link check.
 */
defineSource({
  name: TASK_SOURCES.detail,
  table: `(SELECT t.task_id AS task_id, t.project_directory AS project_directory,
      t.reference AS reference, t.revision AS revision, t.status AS status,
      t.node_state AS node_state, t.plan_id AS plan_id, t.session_id AS session_id,
      t.retired AS retired, t.execution AS execution, t.classification AS classification,
      t.classification_history AS classification_history, t.advice AS advice,
      t.audit_history AS audit_history, t.disposition AS disposition,
      p.owner_session_id AS architect_session_id, b.body AS body
    FROM task_schedule t JOIN tasks b ON b.id=t.task_id
      LEFT JOIN task_schedule_plans p ON p.plan_id=t.plan_id) AS task_detail`,
  tables: ["task_schedule", "tasks", "task_schedule_plans", "task_schedule_sessions"],
  key: ["task_id"],
  orders: { task: [{ column: "task_id", direction: "asc" }] },
  authorize: (input: TaskDetailFilter, context) => scopedTo(input, context),
  filter(input: TaskDetailFilter) {
    const clauses = ["task_detail.project_directory = ?"]
    const params: (string | number | null)[] = [input.project ?? null]
    if (input.task === undefined && input.reference === undefined)
      throw new Error("A task detail read names its task")
    if (input.task !== undefined) {
      clauses.push("task_detail.task_id = ?")
      params.push(input.task)
    }
    if (input.reference !== undefined) {
      clauses.push("task_detail.reference = ?")
      params.push(input.reference.trim().toUpperCase())
    }
    if (input.creator !== undefined) {
      clauses.push("task_detail.session_id = ?")
      params.push(input.creator)
    }
    if (input.session !== undefined) {
      clauses.push(
        "EXISTS (SELECT 1 FROM task_schedule_sessions s WHERE s.task_id=task_detail.task_id AND s.session_id=?)",
      )
      params.push(input.session)
    }
    return { where: clauses.join(" AND "), params }
  },
  columns: taskDetailColumns,
  detail: taskDetailColdColumns,
})

/** The attempts of a task in its plan, oldest first (`RunnerStore.attempts` order). */
defineSource({
  name: TASK_SOURCES.attempts,
  table: `(SELECT a.id AS id, a.plan_id AS plan_id, a.task_id AS task_id, a.number AS number,
      a.state AS state, a.started_at AS started_at, a.artifact AS artifact,
      a.token_count AS token_count, a.tool_count AS tool_count, a.session_id AS session_id,
      CASE WHEN json_valid(a.policy) THEN json_extract(a.policy,'$.takeover') IS NOT NULL ELSE 0 END AS takeover,
      CASE WHEN json_valid(a.policy) AND json_type(a.policy,'$.model')='object'
        THEN json_extract(a.policy,'$.model') END AS model
    FROM runner_attempts a) AS task_attempts`,
  tables: ["runner_attempts", "task_schedule", "task_schedule_sessions"],
  key: ["id"],
  orders: {
    started: [
      { column: "started_at", direction: "asc" },
      { column: "number", direction: "asc" },
      { column: "id", direction: "asc" },
    ],
  },
  authorize: (input: TaskAttemptsFilter, context) => scopedChild(input, context, input.task),
  filter(input: TaskAttemptsFilter) {
    const scoped = taskInScope("task_attempts.task_id", input)
    return {
      where: `task_attempts.task_id = ? AND task_attempts.plan_id = ? AND ${scoped.clause}`,
      params: [input.task!, input.plan ?? null, ...scoped.params],
    }
  },
  columns: taskAttemptColumns,
  count: { exact: "scan" },
})

const activityTable = `(SELECT e.id AS id, e.project_directory AS project_directory,
    e.task_id AS task_id, e.plan_id AS plan_id, e.event AS event, e.at AS at,
    CAST(substr(e.origin,4) AS INTEGER) AS transition_id, e.payload AS payload
  FROM task_events e WHERE e.kind='transition') AS task_activity`

function activityFilter(input: TaskActivityFilter) {
  const scoped = taskInScope("task_activity.task_id", input)
  // `+plan_id`: the task's own index (`task_events_task`) bounds the read to its rows; the plan
  // index would read every event of the plan.
  const clauses = [
    "task_activity.project_directory = ?",
    "task_activity.task_id = ?",
    "+task_activity.plan_id = ?",
    scoped.clause,
  ]
  const params: (string | number | null)[] = [
    input.project ?? null,
    input.task!,
    input.plan ?? null,
    ...scoped.params,
  ]
  if (input.events) {
    clauses.push(`task_activity.event IN (${placeholders(input.events)})`)
    params.push(...input.events)
  }
  return { where: clauses.join(" AND "), params }
}
const activityOrders = {
  transition: [{ column: "transition_id", direction: "asc" }],
} as const

/**
 * A task's transitions in its plan, by transition id (`RunnerStore.activity`), from `task_events`;
 * the raw payload is cold: the History view reads it at window 1 when a row opens.
 */
defineSource({
  name: TASK_SOURCES.activity,
  table: activityTable,
  tables: ["task_events", "task_schedule", "task_schedule_sessions"],
  key: ["transition_id"],
  orders: activityOrders,
  authorize: (input: TaskActivityFilter, context) => scopedChild(input, context, input.task),
  filter: activityFilter,
  columns: taskActivityColumns,
  detail: taskActivityPayloadColumns,
  count: { exact: "scan" },
})

/** The same rows with the payload on every row: the agent tool's activity and the scope review. */
defineSource({
  name: TASK_SOURCES.activityPayloads,
  table: activityTable,
  tables: ["task_events", "task_schedule", "task_schedule_sessions"],
  key: ["transition_id"],
  orders: activityOrders,
  authorize: (input: TaskActivityFilter, context) => scopedChild(input, context, input.task),
  filter: activityFilter,
  columns: { ...taskActivityColumns, ...taskActivityPayloadColumns },
})

/**
 * One attempt's progress display rows: the latest attempt's last activity and its tool calls
 * (`readAttemptSummary`, which read `runner_progress`), through
 * `runner_progress_display_attempt (project_directory, attempt_id, session_id, seq, ...)`.
 */
defineSource({
  name: TASK_SOURCES.attemptCalls,
  table: "runner_progress_display",
  tables: ["runner_progress_display", "runner_attempts", "task_schedule", "task_schedule_sessions"],
  key: ["seq"],
  orders: {
    calls: [{ column: "seq", direction: "asc" }],
    recent: [{ column: "seq", direction: "desc" }],
  },
  authorize: (input: TaskAttemptCallsFilter, context) => scopedChild(input, context, input.task),
  filter(input: TaskAttemptCallsFilter) {
    const scoped = taskInScope("a.task_id", input)
    const clauses = [
      "runner_progress_display.project_directory = ?",
      "runner_progress_display.attempt_id = ?",
      "runner_progress_display.session_id = ?",
      `EXISTS (SELECT 1 FROM runner_attempts a WHERE a.id=runner_progress_display.attempt_id AND a.task_id=? AND ${scoped.clause})`,
    ]
    if (input.toolsOnly)
      // The raw `kind = 'tool'` rows with a call id; the display names them `tool` or `worker-tool`
      // (29,791 of 29,791 live rows agree, 2026-11-21).
      clauses.push(
        "runner_progress_display.kind IN ('tool','worker-tool') AND runner_progress_display.call_id IS NOT NULL",
      )
    return {
      where: clauses.join(" AND "),
      params: [
        input.project ?? null,
        input.attempt ?? null,
        input.sessionID ?? null,
        input.task ?? null,
        ...scoped.params,
      ],
    }
  },
  columns: taskAttemptCallColumns,
})

/**
 * The current activity of the rows in view: the stored node and latest attempt, joined to the
 * attempt session's host facts. Replaces the `currentActivity` RPC, which read the host twice per
 * row on the main thread.
 */
defineSource({
  name: TASK_SOURCES.currentActivity,
  table: `(SELECT t.task_id AS task_id, t.project_directory AS project_directory,
      t.node_state AS node_state, t.plan_state AS plan_state, t.node_reason AS node_reason,
      t.plan_reason AS plan_reason, t.attempt_id AS attempt_id,
      t.attempt_session_id AS attempt_session_id, t.attempt_workspace AS attempt_workspace,
      h.agent AS host_agent, h.attempt_id AS host_attempt_id, h.directory AS host_directory,
      h.busy AS busy, h.pending_input AS pending_input, h.pending_permissions AS pending_permissions,
      h.pending_forms AS pending_forms, h.outcome AS outcome, h.archived AS archived,
      h.updated_at AS observed_at
    FROM task_schedule t LEFT JOIN host_session_state h
      ON h.project_directory=t.project_directory AND h.session_id=t.attempt_session_id) AS task_current`,
  tables: ["task_schedule", "host_session_state", "task_schedule_sessions"],
  key: ["task_id"],
  orders: { task: [{ column: "task_id", direction: "asc" }] },
  authorize: (input: TaskCurrentActivityFilter, context) => scopedTo(input, context),
  filter(input: TaskCurrentActivityFilter) {
    // `+project_directory`: the rows come by task id (unique), never by a scan of the project.
    const clauses = [
      "+task_current.project_directory = ?",
      `task_current.task_id IN (${placeholders(input.tasks)})`,
    ]
    const params: (string | number | null)[] = [input.project ?? null, ...input.tasks]
    if (input.session !== undefined) {
      clauses.push(
        "EXISTS (SELECT 1 FROM task_schedule_sessions s WHERE s.task_id=task_current.task_id AND s.session_id=?)",
      )
      params.push(input.session)
    }
    return { where: clauses.join(" AND "), params }
  },
  columns: taskCurrentActivityColumns,
})

/** The search fields of a page's tasks, so a search hit shows where it matched. Server-side only. */
defineSource({
  name: TASK_SOURCES.searchFields,
  table: "task_schedule_search",
  tables: ["task_schedule_search", "task_schedule"],
  key: ["task_id", "ord"],
  orders: {
    field: [
      { column: "task_id", direction: "asc" },
      { column: "ord", direction: "asc" },
    ],
  },
  authorize() {
    throw new Error("Search fields are read by the agent tool, not over RPC")
  },
  filter: (input: TaskSearchFieldsFilter) => ({
    where: `task_schedule_search.task_id IN (${placeholders(input.tasks)}) AND EXISTS (
      SELECT 1 FROM task_schedule t WHERE t.task_id=task_schedule_search.task_id AND t.project_directory=?)`,
    params: [...input.tasks, input.project ?? null],
  }),
  columns: taskSearchFieldColumns,
})
