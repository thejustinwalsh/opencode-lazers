import { expect, test } from "bun:test"
import { hasCompareLowerPane, showTaskChip } from "./panel-shared.ts"
import { formatPriceRange } from "./comparison-presentation.ts"

test("the task chip shows only when a task was chosen as a filter", () => {
  // The first task opens by default for the detail below; that is not a filter.
  expect(showTaskChip({}, "LZ-234")).toBe(false)
  expect(showTaskChip({ taskFilter: false }, "LZ-234")).toBe(false)
  // A chosen filter with no task to name has nothing to show.
  expect(showTaskChip({ taskFilter: true }, undefined)).toBe(false)
  expect(showTaskChip({ taskFilter: true }, "LZ-234")).toBe(true)
})

test("Compare has a lower pane only when there is a model to inspect", () => {
  const input = { contentShown: true, benchmark: false, benchmarkNeedsOpenRouter: false }
  expect(hasCompareLowerPane(input)).toBe(true)
  // The one loading surface and the failure sentence are whole-panel states.
  expect(hasCompareLowerPane({ ...input, contentShown: false })).toBe(false)
  // The Benchmark empty state is whole-panel; a Your runs view is unaffected by it.
  expect(hasCompareLowerPane({ ...input, benchmark: true, benchmarkNeedsOpenRouter: true })).toBe(
    false,
  )
  expect(hasCompareLowerPane({ ...input, benchmarkNeedsOpenRouter: true })).toBe(true)
  expect(hasCompareLowerPane({ ...input, benchmark: true })).toBe(true)
})

test("a price range reads as one amount with the dollar sign once", () => {
  expect(formatPriceRange({ minimum: 0.35, maximum: 0.67 })).toBe("$0.35 – 0.67")
  expect(formatPriceRange({ minimum: 1.2, maximum: 14 })).toBe("$1.2 – 14")
  // Equal ends are one price, not a range.
  expect(formatPriceRange({ minimum: 0.35, maximum: 0.35 })).toBe("$0.35")
})
