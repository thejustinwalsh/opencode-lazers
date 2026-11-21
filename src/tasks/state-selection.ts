import type { TaskStateFilter, TaskStateSelection } from "./state-filter.ts"

const TASK_STATE_SELECTIONS: readonly TaskStateSelection[] = [
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
]

const stateOrder = new Map(TASK_STATE_SELECTIONS.map((state, index) => [state, index]))
const historyStates = new Set<TaskStateSelection>([
  "completed",
  "accepted",
  "integrated",
  "failed",
  "cancelled",
])

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

/** Keep set identity stable for persistence, query keys, and cursors regardless of toggle order. */
export function normalizeTaskStateSelection(
  states: readonly TaskStateSelection[],
): TaskStateSelection[] {
  return [...new Set(states)].toSorted(
    (left, right) => stateOrder.get(left)! - stateOrder.get(right)!,
  )
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
