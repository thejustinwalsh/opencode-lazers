import { z } from "zod"

export const TaskStateFilter = z.enum([
  "open",
  "queued",
  "running",
  "blocked",
  "paused",
  "completed",
  "accepted",
  "integrated",
  "failed",
  "cancelled",
  "all",
])
export type TaskStateFilter = z.infer<typeof TaskStateFilter>
export const TaskStateSelection = z.enum([
  "open",
  "queued",
  "running",
  "blocked",
  "paused",
  "completed",
  "accepted",
  "integrated",
  "failed",
  "cancelled",
])
export type TaskStateSelection = z.infer<typeof TaskStateSelection>
export type TaskQueryState = TaskStateFilter | "legacy"

/** Keep the pre-filter query contract distinct from the new explicit `open` filter. */
export function effectiveTaskStateFilter(
  state: TaskQueryState | undefined,
  includeCompleted: boolean | undefined,
): TaskQueryState {
  return state ?? (includeCompleted ? "all" : "legacy")
}

/** Old Tasks preferences had only a history toggle; true meant include every execution state. */
export function preferredTaskStateFilter(
  state: TaskStateFilter | undefined,
  history: boolean | undefined,
): TaskStateFilter {
  // "Completed" was accepted plus integrated. Neither new filter alone holds both, and All is the
  // smallest filter that still lists every task Completed did.
  if (state === "completed") return "all"
  return state ?? (history ? "all" : "open")
}
