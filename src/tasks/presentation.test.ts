import { expect, test } from "bun:test"
import { sourcePlanLine, taskHeading, taskReasonView } from "./presentation.ts"

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

test("runtime reasons read as user sentences with the raw text kept for Details", () => {
  const raw =
    "Native idle background observation is unknown: Native session.inbox.delivered was observed after the last experimental.idle background report"
  const view = taskReasonView(raw)
  expect(view.text).toBe(
    "Worker was interrupted by the service restart. Resumes when the runtime confirms the session is idle.",
  )
  expect(view.raw).toBe(raw)
  expect(taskReasonView("Waiting on LZ-12 (running)")).toEqual({
    text: "Waiting on LZ-12 (running)",
  })
})

test("no mapped or unmapped reason shows 'unknown'", () => {
  for (const raw of [
    "Native idle background observation is unknown: No experimental.idle background report was observed",
    "Session state is unknown after restart",
    "Something else is Unknown here\nsecond line",
    "Interrupted setup has unknown installer activity in /tmp/x; preserve its resources",
  ])
    expect(taskReasonView(raw).text).not.toMatch(/unknown/i)
})

test("the heading keeps the whole first sentence", () => {
  const long = `${"word ".repeat(30)}end. Second sentence.`
  expect(taskHeading(long)).toBe(`${"word ".repeat(30)}end.`)
})
