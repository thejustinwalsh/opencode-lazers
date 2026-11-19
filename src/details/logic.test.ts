import { expect, test } from "bun:test"
import { laneLayout } from "./lane.ts"
import { progressSteps } from "./progress.ts"

test("progress marks passed, current (with its tone) and later", () => {
  const steps = progressSteps(["Queued", "Working", "Checks", "Review", "Integrated"], 1, "warning")
  expect(steps.map((s) => s.state)).toEqual(["passed", "current", "later", "later", "later"])
  expect(steps[1]?.tone).toBe("warning")
  expect(steps[0]?.tone).toBeUndefined()
})

test("green is only allowed on the final step", () => {
  const mid = progressSteps(["a", "b", "c"], 1, "success")
  expect(mid[1]?.tone).toBe("interactive")
  const done = progressSteps(["a", "b", "c"], 2, "success")
  expect(done.map((s) => s.state)).toEqual(["passed", "passed", "current"])
  expect(done[2]?.tone).toBe("success")
  expect(progressSteps(["a", "b"], 9, "success")[1]?.tone).toBe("success")
})

test("nothing started: every step is later", () => {
  expect(progressSteps(["a", "b"], -1).map((s) => s.state)).toEqual(["later", "later"])
})

test("lane: a long quiet stretch collapses to one labelled idle span", () => {
  const hour = 3_600_000
  const segments = laneLayout({
    ticks: [
      { at: 0 },
      { at: 1000 },
      { at: 2000, failed: true },
      { at: 20 * hour },
      { at: 20 * hour + 500 },
    ],
    durationMs: 20 * hour + 1000,
  })
  expect(segments.map((s) => s.kind)).toEqual(["active", "idle", "active"])
  const idle = segments[1]!
  expect(idle.kind === "idle" && idle.label).toBe("19h 59m idle")
  expect(segments.reduce((sum, s) => sum + s.width, 0)).toBeCloseTo(100, 6)
  const first = segments[0]!
  expect(first.kind === "active" && first.marks.some((m) => m.failed)).toBe(true)
})

test("lane: no idle span for a dense run, and a lone leading gap is labelled", () => {
  expect(laneLayout({ ticks: [{ at: 0 }, { at: 30_000 }] }).map((s) => s.kind)).toEqual(["active"])
  expect(laneLayout({ ticks: [{ at: 600_000 }] }).map((s) => s.kind)).toEqual(["idle", "active"])
  expect(laneLayout({ ticks: [] })).toEqual([])
})

test("lane: thousands of ticks stay bounded and keep failures and the selection", () => {
  const ticks = Array.from({ length: 20_000 }, (_, i) => ({
    at: i * 5,
    failed: i === 777,
    id: `t${i}`,
  }))
  const started = performance.now()
  const segments = laneLayout({ ticks, maxMarks: 120, selectedId: "t15000" })
  expect(performance.now() - started).toBeLessThan(500)
  const marks = segments.flatMap((s) => (s.kind === "active" ? s.marks : []))
  expect(marks.length).toBeLessThanOrEqual(120)
  expect(marks.reduce((n, m) => n + m.count, 0)).toBe(20_000)
  expect(marks.filter((m) => m.failed)).toHaveLength(1)
  expect(marks.filter((m) => m.selected)).toHaveLength(1)
})
