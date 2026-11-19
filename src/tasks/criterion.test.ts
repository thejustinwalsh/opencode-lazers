import { expect, test } from "bun:test"
import { CRITERION_LINE_MAX, criterionLine, humanizeIdentifier } from "./criterion.ts"

test("a criterion with evidence reads as its humanized evidence name", () => {
  expect(
    criterionLine({
      id: "restart-runs-same-worker",
      assertion: "A production runtime fixture progresses that same attempt to running.",
      evidence: [{ kind: "verification", verificationID: "restart" }],
    }),
  ).toBe("Restart runs same worker")
  expect(humanizeIdentifier("once-only")).toBe("Once only")
})

test("a criterion without evidence reads as its first clause, cut at a word boundary", () => {
  expect(
    criterionLine({
      id: "a",
      assertion: "The list shows one row per task. Everything else is detail.",
      evidence: [],
    }),
  ).toBe("The list shows one row per task")
  const long = criterionLine({
    id: "b",
    assertion: `${"Repeated restarts and lost delivery responses never deliver a second continuation ".repeat(2)}.`,
    evidence: [],
  })
  expect(long.length).toBeLessThanOrEqual(CRITERION_LINE_MAX)
  expect(long.endsWith("…")).toBe(true)
  expect(long).not.toMatch(/\s…$/)
  expect(long.slice(0, -1)).toBe(
    "Repeated restarts and lost delivery responses never deliver a second",
  )
})

test("a short first clause keeps going past a leading comma", () => {
  expect(
    criterionLine({ id: "c", assertion: "Yes, and the pane keeps its width", evidence: [] }),
  ).toBe("Yes, and the pane keeps its width")
})
