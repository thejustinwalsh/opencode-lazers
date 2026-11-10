import { expect, test } from "bun:test"
import { sourcePlanLine } from "./presentation.ts"

test("source plan jumps follow the current heading and retain an optional line fallback", () => {
  expect(
    sourcePlanLine(
      { section: "Phase 2", line: 2 },
      "# Roadmap\n\nNew material\n\n## Phase 2\nBuild it",
    ),
  ).toBe(5)
  expect(sourcePlanLine({ section: "Missing", line: 8 }, "# Roadmap")).toBe(8)
  expect(sourcePlanLine({}, "# Roadmap")).toBeUndefined()
})
