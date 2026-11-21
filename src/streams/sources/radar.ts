import { defineSource, type StreamContext } from "../source.ts"
import {
  RADAR_SOURCES,
  radarAssignmentColumns,
  radarAttemptDetail,
  radarGroupColumns,
  radarJournalColumns,
  radarNodeColumns,
  radarNativeCallColumns,
  radarPlanEventColumns,
  radarPlanEventDetail,
  radarSchedulerColumns,
  radarWorkloadColumns,
  type RadarAssignmentsFilter,
  type RadarAttemptFilter,
  type RadarGroupFilter,
  type RadarJournalFilter,
  type RadarNativeCallsFilter,
  type RadarNodesFilter,
  type RadarPlanEventsFilter,
  type RadarProjectFilter,
  type RadarScope,
} from "./radar-ref.ts"

/**
 * The Radar's sources, over stored rows only (`.agents/plans/panel-streams.md`, Panel 1): active
 * attempts with their task's stored labels, an attempt for the worker pane, canonical tool calls
 * (`native_tool_call_display`), the Map groups and workload (`task_schedule`), the recovery
 * journal, the scheduler status row and the lifecycle's recorded edges (`task_events`).
 *
 * Scope checks carried over from `authorize` (`src/observability/rpc.ts`): the caller's session
 * may read this project (`context.assertRead`: session lookup and the `read` permission), and the
 * project is the service's own directory, whatever the caller sent. A session view reads its own
 * session's attempt and calls only (`liveAttempt`'s equality, `live-store.ts`); the group,
 * workload and lifecycle reads were project-wide in a session view before and stay so.
 */
async function scoped<F extends { scope: RadarScope; projectDirectory: string }>(
  input: F,
  context: StreamContext,
): Promise<F> {
  const scope = input.scope
  if (!scope?.sessionID || !["session", "project", "all"].includes(scope.kind))
    throw new Error("A Radar read names its scope")
  await context.assertRead(scope.sessionID)
  return { ...input, projectDirectory: context.projectDirectory }
}

/** A session view reads only its own session. */
function ownSession(input: { scope: RadarScope; sessionID?: string }) {
  if (input.scope.kind === "session" && input.sessionID !== input.scope.sessionID)
    throw new Error("Selected session is unavailable in this project scope")
}

const ACTIVE = "radar_attempts.state IN ('preparing','running','verifying')"

/**
 * Attempts with their task's stored row. `runner_attempts` is small (one row per attempt, 252
 * live) and the partial index `runner_attempts_active_project` holds only the active ones; the
 * policy JSON is read for the rows of one window. The task's labels, states and concern come from
 * `task_schedule`, never from a task body.
 */
const ATTEMPTS = `(SELECT a.id AS id, a.project_directory AS project_directory, a.session_id AS session_id,
    a.plan_id AS plan_id, a.task_id AS task_id, a.number AS number, a.state AS state,
    a.started_at AS started_at, a.tool_count AS tool_count,
    json_extract(a.policy,'$.model') AS model,
    json_extract(a.policy,'$.takeover') IS NOT NULL AS takeover,
    a.workspace AS workspace, a.base_commit AS base_commit, a.artifact AS artifact,
    t.reference AS reference, t.title AS title, t.node_state AS node_state,
    t.node_reason AS node_reason, t.plan_state AS plan_state, t.plan_reason AS plan_reason,
    t.concern AS concern
  FROM runner_attempts a LEFT JOIN task_schedule t ON t.task_id=a.task_id) AS radar_attempts`

export const radarAssignmentsSource = defineSource({
  name: RADAR_SOURCES.assignments,
  table: ATTEMPTS,
  tables: ["runner_attempts", "task_schedule"],
  key: ["id"],
  orders: {
    recent: [
      { column: "started_at", direction: "desc" },
      { column: "id", direction: "desc" },
    ],
  },
  async authorize(input: RadarAssignmentsFilter, context) {
    const checked = await scoped(input, context)
    // A session view lists its own session's attempt, as the old read's session filter did.
    return input.scope.kind === "session"
      ? { ...checked, sessionID: input.scope.sessionID }
      : checked
  },
  filter(input: RadarAssignmentsFilter) {
    const clauses = ["radar_attempts.project_directory = ?", ACTIVE]
    const params: string[] = [input.projectDirectory]
    if (input.sessionID !== undefined) {
      clauses.push("radar_attempts.session_id = ?")
      params.push(input.sessionID)
    }
    return { where: clauses.join(" AND "), params }
  },
  columns: radarAssignmentColumns,
})

export const radarAttemptSource = defineSource({
  name: RADAR_SOURCES.attempt,
  table: ATTEMPTS,
  tables: ["runner_attempts", "task_schedule"],
  key: ["id"],
  orders: {
    recent: [
      { column: "started_at", direction: "desc" },
      { column: "id", direction: "desc" },
    ],
  },
  async authorize(input: RadarAttemptFilter, context) {
    ownSession(input)
    return scoped(input, context)
  },
  filter(input: RadarAttemptFilter) {
    // `session_id` is UNIQUE on `runner_attempts`: one row.
    return {
      where: "radar_attempts.session_id = ? AND radar_attempts.project_directory = ?",
      params: [input.sessionID, input.projectDirectory],
    }
  },
  columns: radarAssignmentColumns,
  detail: radarAttemptDetail,
})

export const radarNativeCallsSource = defineSource({
  name: RADAR_SOURCES.nativeCalls,
  table: "native_tool_call_display",
  key: ["id"],
  // `first_observed_at` never changes, so a window does not re-anchor when a call updates.
  orders: {
    recent: [
      { column: "first_observed_at", direction: "desc" },
      { column: "id", direction: "asc" },
    ],
  },
  async authorize(input: RadarNativeCallsFilter, context) {
    ownSession(input)
    return scoped(input, context)
  },
  filter(input: RadarNativeCallsFilter) {
    return {
      where: `project_directory = ? AND session_id = ?${input.nativeOnly ? " AND identity_kind = 'native-call'" : ""}`,
      params: [input.projectDirectory, input.sessionID],
    }
  },
  columns: radarNativeCallColumns,
})

const GROUPS = {
  "needs-you": "owner_hold = 1",
  failed: "bucket = 'failed'",
  // Queued as the workload counts it: the bucket, plus queued tasks held back with no owner hold.
  queued:
    "(bucket = 'queued' OR (bucket = 'blocked' AND owner_hold = 0 AND node_state = 'queued'))",
} as const

/** The tasks behind one Map group, newest first; its total is the workload's number. */
export const radarGroupSource = defineSource({
  name: RADAR_SOURCES.group,
  table: "task_schedule",
  key: ["task_id"],
  orders: {
    recent: [
      { column: "seq", direction: "desc" },
      { column: "task_id", direction: "asc" },
    ],
  },
  authorize: (input: RadarGroupFilter, context) => scoped(input, context),
  filter(input: RadarGroupFilter) {
    const predicate = GROUPS[input.group]
    if (!predicate) throw new Error(`Unknown Radar group ${String(input.group)}`)
    return {
      where: `project_directory = ? AND retired = 0 AND ${predicate}`,
      params: [input.projectDirectory],
    }
  },
  columns: radarGroupColumns,
})

/**
 * The workload numbers of one project: Queued and Failed from the stored bucket counters, plus two
 * counts over partial or covering index ranges (`storedWorkload`, `src/tasks/schedule/stored.ts`).
 */
const WORKLOAD = `(SELECT s.project_directory AS project_directory, s.ready AS ready,
    COALESCE((SELECT c.n FROM task_schedule_counts c
       WHERE c.project_directory=s.project_directory AND c.bucket='queued'),0)
     + (SELECT COUNT(*) FROM task_schedule t WHERE t.project_directory=s.project_directory
         AND t.retired=0 AND t.bucket='blocked' AND t.owner_hold=0 AND t.node_state='queued') AS queued,
    (SELECT COUNT(*) FROM task_schedule t WHERE t.project_directory=s.project_directory
       AND t.retired=0 AND t.owner_hold=1) AS needs_you,
    COALESCE((SELECT c.n FROM task_schedule_counts c
       WHERE c.project_directory=s.project_directory AND c.bucket='failed'),0) AS failed
  FROM task_schedule_state s) AS radar_workload`

export const radarWorkloadSource = defineSource({
  name: RADAR_SOURCES.workload,
  table: WORKLOAD,
  tables: ["task_schedule_state", "task_schedule_counts", "task_schedule"],
  key: ["project_directory"],
  orders: { key: [{ column: "project_directory", direction: "asc" }] },
  authorize: (input: RadarProjectFilter, context) => scoped(input, context),
  filter: (input: RadarProjectFilter) => ({
    where: "radar_workload.project_directory = ?",
    params: [input.projectDirectory],
  }),
  columns: radarWorkloadColumns,
  count: { exact: "scan" },
})

/** Recovery journal facts of the project, newest first (`recovery_progress_facts_project_cursor`). */
export const radarJournalSource = defineSource({
  name: RADAR_SOURCES.journal,
  table: "recovery_progress_facts",
  key: ["change_id"],
  orders: { recent: [{ column: "change_id", direction: "desc" }] },
  authorize: (input: RadarJournalFilter, context) => scoped(input, context),
  filter(input: RadarJournalFilter) {
    return input.attemptID === undefined
      ? { where: "project_directory = ?", params: [input.projectDirectory] }
      : {
          where: "project_directory = ? AND attempt_id = ?",
          params: [input.projectDirectory, input.attemptID],
        }
  },
  columns: radarJournalColumns,
})

export const radarSchedulerSource = defineSource({
  name: RADAR_SOURCES.scheduler,
  table: "scheduler_project_status",
  key: ["project_directory"],
  orders: { key: [{ column: "project_directory", direction: "asc" }] },
  authorize: (input: RadarProjectFilter, context) => scoped(input, context),
  filter: (input: RadarProjectFilter) => ({
    where: "project_directory = ?",
    params: [input.projectDirectory],
  }),
  columns: radarSchedulerColumns,
  count: { exact: "scan" },
})

/**
 * The lifecycle view's recorded transitions: for one plan node, the latest transition of each
 * (from, event, to) edge, which is all the statechart shows (`observedTransition`,
 * `src/radar/projection.ts`) and all it lets a user select. Grouped at read time over the node's
 * rows of `task_events` (`task_events_plan`; a few hundred rows per node at most, 379 live), so no
 * second table is kept. Plan-level transitions (`task_id` NULL) were never shown and are not read.
 */
const PLAN_EDGES = `(SELECT MAX(id) AS id, project_directory, plan_id, task_id, event, from_state,
    to_state, attempt_id, at, detail
  FROM task_events WHERE kind='transition' AND from_state IS NOT NULL AND to_state IS NOT NULL
  GROUP BY project_directory, plan_id, task_id, event, from_state, to_state) AS radar_plan_edges`

export const radarPlanEventsSource = defineSource({
  name: RADAR_SOURCES.planEvents,
  table: PLAN_EDGES,
  tables: ["task_events"],
  key: ["id"],
  orders: { id: [{ column: "id", direction: "asc" }] },
  authorize: (input: RadarPlanEventsFilter, context) => scoped(input, context),
  filter: (input: RadarPlanEventsFilter) => ({
    where:
      "radar_plan_edges.project_directory = ? AND radar_plan_edges.plan_id = ? AND radar_plan_edges.task_id = ?",
    params: [input.projectDirectory, input.planID, input.taskID],
  }),
  columns: radarPlanEventColumns,
  detail: radarPlanEventDetail,
  count: { exact: "scan" },
})

/**
 * The nodes of one plan in plan order, with what the lifecycle statechart needs: the recorded state
 * and the persisted machine snapshot whose value it highlights. `runner_nodes` holds a few rows per
 * plan (251 live); its primary key `(plan_id, task_id)` serves the filter.
 */
export const radarNodesSource = defineSource({
  name: RADAR_SOURCES.nodes,
  table: "runner_nodes",
  tables: ["runner_nodes", "runner_plans"],
  key: ["task_id"],
  orders: {
    plan: [
      { column: "ordinal", direction: "asc" },
      { column: "task_id", direction: "asc" },
    ],
  },
  authorize: (input: RadarNodesFilter, context) => scoped(input, context),
  filter: (input: RadarNodesFilter) => ({
    where:
      "plan_id = ? AND EXISTS (SELECT 1 FROM runner_plans p WHERE p.id = runner_nodes.plan_id AND p.project_directory = ?)",
    params: [input.planID, input.projectDirectory],
  }),
  columns: radarNodeColumns,
  count: { exact: "scan" },
})
