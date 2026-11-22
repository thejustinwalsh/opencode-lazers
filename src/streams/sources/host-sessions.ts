import { defineSource } from "../source.ts"
import {
  RADAR_SESSIONS_SOURCE,
  radarSessionColumns,
  type RadarSessionsFilter,
} from "./host-sessions-ref.ts"

/**
 * `radar.sessions` over `host_session_state` (kept by the host session fold,
 * `src/host-sessions/fold.ts`): newest change first, through `host_session_state_recent`, or the
 * parent index for a session and its children.
 *
 * Scope checks carried over from the Radar's `authorize` (`src/observability/rpc.ts`): the
 * caller's session may read this project (`context.assertRead`), and the project is the service's
 * own directory, whatever the caller sent. Foreign sessions are never stored, so the read needs
 * no project id check.
 */
export const radarSessionsSource = defineSource({
  name: RADAR_SESSIONS_SOURCE,
  table: "host_session_state",
  key: ["id"],
  orders: {
    recent: [
      { column: "updated_at", direction: "desc" },
      { column: "id", direction: "desc" },
    ],
  },
  async authorize(input: RadarSessionsFilter, context) {
    const scope = input.scope
    if (!scope?.sessionID || !["session", "project", "all"].includes(scope.kind))
      throw new Error("A Radar read names its scope")
    await context.assertRead(scope.sessionID)
    return {
      ...input,
      projectDirectory: context.projectDirectory,
      ...(scope.kind === "session" ? { sessionID: scope.sessionID } : {}),
    }
  },
  filter(input: RadarSessionsFilter) {
    const clauses = ["project_directory = ?"]
    const params: string[] = [input.projectDirectory]
    if (input.sessionID !== undefined) {
      clauses.push("(session_id = ? OR parent_session_id = ?)")
      params.push(input.sessionID, input.sessionID)
    }
    if (!input.includeArchived) clauses.push("archived = 0")
    return { where: clauses.join(" AND "), params }
  },
  columns: radarSessionColumns,
})
