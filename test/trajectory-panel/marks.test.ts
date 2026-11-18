import { expect, test } from "bun:test"
import { rulerLabels, slowSeconds } from "../../src/trajectory-panel/panel-layout.ts"
import {
  MIN_GAP_PX,
  SPAN_MIN_PX,
  isSpanWidth,
  layoutMarks,
} from "../../src/trajectory-panel/marks.ts"

const PLOT = 400
/** Percent of the plot that is `px` wide. */
const pct = (px: number) => (px / PLOT) * 100

test("an instant or a call narrower than a span is a tick; a recorded duration is a span", () => {
  const glyphs = layoutMarks(
    [
      { id: "instant", left: 10, width: 0 },
      { id: "short", left: 30, width: pct(SPAN_MIN_PX - 1) },
      { id: "long", left: 50, width: pct(40) },
    ],
    PLOT,
  )
  expect(glyphs.map((glyph) => [glyph.members[0]!.id, glyph.shape])).toEqual([
    ["instant", "tick"],
    ["short", "tick"],
    ["long", "span"],
  ])
  expect(isSpanWidth(pct(SPAN_MIN_PX), PLOT)).toBe(true)
  expect(isSpanWidth(pct(SPAN_MIN_PX - 0.5), PLOT)).toBe(false)
})

test("marks keep a clear gap: at the minimum they stay distinct, closer they merge into one run", () => {
  const apart = layoutMarks(
    [
      { id: "a", left: pct(100), width: 0 },
      // Ticks are 2 px wide, so centres 2 + MIN_GAP_PX apart leave exactly the minimum gap.
      { id: "b", left: pct(100 + 2 + MIN_GAP_PX), width: 0 },
    ],
    PLOT,
  )
  expect(apart.map((glyph) => glyph.shape)).toEqual(["tick", "tick"])

  const close = layoutMarks(
    [
      { id: "a", left: pct(100), width: 0 },
      { id: "b", left: pct(100 + 2 + MIN_GAP_PX - 1), width: 0 },
      { id: "c", left: pct(100 + 2 * (2 + MIN_GAP_PX - 1)), width: 0 },
    ],
    PLOT,
  )
  expect(close).toHaveLength(1)
  expect(close[0]!.shape).toBe("run")
  expect(close[0]!.members.map((member) => member.id)).toEqual(["a", "b", "c"])
})

test("overlapping spans merge into one run covering their union", () => {
  const glyphs = layoutMarks(
    [
      { id: "first", left: pct(20), width: pct(40) },
      { id: "second", left: pct(50), width: pct(40) },
      { id: "later", left: pct(200), width: pct(30) },
    ],
    PLOT,
  )
  expect(glyphs.map((glyph) => glyph.shape)).toEqual(["run", "span"])
  expect(glyphs[0]!.startPx).toBeCloseTo(20)
  expect(glyphs[0]!.endPx).toBeCloseTo(90)
})

test("a failed call stays red inside a merged run", () => {
  const [run] = layoutMarks(
    [
      { id: "ok", left: pct(100), width: 0 },
      { id: "bad", left: pct(101), width: 0, failed: true },
    ],
    PLOT,
  )
  expect(run!.shape).toBe("run")
  expect(run!.failed).toBe(false)
  expect(run!.members.filter((member) => member.failed).map((member) => member.id)).toEqual(["bad"])
  const [alone] = layoutMarks([{ id: "bad", left: 10, width: 0, failed: true }], PLOT)
  expect(alone!.failed).toBe(true)
})

const ticks = ["0s", "30s", "1m", "1m30s", "2m"].map((label, index) => ({
  elapsedMs: index * 30_000,
  label,
}))
const linear = (elapsedMs: number) => (elapsedMs / 120_000) * 100

test("an idle label wins its place on the ruler; a tick label that would touch it is dropped", () => {
  // 1m is at 50 % of 600 px; a "1m32s idle" label centred there covers it.
  const idle = { startMs: 50_000, endMs: 70_000, left: 46, width: 8, label: "1m32s idle" }
  const result = rulerLabels(ticks, [idle], 120_000, 600, linear)
  expect(result.breaks).toEqual([idle])
  expect(result.ticks.map((tick) => tick.label)).not.toContain("1m")
  expect(result.ticks.map((tick) => tick.label)).toContain("0s")
})

test("only one of two colliding idle labels is shown, the longer break; the band stays", () => {
  const long = { startMs: 10_000, endMs: 70_000, left: 40, width: 6, label: "1m idle" }
  const short = { startMs: 80_000, endMs: 90_000, left: 44, width: 6, label: "10s idle" }
  const result = rulerLabels([], [long, short], 120_000, 600, linear)
  expect(result.breaks).toEqual([long])
})

test("a label that does not fit the plot is dropped and its ticks stay", () => {
  const edge = { startMs: 0, endMs: 60_000, left: 0, width: 1, label: "1m32s idle" }
  const result = rulerLabels(ticks, [edge], 120_000, 600, linear)
  expect(result.breaks).toEqual([])
  expect(result.ticks.length).toBeGreaterThan(0)
})

test("the slow-load seconds come from the shared status line", () => {
  expect(slowSeconds("Still loading · 40 s")).toBe(40)
  expect(slowSeconds("Loading this trajectory")).toBeNull()
})
