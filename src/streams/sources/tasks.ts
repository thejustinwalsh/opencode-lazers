import { bucketsFor } from "../../tasks/schedule/key.ts"
import type { Bucket } from "../../tasks/schedule/schema.ts"
import { defineSource } from "../source.ts"

/**
 * The Tasks panel's sources, over the stored projection (`design/task-schedule-projection.md`).
 * Every column a source reads is a column of a projection table, kept current in the writing
 * transaction; nothing here derives a field, reads a task body or needs main-thread memory.
 */

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

export type TaskScheduleFilter = {
  project: string
  state?: TaskStateFilter
  /** One task by id. */
  taskID?: string
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

const placeholders = (values: readonly unknown[]) => values.map(() => "?").join(",")

export const taskScheduleColumns = {
  task_id: "text",
  seq: "int",
  sort_key: "text",
  reference: "text",
  title: "text",
  objective: "text",
  status: "text",
  reason: "text",
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
  dispatch_pause: "json",
  dispatch_pause_plan_id: "text",
  dependency_count: "int",
  blocker_count: "int",
  wait_plans_count: "int",
  decision: "text",
  decision_reason: "text",
  disposition: "json",
  retired: "bool",
  source_plan: "json",
  revision: "int",
  session_id: "text",
  created_at: "text",
} as const

export const taskScheduleSource = defineSource({
  name: "tasks.schedule",
  table: "task_schedule",
  tables: ["task_schedule", "task_schedule_sessions", "task_schedule_scopes"],
  key: ["task_id"],
  orders: {
    // The old `sort: "schedule"`: one stored key holds all seven terms.
    schedule: [
      { column: "sort_key", direction: "asc" },
      { column: "task_id", direction: "asc" },
    ],
    // The old `sort: "recent"`: newest first.
    recent: [
      { column: "seq", direction: "desc" },
      { column: "task_id", direction: "asc" },
    ],
  },
  filter(input: TaskScheduleFilter) {
    const clauses = ["task_schedule.project_directory = ?"]
    const params: (string | number | null)[] = [input.project]
    if (input.taskID !== undefined) {
      clauses.push("task_schedule.task_id = ?")
      params.push(input.taskID)
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
  detail: { concern_totals: "json" },
})

/** The dependency children of one task, in the order the list shows them. */
export const taskDependenciesSource = defineSource({
  name: "tasks.dependencies",
  table: "task_schedule_edges",
  key: ["parent_task_id", "ord"],
  orders: {
    ord: [
      { column: "parent_task_id", direction: "asc" },
      { column: "ord", direction: "asc" },
    ],
  },
  filter: (input: { parent: string }) => ({ where: "parent_task_id = ?", params: [input.parent] }),
  columns: {
    parent_task_id: "text",
    ord: "int",
    child_task_id: "text",
    kind: "text",
    child_reference: "text",
    child_title: "text",
    child_state: "text",
    waiting: "bool",
    child_plan_id: "text",
  },
})

/** Plans in scheduler order: priority (1 first, none last), then plan creation order. */
export const taskPlansSource = defineSource({
  name: "tasks.plans",
  table: "task_schedule_plans",
  key: ["plan_id"],
  orders: {
    schedule: [
      { column: "priority_key", direction: "asc" },
      { column: "seq", direction: "asc" },
      { column: "plan_id", direction: "asc" },
    ],
  },
  filter(input: { project: string; state?: string }) {
    return input.state === undefined
      ? { where: "project_directory = ?", params: [input.project] }
      : { where: "project_directory = ? AND state = ?", params: [input.project, input.state] }
  },
  columns: {
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
    plan_version: "int",
    plan_revision: "int",
    node_count: "int",
    open_count: "int",
  },
})

/** The reservations holding one queued task back, with the blocker's reference. */
export const taskBlockersSource = defineSource({
  name: "tasks.blockers",
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
  filter: (input: { task: string }) => ({
    where: "task_schedule_blockers.task_id = ?",
    params: [input.task],
  }),
  columns: { task_id: "text", blocker_task_id: "text", reference: "text", title: "text" },
})

/** The prerequisite plans one task still waits on. */
export const taskWaitsSource = defineSource({
  name: "tasks.waits",
  table: "task_schedule_waits",
  key: ["task_id", "ord"],
  orders: {
    ord: [
      { column: "task_id", direction: "asc" },
      { column: "ord", direction: "asc" },
    ],
  },
  filter: (input: { task: string }) => ({ where: "task_id = ?", params: [input.task] }),
  columns: {
    task_id: "text",
    ord: "int",
    plan_id: "text",
    title: "text",
    state: "text",
    reason: "text",
  },
})

/** Chip counts: one stored counter per bucket of a project (retired tasks excluded). */
export const taskBucketCountsSource = defineSource({
  name: "tasks.bucketCounts",
  table: "task_schedule_counts",
  key: ["project_directory", "bucket"],
  orders: {
    bucket: [
      { column: "project_directory", direction: "asc" },
      { column: "bucket", direction: "asc" },
    ],
  },
  filter: (input: { project: string }) => ({
    where: "project_directory = ?",
    params: [input.project],
  }),
  columns: { project_directory: "text", bucket: "text", n: "int" },
})

/** Chip counts for the tasks one session created, owns a plan of, or ran an attempt of. */
export const taskSessionBucketCountsSource = defineSource({
  name: "tasks.sessionBucketCounts",
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
  filter: (input: { project: string; session: string }) => ({
    where: "project_directory = ? AND session_id = ?",
    params: [input.project, input.session],
  }),
  columns: { session_id: "text", project_directory: "text", bucket: "text", n: "int" },
})
