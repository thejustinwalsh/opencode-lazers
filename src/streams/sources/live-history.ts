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
  filter(input: LiveHistoryFilter) {
    const clauses = ["project_directory = ?", "attempt_id = ?", "session_id = ?"]
    const params: (string | number)[] = [input.projectDirectory, input.attemptID, input.sessionID]
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
