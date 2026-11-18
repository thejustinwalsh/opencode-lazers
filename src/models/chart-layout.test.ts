import { expect, test } from "bun:test"
import {
  buildScale,
  chartHeight,
  clusterPoints,
  fanOut,
  formatAxisMoney,
  formatAxisTokens,
  layoutChart,
  layoutRanking,
  RANK_ROW_HEIGHT,
  RANK_VISIBLE_ROWS,
  truncateText,
  LOG_RATIO,
  nextPointID,
  niceAxis,
  paretoFrontier,
  placeLabels,
} from "./chart-layout.ts"
import type { ChartDatum } from "./chart-layout.ts"

const datum = (id: string, x: number, y: number, frontier = false): ChartDatum => ({
  id,
  x,
  y,
  label: id,
  frontier,
})

test("axes end at the next round tick above the data, so points spread across the plot", () => {
  // 0, 5M, 10M, 15M, 20M for a 17M maximum; $0 to $4 for a $3.4 maximum.
  expect(niceAxis(17_000_000 * 1.06, 4)).toEqual({ max: 20_000_000, interval: 5_000_000 })
  expect(niceAxis(3.4, 4)).toEqual({ max: 4, interval: 1 })
  // The owner's live data: a $4.1 maximum ends at $5, not $6; 30M ends at 40M, not 60M.
  expect(niceAxis(4.1 * 1.08, 4).max).toBe(5)
  expect(niceAxis(30_000_000 * 1.06, 4).max).toBe(40_000_000)
  expect(niceAxis(0, 4).interval).toBe(1)
  for (const [maximum, intervals] of [
    [0.9, 4],
    [123, 4],
    [4_800_000, 3],
    [33_000_000, 4],
  ] as const) {
    const axis = niceAxis(maximum, intervals)
    expect(axis.max).toBeGreaterThanOrEqual(maximum)
    expect(axis.max / axis.interval).toBeLessThanOrEqual(intervals + 2)
  }
  expect([0, 1, 2.5, 0.5, 0.125].map(formatAxisMoney)).toEqual([
    "$0",
    "$1",
    "$2.50",
    "$0.50",
    "$0.125",
  ])
  expect(formatAxisTokens(5_000_000)).toBe("5M")
})

test("x switches to a log scale only when max over min exceeds 50", () => {
  const options = (values: number[]) => ({
    values,
    scale: "auto-log" as const,
    intervals: 4,
    format: formatAxisTokens,
    headroom: 0.06,
  })
  const linear = buildScale(options([2_000_000, 2_000_000 * LOG_RATIO]))
  expect(linear.kind).toBe("linear")
  const log = buildScale(options([2_000_000, 2_000_000 * LOG_RATIO * 1.5]))
  expect(log.kind).toBe("log")
  expect(log.min).toBe(1_000_000)
  expect(log.ticks.map((tick) => tick.label)).toEqual(["1M", "3M", "10M", "30M", "100M", "300M"])
  // A log axis ends at the first tick that covers the data, and places decades at equal steps.
  expect(log.at(1_000_000)).toBe(0)
  expect(log.max).toBe(300_000_000)
  expect(log.at(300_000_000)).toBe(1)
  expect(log.at(10_000_000)).toBeCloseTo(1 / Math.log10(300))
  // Never log for a linear-only axis, or when a value is zero.
  expect(buildScale({ ...options([10, 100_000]), scale: "linear" }).kind).toBe("linear")
  expect(buildScale(options([0, 100_000])).kind).toBe("linear")
})

test("plot height follows the width: clamp(width x 0.48, 220, 360)", () => {
  expect(chartHeight(300)).toBe(220)
  expect(chartHeight(474)).toBe(228)
  expect(chartHeight(760)).toBe(360)
  expect(chartHeight(1400)).toBe(360)
})

test("the layout fits the data and joins the frontier left to right", () => {
  const layout = layoutChart({
    width: 474,
    points: [
      datum("qwen", 2_300_000, 0.3, true),
      datum("luna", 6_200_000, 0.5, true),
      datum("kimi", 10_500_000, 1.4, true),
      datum("terra", 17_000_000, 1.9),
    ],
    selectedID: "luna",
    xScale: "auto-log",
    formatX: formatAxisTokens,
    formatY: formatAxisMoney,
  })
  expect(layout.height).toBe(228)
  expect(layout.xScale.kind).toBe("linear")
  expect(layout.xScale.max).toBe(20_000_000)
  expect(layout.yScale.max).toBeLessThanOrEqual(3)
  // The largest point sits in the upper right of the plot, not the lower left.
  const terra = layout.points.find((point) => point.id === "terra")!
  expect(terra.cx).toBeGreaterThan(layout.plot.left + (layout.plot.right - layout.plot.left) * 0.7)
  expect(terra.cy).toBeLessThan(layout.plot.top + (layout.plot.bottom - layout.plot.top) * 0.4)
  expect(layout.frontierPath.match(/L/g)).toHaveLength(2)
  expect(layout.frontierPath.startsWith("M")).toBe(true)
  // The selected point's label goes above it.
  expect(layout.points.find((point) => point.id === "luna")!.place!.side).toBe("top")
  // Every point carries a label here.
  expect(layout.points.every((point) => point.place)).toBe(true)
})

test("a frontier of one point draws no line", () => {
  const layout = layoutChart({
    width: 474,
    points: [datum("only", 1, 1, true), datum("other", 2, 2)],
    selectedID: null,
    xScale: "linear",
    formatX: String,
    formatY: String,
  })
  expect(layout.frontierPath).toBe("")
})

test("label placement keeps the selection, then the frontier; the rest drop first", () => {
  const box = { left: 0, top: 0, right: 400, bottom: 200 }
  const item = (id: string, priority: number, cx = 200, cy = 100) => ({
    id,
    cx,
    cy,
    text: "Kimi K3.1 Pro",
    preferred: "right" as const,
    priority,
  })
  const crowd = placeLabels(
    [
      item("other-1", 2),
      item("other-2", 2),
      item("frontier", 1),
      item("other-3", 2),
      item("selected", 0),
    ],
    box,
  )
  expect(crowd.get("selected")?.side).toBe("right")
  expect(crowd.has("frontier")).toBe(true)
  expect(crowd.has("other-3")).toBe(false)
  expect(crowd.size).toBeLessThan(5)
  // A label near the right edge flips to the left of its point.
  expect(placeLabels([item("edge", 1, 395)], box).get("edge")?.side).toBe("left")
  // The selection is named above its point when there is room; the others do not cover a mark.
  const named = placeLabels(
    [{ ...item("sel", 0), preferred: "top" as const, text: "GPT-6 Luna · max" }],
    box,
  )
  expect(named.get("sel")?.side).toBe("top")
  expect(named.get("sel")?.anchor).toBe("middle")
  const blocked = placeLabels([item("first", 1, 100, 100), item("blocker", 1, 112, 100)], box)
  expect(blocked.get("first")?.side).not.toBe("right")
  // Even a crowded selection is named.
  const forced = placeLabels(
    [item("sel", 0, 5, 5), ...Array.from({ length: 4 }, (_, index) => item(`m${index}`, 2, 6, 6))],
    { left: 0, top: 0, right: 40, bottom: 20 },
  )
  expect(forced.has("sel")).toBe(true)
})

test("the Pareto set drops dominated models and ignores a measure that is missing", () => {
  type Model = { id: string; cost: number; tokens: number; rate: number | null }
  const models: Model[] = [
    { id: "cheap", cost: 0.2, tokens: 7, rate: 0.67 },
    { id: "accurate", cost: 2.9, tokens: 11, rate: 1 },
    { id: "lean", cost: 3, tokens: 10, rate: 0.75 },
    { id: "dominated", cost: 4.1, tokens: 19, rate: 0.67 },
    { id: "same-cost-worse", cost: 0.45, tokens: 30, rate: 0.67 },
  ]
  const objectives = [
    (model: Model) => model.cost,
    (model: Model) => model.tokens,
    (model: Model) => (model.rate === null ? null : -model.rate),
  ]
  expect(paretoFrontier(models, objectives).map((model) => model.id)).toEqual([
    "cheap",
    "accurate",
    "lean",
  ])
  // Without acceptance rates only cost and tokens decide.
  const noRates = models.map((model) => ({ ...model, rate: null }))
  expect(paretoFrontier(noRates, objectives).map((model) => model.id)).toEqual(["cheap"])
  // Equal on every objective: both stay.
  const twins = [
    { id: "a", cost: 1, tokens: 1, rate: 1 },
    { id: "b", cost: 1, tokens: 1, rate: 1 },
  ]
  expect(paretoFrontier(twins, objectives)).toHaveLength(2)
})

test("points within 10 px fan out and each stays reachable", () => {
  const points = [
    { id: "a", cx: 100, cy: 100 },
    { id: "b", cx: 104, cy: 103 },
    { id: "far", cx: 200, cy: 100 },
  ]
  expect(clusterPoints(points)).toEqual([["a", "b"]])
  const fanned = fanOut(points.slice(0, 2))
  const a = fanned.get("a")!
  const b = fanned.get("b")!
  expect(Math.hypot(a.cx - b.cx, a.cy - b.cy)).toBeGreaterThan(20)
  expect(clusterPoints([points[0]!, points[2]!])).toEqual([])
})

test("arrow keys travel through points left to right; Home and End jump", () => {
  const points = [
    { id: "right", cx: 300, cy: 50 },
    { id: "left", cx: 50, cy: 80 },
    { id: "middle", cx: 150, cy: 20 },
  ]
  expect(nextPointID(points, null, "ArrowRight")).toBe("left")
  expect(nextPointID(points, "left", "ArrowRight")).toBe("middle")
  expect(nextPointID(points, "right", "ArrowRight")).toBe("right")
  expect(nextPointID(points, "middle", "ArrowLeft")).toBe("left")
  expect(nextPointID(points, "middle", "End")).toBe("right")
  expect(nextPointID(points, "middle", "Home")).toBe("left")
  expect(nextPointID(points, "middle", "x")).toBeUndefined()
  expect(nextPointID([], null, "ArrowRight")).toBeUndefined()
})

test("the ranking keeps the order given, spreads cost along x and scrolls past twelve rows", () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    id: `m${index}`,
    label: index === 0 ? "A very long model name · medium effort" : `Model ${index}`,
    value: 0.5 + index * 0.5,
    score: index % 2 ? 61 : null,
  }))
  const layout = layoutRanking({
    width: 474,
    rows,
    formatValue: (value) => `$${value}`,
    showScore: true,
  })
  expect(layout.rows.map((row) => row.id)).toEqual(rows.map((row) => row.id))
  // 22 px rows; all thirty are laid out and the area scrolls.
  expect(layout.height).toBe(30 * RANK_ROW_HEIGHT)
  expect(RANK_VISIBLE_ROWS).toBe(12)
  expect(layout.rows[1]!.cy - layout.rows[0]!.cy).toBe(22)
  // Cost grows to the right, with `$` ticks that end at a round number above the maximum.
  expect(layout.rows[29]!.cx).toBeGreaterThan(layout.rows[0]!.cx)
  expect(layout.xScale.ticks[0]!.label).toBe("$0")
  expect(layout.xScale.max).toBeGreaterThanOrEqual(15)
  // A long label is cut to the left column.
  expect(layout.rows[0]!.text.endsWith("…")).toBe(true)
  expect(layout.rows[1]!.text).toBe("Model 1")
  // The score column makes room on the right; without scores the plot takes it.
  expect(layout.scoreWidth).toBeGreaterThan(0)
  const without = layoutRanking({ width: 474, rows, formatValue: String, showScore: false })
  expect(without.plotRight).toBeGreaterThan(layout.plotRight)
  // The most expensive bar puts its value label inside; the cheapest keeps it to the right.
  expect(layout.rows[29]!.valueInside).toBe(false)
  expect(
    layoutRanking({
      width: 474,
      rows: [{ id: "a", label: "a", value: 5 }],
      formatValue: String,
      showScore: false,
    }).rows[0]!.valueInside,
  ).toBe(false)
  expect(truncateText("abcdef", 4)).toBe("abc…")
})
