import { afterAll, expect, test } from "bun:test"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { BenchmarkBaselinePoint } from "./benchmark-baseline.ts"
import type { ComparisonChartTheme } from "./comparison-chart.tsx"

const vite = await createServer({
  configFile: false,
  plugins: [solid()],
  server: { middlewareMode: true, ws: false },
  appType: "custom",
})
afterAll(() => vite.close())
const { benchmarkChartOptions, benchmarkFrontier } = (await vite.ssrLoadModule(
  "/src/models/benchmark-chart.tsx",
)) as typeof import("./benchmark-chart.tsx")

const theme: ComparisonChartTheme = {
  surface: "native-surface",
  text: "native-text",
  mutedText: "native-muted",
  grid: "native-grid",
  accent: "native-accent",
  fontFamily: "Native Sans",
  monoFontFamily: "Native Mono",
}
const layout = {
  width: 600,
  height: 360,
  fontSize: 12,
  grid: { left: 48, right: 24, top: 16, bottom: 40, containLabel: false as const },
  xSplitNumber: 4,
  ySplitNumber: 4,
}

function point(id: string, price: number, codingIndex: number, observed = true) {
  return {
    id,
    route: { providerID: "p", modelID: id },
    label: id,
    benchmark: {
      displayName: id,
      modelPermaslug: `p/${id}`,
      codingIndex,
      agenticIndex: null,
      intelligenceIndex: null,
    },
    price: {
      source: "openrouter",
      input: price,
      output: price,
      cacheRead: null,
      cacheWrite: null,
      blended: price,
      appliesBelowTokens: null,
      retrievedAt: "2026-11-15T10:00:00.000Z",
    },
    observed,
  } as BenchmarkBaselinePoint
}
type FrontierLine = {
  id: string
  name: string
  type: string
  data: unknown[]
  z?: number
  silent: boolean
  smooth: boolean
  connectNulls: boolean
  showSymbol: boolean
  lineStyle: unknown
  emphasis: unknown
  blur: { lineStyle: { opacity: number } }
  endLabel: { show: boolean } & Record<string, unknown>
}
const ids = (points: readonly BenchmarkBaselinePoint[]) => points.map((entry) => entry.id)
const options = (points: BenchmarkBaselinePoint[], selectedID: string | null = null) =>
  benchmarkChartOptions({ points, selectedID }, theme, layout)

test("benchmark frontier excludes dominated points and sorts by price", () => {
  const points = [
    point("max", 4, 60),
    point("dominated", 5, 50),
    point("mini", 1, 30),
    point("mid", 2, 45),
    point("worse-mid", 3, 44),
  ]
  expect(ids(benchmarkFrontier(points))).toEqual(["mini", "mid", "max"])
})

test("benchmark frontier keeps the best score at equal price and ignores non-finite points", () => {
  const points = [
    point("low", 2, 40),
    point("high", 2, 55),
    point("nan", Number.NaN, 90),
    point("inf", 3, Number.POSITIVE_INFINITY),
    point("cheap", 1, 20),
  ]
  expect(ids(benchmarkFrontier(points))).toEqual(["cheap", "high"])
})

test("benchmark frontier orders exact duplicates by id regardless of input order", () => {
  const a = point("a", 2, 50)
  const b = point("b", 2, 50)
  const c = point("c", 2, 50)
  const lead = point("lead", 1, 10)
  for (const input of [
    [c, a, lead, b],
    [b, c, a, lead],
    [lead, a, b, c],
  ]) {
    expect(ids(benchmarkFrontier(input))).toEqual(["lead", "a", "b", "c"])
  }
  expect(benchmarkFrontier([])).toEqual([])
})

test("benchmark frontier is a staircase of real coordinates", () => {
  const frontier = benchmarkFrontier([
    point("a", 3, 70),
    point("b", 1, 10),
    point("c", 2, 40),
    point("d", 2.5, 20),
    point("e", 0.5, 5),
  ])
  for (const [index, entry] of frontier.entries()) {
    const next = frontier[index + 1]
    if (!next) continue
    expect(next.price.blended).toBeGreaterThanOrEqual(entry.price.blended)
    expect(next.benchmark.codingIndex).toBeGreaterThanOrEqual(entry.benchmark.codingIndex)
  }
})

test("a singleton frontier draws no line but keeps its filled circle", () => {
  const option = options([point("only", 1, 30)])
  const line = option.series[1] as unknown as FrontierLine
  expect(line.id).toBe("benchmark-frontier")
  expect(line.data).toEqual([])
  expect((option.series[0]!.data[0] as { symbol: string }).symbol).toBe("circle")
  expect((option.series[0]!.data[0] as { itemStyle: { color: string } }).itemStyle.color).toBe(
    "native-accent",
  )
})

test("the frontier line holds exactly the member coordinates as a thin solid polyline", () => {
  const points = [point("max", 4, 60), point("dominated", 5, 50), point("mini", 1, 30)]
  const option = options(points, "max")
  const line = option.series[1] as unknown as FrontierLine
  expect(line.name).toBe("Benchmark frontier")
  expect(line.type).toBe("line")
  expect(line.data).toEqual([
    [1, 30],
    [4, 60],
  ])
  expect(line.silent).toBe(true)
  expect(line.smooth).toBe(false)
  expect(line.connectNulls).toBe(false)
  expect(line.showSymbol).toBe(false)
  expect(line.lineStyle).toEqual({ color: "native-accent", width: 1.5, opacity: 0.75 })
  expect(line.emphasis).toEqual({ disabled: true })
  expect(line.blur.lineStyle.opacity).toBe(0.75)
  // Every mark is a circle, the selection last; the legend names the frontier "Best trade-off".
  const marks = option.series[0]!.data as Array<{
    configurationID: string
    symbol: string
    itemStyle: { color: string }
  }>
  expect(marks.map((mark) => [mark.configurationID, mark.symbol])).toEqual([
    ["dominated", "circle"],
    ["mini", "circle"],
    ["max", "circle"],
  ])
  expect(marks.map((mark) => mark.itemStyle.color)).toEqual([
    "native-surface",
    "native-accent",
    "native-accent",
  ])
  expect(option.aria.description).toContain(
    "Benchmark frontier, lowest list price for each higher Coding Index: mini, max.",
  )
})
