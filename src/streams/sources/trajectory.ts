import { defineSource, type StreamContext } from "../source.ts"
import {
  TRAJECTORY_SOURCES,
  trajectoryAttemptColumns,
  trajectoryEventColumns,
  trajectoryEventDetail,
  type TrajectoryAttemptsFilter,
  type TrajectoryEventsFilter,
} from "./trajectory-ref.ts"

/**
 * The Trajectory panel's SQL sources (`.agents/plans/panel-streams.md`, Panel 2): a task's
 * timeline as one ordered stream over the stored rows LAZERS derived, and its attempts.
 *
 * ```
 * trajectory.events   task_events ─────────────────────────────┐ (transitions, effects, checks, progress)
 *                     transcript_steps ⋈ runner_attempts ──────┤ assistant-step / provider-retry / assistant-error
 *                     native_tool_call_display ⋈ attempts ─────┘ tool
 *                       UNION ALL ordered by (sort_at, sort_key, ref)
 * ```
 *
 * Message text is never stored: no arm selects a text column (`native_tool_call_display.detail`
 * and `.error` are not read), and `trajectory.transcript` carries it from the host.
 *
 * Scope checks carried over from `lz-inspect-trajectory` (`src/observability/rpc.ts`
 * `authorize`, `loadTaskObservationSource`): an eligible session with the tool's permission, the
 * service's own project directory whatever the caller sent, and a session view reads only tasks
 * that session is associated with.
 */
const COLUMNS = Object.keys(trajectoryEventColumns)
const UNTIMED = "9007199254740991"

/** One arm of the union: every column, NULL where the arm has none. */
function arm(values: Record<string, string>, from: string, where = "") {
  const select = [...COLUMNS, "detail"].map((name) => `${values[name] ?? "NULL"} AS ${name}`)
  const own = ["project_directory", "task_id"].map((name) => `${values[name]} AS ${name}`)
  return `SELECT ${[...select, ...own].join(", ")} FROM ${from}${where ? ` WHERE ${where}` : ""}`
}

// CROSS JOIN fixes the order: the task's attempts first (`runner_attempts(task_id, number)`), then
// each attempt's session through the child's index. Left to choose, SQLite scans the project's steps.
const stepFrom =
  "runner_attempts a CROSS JOIN transcript_steps s ON s.project_directory=a.project_directory AND s.session_id=a.session_id"
const step = (
  kind: string,
  ref: string,
  at: string,
  key: string,
  extra: Record<string, string>,
) => ({
  ref: `'${ref}:'||s.id`,
  sort_at: `COALESCE(${at}, ${UNTIMED})`,
  sort_key: `s.message_id||':${key}'`,
  kind: `'${kind}'`,
  at,
  plan_id: "a.plan_id",
  attempt_id: "a.id",
  session_id: "s.session_id",
  message_id: "s.message_id",
  project_directory: "s.project_directory",
  task_id: "a.task_id",
  ...extra,
})

/**
 * A tool call's time: the host part's call boundary (`time.ran`, stored as the call's
 * `calledAt`), as the old read placed it; before the call (input still streaming) its first
 * observation, the input start.
 */
const TOOL_AT = "COALESCE(c.called_at, c.first_observed_at)"
/** The host part's `time.completed`; a terminal call recorded without it ends at its last observation. */
const TOOL_COMPLETED_AT =
  "COALESCE(c.completed_at, CASE WHEN c.status IN ('succeeded','failed') THEN c.last_observed_at END)"
/**
 * The host part's status word (`streaming`, `running`, `completed`, `error`), which the old read
 * showed, from the recorder's (`input-started`, `running`, `succeeded`, `failed`). A call recorded
 * as not executed keeps no host status: an error recorded on it reads `error`, a completion time
 * `completed`, otherwise it is still `running`. A call with no recorded status yet is running.
 */
const TOOL_STATUS = `CASE c.status WHEN 'succeeded' THEN 'completed' WHEN 'failed' THEN 'error'
  WHEN 'input-started' THEN 'streaming'
  WHEN 'not-executed' THEN CASE WHEN c.error IS NOT NULL THEN 'error'
    WHEN c.completed_at IS NOT NULL THEN 'completed' ELSE 'running' END
  ELSE 'running' END`

/** A stored event's columns, read from `task_events` under `alias`. */
const STORED_COLUMNS = [
  "sort_at",
  "sort_key",
  "kind",
  "at",
  "plan_id",
  "attempt_id",
  "session_id",
  "event",
  "from_state",
  "to_state",
  "status",
  "tool",
  "title",
  "route_provider",
  "route_model",
  "route_variant",
  "started_at",
  "ended_at",
  "detail",
  "project_directory",
  "task_id",
]
const stored = (alias: string, extra: Record<string, string> = {}) => ({
  ref: `${alias}.origin`,
  ...Object.fromEntries(STORED_COLUMNS.map((name) => [name, `${alias}.${name}`])),
  ...extra,
})

const EVENTS = `(${[
  arm(stored("e"), "task_events e", "e.kind<>'progress'"),
  // A progress row (`pg:<seq>`) with what `task_events` does not copy from its display row: the
  // call and message it belongs to (a worker tool fact and its host call are one mark) and its
  // recorded file targets (the Files lane). One primary-key read per row.
  arm(
    stored("e", {
      message_id: "d.message_id",
      call_id: "d.call_id",
      file_targets: "d.file_targets_json",
    }),
    "task_events e LEFT JOIN runner_progress_display d ON d.seq=CAST(substr(e.origin,4) AS INTEGER)",
    "e.kind='progress'",
  ),
  arm(
    step("assistant-step", "step", "s.created_at", "assistant-step", {
      // The old read's `assistantStepStatus`, in SQL; no row of a step has an unknown status.
      status:
        "CASE WHEN s.error_type IS NOT NULL THEN 'failed' WHEN s.completed_at IS NOT NULL THEN 'ended' WHEN s.streamed_at IS NOT NULL THEN 'streamed' WHEN s.created_at IS NOT NULL THEN 'started' END",
      route_provider: "s.provider_id",
      route_model: "s.model_id",
      route_variant: "s.variant",
      streamed_at: "s.streamed_at",
      completed_at: "s.completed_at",
      input_tokens: "s.input_tokens",
      output_tokens: "s.output_tokens",
    }),
    stepFrom,
  ),
  arm(
    step("provider-retry", "retry", "s.retry_at", "provider-retry", {
      retry_attempt: "s.retry_attempt",
      error_type: "s.retry_error_type",
    }),
    stepFrom,
    "s.retry_at IS NOT NULL",
  ),
  arm(
    step("assistant-error", "error", "s.created_at", "error", { error_type: "s.error_type" }),
    stepFrom,
    "s.error_type IS NOT NULL",
  ),
  arm(
    {
      ref: "'call:'||c.id",
      sort_at: TOOL_AT,
      sort_key: "c.message_id||':tool:'||c.call_id",
      kind: "'tool'",
      at: TOOL_AT,
      plan_id: "a.plan_id",
      attempt_id: "a.id",
      session_id: "c.session_id",
      message_id: "c.message_id",
      call_id: "c.call_id",
      status: TOOL_STATUS,
      tool: "c.tool",
      // The step's route, as the old read repeated its message's model on each of its tool calls.
      route_provider: "s.provider_id",
      route_model: "s.model_id",
      route_variant: "s.variant",
      completed_at: TOOL_COMPLETED_AT,
      project_directory: "c.project_directory",
      task_id: "a.task_id",
    },
    "runner_attempts a CROSS JOIN native_tool_call_display c ON c.project_directory=a.project_directory AND c.session_id=a.session_id" +
      " LEFT JOIN transcript_steps s ON s.project_directory=c.project_directory AND s.session_id=c.session_id AND s.message_id=c.message_id",
    // The host's tool parts, which the old read listed; a LAZERS tool-wrapper invocation
    // (`local-invocation`, a LAZERS tool called inside a host call) is not a part of its own.
    "c.identity_kind='native-call'",
  ),
].join(" UNION ALL ")}) AS trajectory_events`

/** A scope the caller named, authorized for one task. Shared by the events and attempts sources. */
export async function authorizeTask<F extends TrajectoryAttemptsFilter>(
  input: F,
  context: StreamContext,
): Promise<F> {
  const scope = input.scope
  if (!scope?.sessionID || !["session", "project"].includes(scope.kind))
    throw new Error("Trajectory scope is unavailable")
  if (!input.taskID) throw new Error("Trajectory scope is unavailable")
  if (!context.assertAction) throw new Error("Trajectory scope is unavailable")
  await context.assertAction(scope.sessionID, "lz-inspect-trajectory")
  const projectDirectory = context.projectDirectory
  const belongs = context.read?.((db) =>
    scope.kind === "project"
      ? db
          .query("SELECT 1 FROM tasks WHERE project_directory=? AND id=?")
          .get(projectDirectory, input.taskID)
      : db
          .query("SELECT 1 FROM task_schedule_sessions WHERE session_id=? AND task_id=?")
          .get(scope.sessionID, input.taskID),
  )
  if (!belongs) throw new Error("Trajectory scope is unavailable")
  return { ...input, projectDirectory }
}

export const trajectoryEventsSource = defineSource({
  name: TRAJECTORY_SOURCES.events,
  table: EVENTS,
  tables: [
    "task_events",
    "runner_progress_display",
    "transcript_steps",
    "native_tool_call_display",
    "runner_attempts",
  ],
  key: ["ref"],
  orders: {
    timeline: [
      { column: "sort_at", direction: "asc" },
      { column: "sort_key", direction: "asc" },
      { column: "ref", direction: "asc" },
    ],
    follow: [
      { column: "sort_at", direction: "desc" },
      { column: "sort_key", direction: "desc" },
      { column: "ref", direction: "desc" },
    ],
  },
  authorize: (input: TrajectoryEventsFilter, context) => authorizeTask(input, context),
  filter(input: TrajectoryEventsFilter) {
    const clauses = ["trajectory_events.project_directory = ?", "trajectory_events.task_id = ?"]
    const params: string[] = [input.projectDirectory, input.taskID]
    // An attempt's view keeps the task's plan-level events (no attempt), as the old read did.
    if (input.attemptID !== undefined) {
      clauses.push("(trajectory_events.attempt_id = ? OR trajectory_events.attempt_id IS NULL)")
      params.push(input.attemptID)
    }
    if (input.kinds !== undefined) {
      clauses.push(`trajectory_events.kind IN (${input.kinds.map(() => "?").join(",")})`)
      params.push(...input.kinds)
    }
    return { where: clauses.join(" AND "), params }
  },
  columns: trajectoryEventColumns,
  detail: trajectoryEventDetail,
  // A task's timeline is a few thousand rows.
  count: { exact: "scan" },
})

const ATTEMPTS = `(SELECT a.id AS id, a.project_directory AS project_directory, a.plan_id AS plan_id,
    a.task_id AS task_id, a.number AS number, a.state AS state, a.session_id AS session_id,
    a.started_at AS started_at, a.tool_count AS tool_count, a.token_count AS token_count,
    a.retry_count AS retry_count, json_extract(a.policy,'$.model') AS model,
    json_extract(a.policy,'$.takeover') IS NOT NULL AS takeover,
    (SELECT MAX(e.at) FROM task_events e
      WHERE e.project_directory=a.project_directory AND e.attempt_id=a.id) AS last_event_at,
    (SELECT SUM(s.completed_at - s.created_at) FROM transcript_steps s
      WHERE s.project_directory=a.project_directory AND s.session_id=a.session_id
        AND s.completed_at >= s.created_at) AS active_ms
  FROM runner_attempts a) AS trajectory_attempts`

export const trajectoryAttemptsSource = defineSource({
  name: TRAJECTORY_SOURCES.attempts,
  table: ATTEMPTS,
  tables: ["runner_attempts", "task_events", "transcript_steps"],
  key: ["id"],
  orders: {
    number: [
      { column: "number", direction: "asc" },
      { column: "id", direction: "asc" },
    ],
  },
  authorize: (input: TrajectoryAttemptsFilter, context) => authorizeTask(input, context),
  filter: (input: TrajectoryAttemptsFilter) => ({
    where: "trajectory_attempts.project_directory = ? AND trajectory_attempts.task_id = ?",
    params: [input.projectDirectory, input.taskID],
  }),
  columns: trajectoryAttemptColumns,
  count: { exact: "scan" },
})
