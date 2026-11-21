import type { TaskQueryState, TaskStateFilter, TaskStateSelection } from "./state-filter.ts"
import { effectiveTaskStateFilter, taskStatePredicate } from "./state-filter.ts"

export const TASK_STATE_SELECTIONS: readonly TaskStateSelection[] = [
  "open",
  "queued",
  "running",
  "blocked",
  "paused",
  "completed",
  "failed",
  "cancelled",
]

const stateOrder = new Map(TASK_STATE_SELECTIONS.map((state, index) => [state, index]))
const historyStates = new Set<TaskStateSelection>(["completed", "failed", "cancelled"])

const combinationLabels: readonly {
  states: readonly TaskStateSelection[]
  label: string
}[] = [
  { states: ["running", "queued"], label: "Motive" },
  { states: ["blocked", "paused"], label: "Snags" },
  { states: ["blocked", "failed"], label: "Rescue" },
  { states: ["running", "blocked"], label: "Pulse" },
  { states: ["queued", "paused"], label: "Runway" },
  { states: ["running", "queued", "blocked", "paused"], label: "Flight" },
  { states: ["completed", "cancelled"], label: "Archive" },
  { states: ["completed", "failed", "cancelled"], label: "Aftermath" },
]

export type TaskStateSelectionQuery = TaskQueryState | readonly TaskStateSelection[]

/** Keep set identity stable for persistence, query keys, and cursors regardless of toggle order. */
export function normalizeTaskStateSelection(
  states: readonly TaskStateSelection[],
): TaskStateSelection[] {
  return [...new Set(states)].toSorted(
    (left, right) => stateOrder.get(left)! - stateOrder.get(right)!,
  )
}

/** SQL predicate for a set of state groups. Empty means unrestricted All. */
export function taskStateSelectionPredicate(
  states: readonly TaskStateSelection[],
  alias: "tasks" | "t",
): string {
  const predicates = normalizeTaskStateSelection(states)
    .map((state) => taskStatePredicate(state, alias))
    .filter(Boolean)
  // Keep the union below the caller's other predicates, especially keyset boundaries.
  return predicates.length ? `(${predicates.join(" OR ")})` : ""
}

export function effectiveTaskStateSelection(
  states: readonly TaskStateSelection[] | undefined,
  state: TaskQueryState | undefined,
  includeCompleted: boolean | undefined,
): TaskStateSelectionQuery {
  return states === undefined
    ? effectiveTaskStateFilter(state, includeCompleted)
    : normalizeTaskStateSelection(states)
}

/** Preserve old cursor identities for old callers; explicit sets have a distinct, canonical tag. */
export function taskStateSelectionIdentity(selection: TaskStateSelectionQuery) {
  return Array.isArray(selection) ? { states: selection } : selection
}

export function taskStateSelectionPredicateForQuery(
  selection: TaskStateSelectionQuery,
  alias: "tasks" | "t",
): string {
  return Array.isArray(selection)
    ? taskStateSelectionPredicate(selection, alias)
    : taskStatePredicate(selection as TaskQueryState, alias)
}

export function taskStateLabel(state: TaskStateFilter): string {
  if (state === "failed") return "Failed / exhausted"
  if (state === "blocked") return "Blocked / waiting"
  return state[0]!.toUpperCase() + state.slice(1)
}

/** Trigger-only short labels; selected state identities remain exact and unchanged. */
export function taskStateSelectionLabel(states: readonly TaskStateSelection[]): string {
  const selected = normalizeTaskStateSelection(states)
  if (selected.length === 0) return "All"
  if (selected.length === 1) return taskStateLabel(selected[0]!)

  const exact = combinationLabels.find(
    (combo) =>
      combo.states.length === selected.length &&
      combo.states.every((state) => selected.includes(state)),
  )
  if (exact) return exact.label

  const hasHistory = selected.some((state) => historyStates.has(state))
  const hasCurrent = selected.some((state) => !historyStates.has(state))
  return hasCurrent && hasHistory ? "Mix" : hasCurrent ? "Flow" : "History"
}
