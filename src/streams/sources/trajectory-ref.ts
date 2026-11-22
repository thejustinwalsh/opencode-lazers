import type { Columns } from "../frame.ts"

/**
 * The Trajectory panel's sources (`.agents/plans/panel-streams.md`, Panel 2), the part a consumer
 * without a database needs: names, filters and columns. The GUI builds its `sourceRef` from these.
 *
 * ```
 * trajectory.events      task_events ∪ transcript_steps ∪ native_tool_call_display   (SQL)
 * trajectory.attempts    runner_attempts                                             (SQL)
 * trajectory.effort      trajectory_task_effort                                      (SQL)
 * trajectory.transcript  OpenCode message.list by cursor, privacy filtered, unstored (host)
 * ```
 *
 * OpenCode owns message text: only `trajectory.transcript` carries it, read on demand and never
 * stored. Every other row is a stored fact LAZERS derived.
 */
export const TRAJECTORY_SOURCES = {
  events: "trajectory.events",
  attempts: "trajectory.attempts",
  effort: "trajectory.effort",
  transcript: "trajectory.transcript",
} as const

/** The caller's view: a session view reads only tasks that session is associated with. */
export type TrajectoryScope = { kind: "session" | "project"; sessionID: string }

type Scoped = {
  /** Set by the service for a stream opened over RPC: whatever the caller sends is replaced. */
  projectDirectory: string
  scope: TrajectoryScope
  taskID: string
}

export type TrajectoryEventsFilter = Scoped & {
  attemptID?: string
  /** Row kinds to keep (the `kind` column); all when omitted. */
  kinds?: readonly string[]
}
export type TrajectoryAttemptsFilter = Scoped
export type TrajectoryEffortFilter = Scoped
/** One attempt session's transcript; the session must be an attempt of the task. */
export type TrajectoryTranscriptFilter = Scoped & { sessionID: string }

/**
 * One timeline row. `ref` is the key: a `task_events.origin` (`tr:`, `ef:`, `pg:`), or
 * `step:<id>`, `retry:<id>`, `error:<id>` (a `transcript_steps` row) or `call:<id>` (a
 * `native_tool_call_display` row). Order `timeline` is `sort_at, sort_key, ref` ascending: the old
 * read's order (untimed rows last at the largest safe integer, ties by the old event id).
 *
 * `kind`: `transition`, `effect`, `check`, `progress` (stored events), `assistant-step`,
 * `provider-retry`, `assistant-error` (steps) or `tool` (native calls).
 */
export const trajectoryEventColumns = {
  ref: "text",
  sort_at: "float",
  sort_key: "text",
  kind: "text",
  /** Event time in epoch ms; null when the source has none. */
  at: "float",
  plan_id: "text",
  attempt_id: "text",
  session_id: "text",
  message_id: "text",
  call_id: "text",
  /** Transition event, effect kind, check id, display kind; null for steps and calls. */
  event: "text",
  from_state: "text",
  to_state: "text",
  /** Check result, progress status, step status, call status. */
  status: "text",
  tool: "text",
  title: "text",
  route_provider: "text",
  route_model: "text",
  route_variant: "text",
  /** Step streamed/completed time, call last observation; epoch ms. */
  streamed_at: "float",
  completed_at: "float",
  /** A check's receipt interval (`check.startedAt`/`check.endedAt`), epoch ms; null otherwise. */
  started_at: "float",
  ended_at: "float",
  input_tokens: "int",
  output_tokens: "int",
  /** Error name (never a message): a failed step, or a retry's error. */
  error_type: "text",
  retry_attempt: "int",
  /**
   * A progress row's recorded file targets (`{ coverage, operation, paths }`, workspace-relative
   * and validated at record time); null otherwise.
   */
  file_targets: "json",
} as const satisfies Columns

/** At `window: 1`: the stored event's cold JSON (`{ event }` or `{ event, check }`); null otherwise. */
export const trajectoryEventDetail = { detail: "json" } as const satisfies Columns

export const trajectoryAttemptColumns = {
  id: "text",
  plan_id: "text",
  task_id: "text",
  number: "int",
  state: "text",
  session_id: "text",
  started_at: "int",
  tool_count: "int",
  token_count: "int",
  retry_count: "int",
  /** The admitted model, `{ providerID, id, variant? }`, from the attempt's policy. */
  model: "json",
  takeover: "bool",
  /** The attempt's latest stored event time (`task_events`), epoch ms; null before one. */
  last_event_at: "float",
} as const satisfies Columns

export const trajectoryEffortColumns = {
  id: "int",
  task_id: "text",
  busy: "bool",
  uncached_input: "int",
  output: "int",
  reasoning: "int",
  cache_read: "int",
  cache_write: "int",
  sessions: "int",
  known_sessions: "int",
  /** Market value as a decimal string; null when no source prices it (the UI omits the price). */
  market_value: "text",
  market_status: "text",
  refreshed_at: "int",
} as const satisfies Columns

/** At `window: 1`: the stored effort summary (`TaskEffortSummary`). */
export const trajectoryEffortDetail = { effort: "json" } as const satisfies Columns

/**
 * One privacy-filtered transcript event read from the host (`src/trajectory/privacy.ts` applied at
 * read time). `id` is the old read's event id (`<message>:text`, `<message>:text:<part>`,
 * `<message>:tool:<part>`, `<message>` for shell, compaction and switches), so a stored `tool` or
 * `assistant-step` row finds its text by `message_id`. Order `transcript` is the host's message
 * order, then part order (`ordinal`).
 */
export const trajectoryTranscriptColumns = {
  id: "text",
  ordinal: "int",
  message_id: "text",
  /** The old event kind: user, synthetic, assistant-text, tool, shell, compaction, session-idle, … */
  kind: "text",
  at: "float",
  /** The safe text (message text, shell command, tool name); "" when the kind has none. */
  text: "text",
  status: "text",
  tool: "text",
  /** The rest of the old event (input, result, output, error, model, …), already filtered. */
  body: "json",
} as const satisfies Columns
