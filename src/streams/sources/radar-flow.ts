import { defineSource, type StreamContext } from "../source.ts"
import {
  RADAR_FLOW_SOURCES,
  radarStepColumns,
  radarTranscriptColumns,
  type RadarStepsFilter,
  type RadarTranscriptsFilter,
} from "./radar-flow-ref.ts"
import type { RadarScope } from "./radar-ref.ts"

/**
 * The Monitor's model phases over the stored transcript metadata (`src/transcript-meta/schema.ts`).
 *
 * Scope checks carried over from the Radar's `authorize` (`src/observability/rpc.ts`): the
 * caller's session may read this project (`context.assertRead`), the project is the service's own
 * directory whatever the caller sent, and a session view reads only its own session and that
 * session's children (as `radar.sessions` lists them).
 */
async function checked<F extends { scope: RadarScope; projectDirectory: string }>(
  input: F,
  context: StreamContext,
  sessionIDs: readonly string[],
): Promise<F> {
  const scope = input.scope
  if (!scope?.sessionID || !["session", "project", "all"].includes(scope.kind))
    throw new Error("A Radar read names its scope")
  await context.assertRead(scope.sessionID)
  const projectDirectory = context.projectDirectory
  if (scope.kind === "session") {
    const others = sessionIDs.filter((id) => id !== scope.sessionID)
    const children = new Set(
      others.length && context.read
        ? context.read((db) =>
            db
              .query<{ session_id: string }, [string, string]>(
                `SELECT session_id FROM host_session_state
                 WHERE project_directory=? AND parent_session_id=?`,
              )
              .all(projectDirectory, scope.sessionID)
              .map((row) => row.session_id),
          )
        : [],
    )
    if (others.some((id) => !children.has(id)))
      throw new Error("Selected session is unavailable in this project scope")
  }
  return { ...input, projectDirectory }
}

/** One session's steps, newest first, through `transcript_steps_order`. */
export const radarStepsSource = defineSource({
  name: RADAR_FLOW_SOURCES.steps,
  table: "transcript_steps",
  key: ["id"],
  orders: {
    recent: [
      { column: "ordinal", direction: "desc" },
      { column: "id", direction: "desc" },
    ],
  },
  authorize: (input: RadarStepsFilter, context) => checked(input, context, [input.sessionID]),
  filter: (input: RadarStepsFilter) => ({
    where: "project_directory = ? AND session_id = ?",
    params: [input.projectDirectory, input.sessionID],
  }),
  columns: radarStepColumns,
})

/**
 * The read state of the listed sessions (the unique key's index): one row per session the fold has
 * seen. A session with no row is not read yet.
 */
export const radarTranscriptsSource = defineSource({
  name: RADAR_FLOW_SOURCES.transcripts,
  table: "transcript_sessions",
  key: ["id"],
  orders: { key: [{ column: "id", direction: "asc" }] },
  authorize: (input: RadarTranscriptsFilter, context) =>
    checked(input, context, input.sessionIDs ?? []),
  filter(input: RadarTranscriptsFilter) {
    const ids = input.sessionIDs ?? []
    if (ids.length === 0) return { where: "0", params: [] }
    return {
      where: `project_directory = ? AND session_id IN (${ids.map(() => "?").join(",")})`,
      params: [input.projectDirectory, ...ids],
    }
  },
  columns: radarTranscriptColumns,
  count: { exact: "scan" },
})
