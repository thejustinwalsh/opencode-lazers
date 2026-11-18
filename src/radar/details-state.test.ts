import { expect, test } from "bun:test"
import { detailsChange, storedDetails } from "./details-state.ts"

test("the pane is closed at 0.45 until something is stored", () => {
  expect(storedDetails({}, "monitor")).toEqual({ open: false, size: 0.45 })
  expect(storedDetails({}, "flow")).toEqual({ open: false, size: 0.45 })
})

test("an old divider position becomes the body size; a stored size wins", () => {
  expect(storedDetails({ monitorSplit: 60 }, "monitor")).toEqual({ open: false, size: 0.4 })
  expect(storedDetails({ split: 55 }, "lifecycle")).toEqual({ open: false, size: 0.45 })
  expect(storedDetails({ split: 30 }, "lifecycle").size).toBeCloseTo(0.7)
  // The Monitor split does not size the other views.
  expect(storedDetails({ monitorSplit: 60 }, "flow").size).toBe(0.45)
  expect(
    storedDetails({ monitorSplit: 60, details: { monitor: { open: true, size: 0.6 } } }, "monitor"),
  ).toEqual({ open: true, size: 0.6 })
})

test("each view keeps its own pane and collapsing leaves the size alone", () => {
  const opened = detailsChange({}, "map", { open: true, size: 0.55 })
  expect(opened.details.map).toEqual({ open: true, size: 0.55 })
  const collapsed = detailsChange(opened, "map", { open: false })
  expect(collapsed.details.map).toEqual({ open: false, size: 0.55 })
  expect(storedDetails(collapsed, "map")).toEqual({ open: false, size: 0.55 })
  expect(storedDetails(collapsed, "monitor").open).toBe(false)
})
