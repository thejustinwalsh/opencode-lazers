import { defineSource } from "../source.ts"
import {
  LIVE_HISTORY_SOURCE,
  liveHistoryColumns,
  type LiveHistoryFilter,
} from "./live-history-ref.ts"

/**
 * `observability.liveHistory`: the progress rows of one attempt, newest first, as the live
 * history list shows them. It reads `runner_progress_display` only (the display each progress
 * row stores when it is written), so a reader never touches a payload. Counts are exact: the
 * list sizes its scroll from them, and the count walks one covering index range.
 *
 * Which attempt belongs to which session, and whether a revision moved, stay with the consumer
 * as point reads (the live read already carries the attempt of each session).
 */
export const liveHistorySource = defineSource({
  name: LIVE_HISTORY_SOURCE,
  table: "runner_progress_display",
  tables: ["runner_progress_display"],
  key: ["seq"],
  orders: { recent: [{ column: "seq", direction: "desc" }] },
  /**
   * What the replaced `liveHistory` read checked, kept: the caller's session may read this
   * project (permission), a session view reads only its own session, and the rows are the
   * project's (this service's directory, and any OpenCode project id the project is known by).
   * What the caller sent for the directory and ids is overwritten.
   */
  async authorize(input, context) {
    if (input.scope.kind === "session" && input.sessionID !== input.scope.sessionID)
      throw new Error("Selected session history is unavailable in this project scope")
    await context.assertRead(input.scope.sessionID)
    return {
      ...input,
      projectDirectory: context.projectDirectory,
      projectIDs: context.projectIds(context.projectID),
    }
  },
  filter(input: LiveHistoryFilter) {
    // Fails closed: only `authorize` sets the project ids, so a filter without them is refused.
    if (!input.projectIDs) throw new Error("The live history filter carries no project ids")
    const clauses = [
      "project_directory = ?",
      "attempt_id = ?",
      "session_id = ?",
      "project_id IN (SELECT value FROM json_each(?))",
    ]
    const params: (string | number)[] = [
      input.projectDirectory,
      input.attemptID,
      input.sessionID,
      JSON.stringify(input.projectIDs),
    ]
    if (input.toolsOnly) clauses.push("tool IS NOT NULL")
    if (input.beforeAt !== undefined) {
      clauses.push("at < ?")
      params.push(input.beforeAt)
    }
    return { where: clauses.join(" AND "), params }
  },
  columns: liveHistoryColumns,
  count: { exact: "scan" },
})
