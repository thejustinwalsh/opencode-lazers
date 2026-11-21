import type { Columns } from "../frame.ts"
import type { RadarScope } from "./radar-ref.ts"

/**
 * `radar.sessions`: the live OpenCode facts of a project's sessions (`host_session_state`), the
 * part a consumer without a database needs. The GUI imports this file and builds its
 * `sourceRef` from these columns.
 */
export const RADAR_SESSIONS_SOURCE = "radar.sessions"

/**
 * The project is set by the service. A session view reads its own session and that session's
 * children (the calls its subagents make), whatever `sessionID` says; a project view reads every
 * session, or with `sessionID` that one and its children. Archived sessions are left out unless
 * asked for.
 */
export type RadarSessionsFilter = {
  projectDirectory: string
  scope: RadarScope
  sessionID?: string
  includeArchived?: boolean
}

export const radarSessionColumns = {
  id: "int",
  session_id: "text",
  /** `architect` (agent architect), `worker` (a runner attempt's session) or `unmanaged`. */
  role: "text",
  agent: "text",
  attempt_id: "text",
  task_id: "text",
  parent_session_id: "text",
  /** The checkout the session works in (a worker's worktree). */
  directory: "text",
  busy: "bool",
  pending_input: "bool",
  pending_permissions: "int",
  pending_forms: "int",
  /** The host's outcome of the last execution: succeeded, failed or interrupted; null before one. */
  outcome: "text",
  archived: "bool",
  /** The session's selected model. */
  route_provider: "text",
  route_model: "text",
  route_variant: "text",
  /** Cumulative input and output tokens the host reports. */
  tokens_in: "int",
  tokens_out: "int",
  created_at: "int",
  /** When a shown column last changed (the order key). */
  updated_at: "int",
  /** The host's `time.updated`. */
  host_updated_at: "int",
} as const satisfies Columns
