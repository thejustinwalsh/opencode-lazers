import { expect, test } from "bun:test"
import { normalizeTaskStateSelection, taskStateSelectionLabel } from "./state-selection.ts"

test("multi-state trigger labels are exact, order-independent sets", () => {
  const cases = [
    [["running", "queued"], "Motive"],
    [["blocked", "paused"], "Snags"],
    [["blocked", "failed"], "Rescue"],
    [["running", "blocked"], "Pulse"],
    [["queued", "paused"], "Runway"],
    [["running", "queued", "blocked", "paused"], "Flight"],
    [["completed", "cancelled"], "Archive"],
    [["completed", "failed", "cancelled"], "Aftermath"],
  ] as const

  for (const [states, label] of cases) {
    expect(taskStateSelectionLabel(states)).toBe(label)
    expect(taskStateSelectionLabel([...states].reverse())).toBe(label)
  }
})

test("empty, single, supersets and unmatched sets retain descriptive filter labels", () => {
  expect(taskStateSelectionLabel([])).toBe("All")
  expect(taskStateSelectionLabel(["blocked"])).toBe("Blocked / waiting")
  expect(taskStateSelectionLabel(["failed"])).toBe("Failed / exhausted")
  expect(taskStateSelectionLabel(["open", "queued"])).toBe("Flow")
  expect(taskStateSelectionLabel(["completed", "failed"])).toBe("History")
  expect(taskStateSelectionLabel(["running", "completed"])).toBe("Mix")
  expect(taskStateSelectionLabel(["running", "queued", "completed"])).toBe("Mix")
})

test("equivalent sets normalize to stable state identity and remove duplicates", () => {
  expect(normalizeTaskStateSelection(["running", "queued", "running"])).toEqual([
    "queued",
    "running",
  ])
  expect(normalizeTaskStateSelection(["queued", "running"])).toEqual(
    normalizeTaskStateSelection(["running", "queued"]),
  )
})
