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

test("lane: only gaps that dominate the span collapse, at most three, and ticks keep the width", () => {
  const minute = 60_000
  const hour = 60 * minute
  // LZ-232: calls from 0 to 48 minutes with quiet stretches of 1 to 17 minutes, then 1d 20h idle.
  const times = [0, 2, 3, 5, 7, 8, 9, 10, 27, 28, 30, 31, 33, 34, 36, 40, 48].map((m) => m * minute)
  const segments = laneLayout({
    ticks: times.map((at) => ({ at })),
    durationMs: 44 * hour,
  })
  expect(segments.map((s) => s.kind)).toEqual(["active", "idle"])
  const idle = segments[1]!
  expect(idle.kind === "idle" && idle.label).toBe("1d 19h idle")
  expect(idle.width).toBeLessThanOrEqual(12)
  expect(segments[0]!.width).toBeGreaterThan(85)
  // Four equal huge gaps: only the three largest collapse; the rest stays space.
  const gaps = laneLayout({
    ticks: [0, 10, 20, 30, 40].map((h) => ({ at: h * hour })),
    durationMs: 41 * hour,
  })
  expect(gaps.filter((s) => s.kind === "idle")).toHaveLength(3)
  expect(gaps.reduce((sum, s) => sum + s.width, 0)).toBeCloseTo(100, 6)
  // A small gap inside a long span is not collapsed at all.
  expect(
    laneLayout({ ticks: Array.from({ length: 16 }, (_, i) => ({ at: i * 4 * minute })) }).map(
      (s) => s.kind,
    ),
  ).toEqual(["active"])
})

test("lane: the selected call is still marked in a lane with a collapsed idle span", () => {
  const hour = 3_600_000
  const segments = laneLayout({
    ticks: [
      { at: 0, id: "a" },
      { at: 1000, id: "b" },
      { at: 20 * hour, id: "c" },
    ],
    selectedId: "c",
  })
  expect(segments.map((s) => s.kind)).toEqual(["active", "idle", "active"])
  const marks = segments.flatMap((s) => (s.kind === "active" ? s.marks : []))
  expect(marks.filter((m) => m.selected)).toHaveLength(1)
})
