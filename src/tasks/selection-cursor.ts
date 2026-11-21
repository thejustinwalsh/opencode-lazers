import { createHash } from "node:crypto"
import { normalizeTaskStateSelection } from "./state-selection.ts"
import type { TaskStateSelection } from "./state-filter.ts"

/** Legacy callers retain raw task-id markers; explicit sets bind their marker to the query. */
export function selectionCursor(
  query: {
    states?: TaskStateSelection[]
    state?: string
    includeCompleted: boolean
    search: string
    scopePath?: string
    sessionID?: string
    includeRetired: boolean
    sort: string
    cursor?: string
  },
  project: string,
) {
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        project,
        query.search,
        query.scopePath,
        query.sessionID,
        query.includeRetired,
        query.sort,
        query.states === undefined
          ? (query.state ?? (query.includeCompleted ? "all" : "legacy"))
          : normalizeTaskStateSelection(query.states),
      ]),
    )
    .digest("hex")
  let taskID = query.cursor
  if (query.cursor?.startsWith("states:")) {
    const decoded: unknown = JSON.parse(Buffer.from(query.cursor.slice(7), "base64url").toString())
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      decoded[0] !== identity ||
      typeof decoded[1] !== "string" ||
      query.states === undefined
    )
      throw new Error("Task cursor does not match this project, session, or filter")
    taskID = decoded[1]
  } else if (query.cursor && query.states !== undefined) {
    throw new Error("Task cursor does not match this project, session, or filter")
  }
  return {
    taskID,
    encode: (id: string) =>
      query.states === undefined
        ? id
        : `states:${Buffer.from(JSON.stringify([identity, id])).toString("base64url")}`,
  }
}
