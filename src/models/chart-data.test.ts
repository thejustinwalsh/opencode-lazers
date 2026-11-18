import { expect, test } from "bun:test"
import { SMALL_SAMPLE_TERMINAL_TASKS } from "./chart-layout.ts"
import {
  benchmarkChartPoints,
  comparisonChartMarks,
  observedChartPoints,
  projectedRankRows,
  projectedChartPoints,
} from "./chart-data.ts"
import type { ComparisonChartPoint, ComparisonChartReference } from "./chart-data.ts"
import type { CatalogEntry } from "./catalog-projection.ts"

const point = (
  id: string,
  tokens: number,
  usd: number,
  accepted: number,
  terminal: number | undefined,
  extra: Partial<ComparisonChartPoint> = {},
): ComparisonChartPoint => ({
  configurationID: id,
  groupID: id,
  label: id,
  tokensPerAcceptedTask: tokens,
  currentMarketUSDPerAcceptedTask: usd,
  observationCount: accepted,
  acceptedTaskCount: accepted,
  ...(terminal === undefined ? {} : { terminalTaskCount: terminal }),
  partial: false,
  route: { providerID: "p", modelID: id, variant: null },
  ...extra,
})

const reference = (
  id: string,
  tokens: number | null,
  estimate: Record<string, unknown>,
): ComparisonChartReference =>
  ({
    configurationID: id,
    label: id,
    tokensPerAcceptedTask: tokens,
    estimate: {
      route: { providerID: "p", modelID: id, variant: null },
      acceptedTaskCount: 4,
      valueUSDPerAcceptedTask: null,
      rangeUSDPerAcceptedTask: null,
      knownSubtotalUSDPerAcceptedTask: null,
      knownSubtotalRangeUSDPerAcceptedTask: null,
      provenance: { freshness: "current" },
      ...estimate,
    },
  }) as never

const ids = (marks: ReturnType<typeof comparisonChartMarks>) =>
  marks.filter((mark) => mark.frontier).map((mark) => mark.configurationID)

test("the best trade-off is the Pareto set over cost, tokens and acceptance rate", () => {
  // The owner's live data: Qwen is cheapest and leanest but accepts least; Kimi accepts most;
  // Sol (medium) is leaner than Kimi. Luna and Sol (default) are dominated.
  const marks = comparisonChartMarks({
    points: [
      point("qwen", 7e6, 0.2, 2, 3),
      point("kimi", 11e6, 2.9, 4, 4),
      point("sol-medium", 10e6, 3.0, 3, 4),
      point("sol-default", 19e6, 4.1, 2, 3),
      point("luna", 30e6, 0.45, 2, 3),
    ],
    frontierConfigurationIDs: [],
  })
  expect(ids(marks)).toEqual(["qwen", "kimi", "sol-medium"])
})

test("a small sample still counts toward the frontier and is flagged, not excluded", () => {
  expect(SMALL_SAMPLE_TERMINAL_TASKS).toBe(3)
  const data = {
    points: [point("thin", 1e6, 0.1, 1, 1), point("steady", 2e6, 0.2, 3, 3)],
    frontierConfigurationIDs: [],
  }
  const marks = comparisonChartMarks(data)
  expect(marks.map((mark) => mark.configurationID)).toEqual(["thin", "steady"])
  // One accepted task is enough to be eligible: the frontier is drawn even for a tiny install.
  expect(ids(marks)).toEqual(["thin"])
  const [thin, steady] = observedChartPoints(data, "OpenRouter")
  expect(thin!.tooltip).toContain("small sample · 1 of 1")
  expect(steady!.tooltip.join(" ")).not.toContain("small sample")
  expect(thin!.frontier).toBe(true)
  // A partial cohort is not eligible either.
  const partial = comparisonChartMarks({
    points: [point("partial", 1e6, 0.1, 3, 3, { partial: true }), point("whole", 2e6, 0.2, 3, 3)],
    frontierConfigurationIDs: [],
  })
  expect(ids(partial)).toEqual(["whole"])
  // The server's own frontier list is not used.
  expect(
    ids(
      comparisonChartMarks({
        points: [point("a", 1, 1, 3, 3), point("b", 2, 2, 3, 3)],
        frontierConfigurationIDs: ["b"],
      }),
    ),
  ).toEqual(["a"])
})

test("without a terminal count the acceptance dimension is ignored, as before", () => {
  const marks = comparisonChartMarks({
    points: [point("a", 1, 1, 3, undefined), point("b", 2, 2, 3, undefined)],
    frontierConfigurationIDs: [],
  })
  expect(ids(marks)).toEqual(["a"])
})

test("catalog references plot once, as a circle at the range midpoint, and never join the frontier", () => {
  const range = reference("range", 18_000, {
    status: "conditional",
    rangeUSDPerAcceptedTask: { minimum: 0.35, maximum: 0.67 },
  })
  const scalar = reference("scalar", 12_000, { status: "exact", valueUSDPerAcceptedTask: 0.5 })
  const subtotal = reference("subtotal", 24_000, {
    status: "partial",
    knownSubtotalUSDPerAcceptedTask: 0.1,
  })
  const unmeasured = reference("unmeasured", null, { status: "exact", valueUSDPerAcceptedTask: 1 })
  const marks = comparisonChartMarks({
    points: [point("scalar", 9_000, 0.4, 3, 3)],
    references: [range, scalar, subtotal, unmeasured],
    frontierConfigurationIDs: ["range"],
  })
  expect(marks.map((mark) => mark.configurationID)).toEqual(["range", "scalar", "subtotal"])
  const byID = Object.fromEntries(marks.map((mark) => [mark.configurationID, mark]))
  expect(byID.range).toMatchObject({
    amount: (0.35 + 0.67) / 2,
    kind: "reference",
    frontier: false,
  })
  expect(byID.range!.range).toEqual({ minimum: 0.35, maximum: 0.67 })
  // The observed point wins over a reference for the same configuration.
  expect(byID.scalar).toMatchObject({ kind: "canonical", tokens: 9_000, amount: 0.4 })
  expect(byID.subtotal!.amount).toBe(0.1)
})

test("an observed point's tooltip names model, cost, tokens, accepted n of m and source", () => {
  const [chartPoint] = observedChartPoints(
    {
      points: [point("luna", 6.2e6, 0.5, 9, 11, { label: "GPT-6 Luna" })],
      references: [
        reference("luna", 6.2e6, {
          status: "conditional",
          rangeUSDPerAcceptedTask: { minimum: 0.35, maximum: 0.67 },
        }),
      ],
      frontierConfigurationIDs: [],
    },
    "OpenRouter",
  )
  expect(chartPoint!.tooltip).toEqual([
    "GPT-6 Luna",
    "$0.35–$0.67 per accepted task",
    "6.2M tokens per accepted task",
    "9 of 11 accepted",
    "OpenRouter prices",
  ])
  expect(chartPoint).toMatchObject({ x: 6.2e6, y: 0.5, frontier: true })
  expect(chartPoint!.description).toContain("exact route p / luna")
})

const entry = (id: string, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id,
  route: { providerID: "p", modelID: id },
  label: id,
  tags: ["catalog"],
  price: {
    source: "openrouter",
    input: 1,
    output: 4,
    cacheRead: null,
    cacheWrite: null,
    blended: 1.75,
    appliesBelowTokens: null,
    retrievedAt: "2026-11-17T12:00:00.000Z",
  },
  projection: { usd: 0.8, cacheAtInputRate: false },
  score: 61,
  contextTokens: null,
  observed: null,
  frontier: false,
  ...extra,
})

test("projected points need a projection and a score; observed models carry a ring", () => {
  const points = projectedChartPoints([
    entry("scored"),
    entry("no-score", { score: null }),
    entry("no-price", { projection: null, price: null }),
    entry("backed", {
      tags: ["observed", "catalog"],
      observed: { configurationID: "c", usd: 0.9, tokens: 6e6, accepted: 9, terminal: 11 },
    }),
  ])
  expect(points.map((chartPoint) => chartPoint.id)).toEqual(["scored", "backed"])
  expect(points.map((chartPoint) => chartPoint.backed)).toEqual([false, true])
  expect(points[0]).toMatchObject({ x: 61, y: 0.8 })
  expect(points[0]!.tooltip).toContain("Coding index 61")
  expect(points[1]!.tooltip.join(" ")).toContain("9 of 11 accepted")
  expect(points[0]!.tooltip.at(-1)).toBe("OpenRouter prices · 2026-11-17")
})

test("benchmark points mark the price and score frontier", () => {
  const benchmark = (id: string, price: number, score: number) =>
    ({
      id,
      route: { providerID: "p", modelID: id },
      label: id,
      benchmark: { codingIndex: score, displayName: null, modelPermaslug: id },
      price: {
        source: "openrouter",
        input: price,
        output: price,
        cacheRead: null,
        cacheWrite: null,
        blended: price,
        appliesBelowTokens: null,
        retrievedAt: null,
      },
      observed: false,
    }) as never
  const points = benchmarkChartPoints([
    benchmark("cheap", 1, 30),
    benchmark("strong", 4, 60),
    benchmark("dominated", 5, 50),
  ])
  expect(points.map((chartPoint) => [chartPoint.id, chartPoint.frontier])).toEqual([
    ["cheap", true],
    ["strong", true],
    ["dominated", false],
  ])
  expect(points[0]).toMatchObject({ x: 1, y: 30 })
})

test("the projected ranking lists every priced model cheapest first, scored or not", () => {
  const rows = projectedRankRows([
    entry("dear", { projection: { usd: 14.4, cacheAtInputRate: false }, score: null }),
    entry("unpriced", { projection: null, price: null }),
    entry("cheap", { projection: { usd: 0.4, cacheAtInputRate: false }, score: 42 }),
    entry("backed", {
      projection: { usd: 2, cacheAtInputRate: false },
      score: null,
      tags: ["observed"],
      observed: { configurationID: "c", usd: 2.1, tokens: 1e6, accepted: 2, terminal: 2 },
    }),
  ])
  // No score is needed to appear: the ranking exists whenever any source prices anything.
  expect(rows.map((row) => row.id)).toEqual(["cheap", "backed", "dear"])
  expect(rows.map((row) => row.backed)).toEqual([false, true, false])
  expect(rows[0]!.tooltip).toContain("Projected ≈$0.4 per accepted task")
  expect(projectedRankRows([])).toEqual([])
})
