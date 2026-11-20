import { bucketsFor } from "../../tasks/schedule/key.ts"
import type { Bucket } from "../../tasks/schedule/schema.ts"
import { defineSource, type StreamContext } from "../source.ts"
import {
  TASK_SOURCES,
  taskBlockerColumns,
  taskBucketCountColumns,
  taskDependencyRowColumns,
  taskIndexColumns,
  taskPlanColumns,
  taskScheduleColumns,
  taskSessionBucketCountColumns,
  taskWaitColumns,
  type TaskChildFilter,
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
    const buckets: readonly Bucket[] | undefined = bucketsFor(input.state)
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
export const taskBlockersSource = defineSource({
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
export const taskIndexSource = defineSource({
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
