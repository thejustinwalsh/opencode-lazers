import { expect, test } from "bun:test"
import { observedCostFixture, projectedCostFixture } from "./cost.fixture.ts"
import { chooseScoreBasis, scoreOn, scoreOptions } from "./public-score.ts"
import { SMALL_SAMPLE_TERMINAL_TASKS, layoutChart } from "./chart-layout.ts"
import {
  benchmarkChartPoints,
  comparisonChartMarks,
  observedChartPoints,
  projectedRankRows,
  projectedChartPoints,
} from "./chart-data.ts"
import type { ComparisonChartPoint, ComparisonChartReference } from "./chart-data.ts"
import type { CatalogEntry } from "./catalog-projection.ts"
import type { ComparisonChartData } from "./chart-data.ts"
import { configurationCost } from "./configuration-cost.ts"

/** Each configuration's stored cost, as the decision worker computes it. */
const costsOf = (data: ComparisonChartData) => {
  const references = new Map((data.references ?? []).map((item) => [item.configurationID, item]))
  const points = new Map(data.points.map((item) => [item.configurationID, item]))
  return (id: string) =>
    configurationCost({
      basis: "observed",
      route: { providerID: "p", modelID: id, variant: null },
      point: points.get(id) ?? null,
      reference: references.get(id)?.estimate ?? null,
      tokensPerAcceptedTask: references.get(id)?.tokensPerAcceptedTask ?? null,
      market: { source: "openrouter", retrievedAt: null },
    })
}
const drawObserved = (data: ComparisonChartData, source: string) =>
  observedChartPoints(data, source, costsOf(data))

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
      provenance: { freshness: "current", source: "openrouter-models", retrievedAt: null },
      coverage: { categories: {} },
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
  const [thin, steady] = drawObserved(data, "OpenRouter")
  expect(thin!.tooltip).toContain("small sample · 1 of 1")
  expect(steady!.tooltip.join(" ")).not.toContain("small sample")
  expect(thin!.frontier).toBe(true)
  // A partial cohort is compared like any other: it is flagged elsewhere, not excluded here.
  const partial = comparisonChartMarks({
    points: [point("partial", 1e6, 0.1, 3, 3, { partial: true }), point("whole", 2e6, 0.2, 3, 3)],
    frontierConfigurationIDs: [],
  })
  expect(ids(partial)).toEqual(["partial"])
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

test("catalog references plot once, at the range midpoint, and compete for the frontier on cost and tokens", () => {
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
  // The range reference is dominated by the observed scalar point (cheaper and leaner); the
  // known-subtotal reference is the cheapest of all, so it is on the best trade-off.
  expect(byID.subtotal!.frontier).toBe(true)
})

test("live Bug repair: the two plotted points are catalog references with no observed point, and both are on the frontier", () => {
  // Real overview payload, kind = Bug repair: `points` is empty; `referenceEstimates` holds
  // GPT-6 Luna (partial, known-subtotal range, 37 accepted tasks elsewhere) and GPT-6.1 Sol
  // (conditional range, 1 accepted task).
  const luna = reference("luna", 42_223_042.13513514, {
    status: "partial",
    acceptedTaskCount: 37,
    knownSubtotalRangeUSDPerAcceptedTask: {
      minimum: 0.6094882264864865,
      maximum: 1.1685475475675675,
    },
  })
  const sol = reference("sol", 19_075_619, {
    status: "conditional",
    acceptedTaskCount: 1,
    rangeUSDPerAcceptedTask: { minimum: 2.7694044, maximum: 5.3262388 },
  })
  const marks = comparisonChartMarks({
    points: [],
    references: [luna, sol],
    frontierConfigurationIDs: [],
  })
  expect(marks.map((mark) => [mark.configurationID, mark.frontier])).toEqual([
    ["luna", true],
    ["sol", true],
  ])
  const drawn = drawObserved(
    { points: [], references: [luna, sol], frontierConfigurationIDs: [] },
    "OpenRouter",
  )
  expect(drawn.every((entry) => entry.frontier)).toBe(true)
})

test("the frontier is decided from the stored cost the mark is drawn at, not a range's low end", () => {
  // Luna's partial range is $0.10–$0.90: its low end ($0.10) beats Sol's $0.40 at more tokens,
  // but its stored cost sits at the midpoint ($0.50), which Sol dominates (cheaper and leaner).
  const data: ComparisonChartData = {
    points: [point("sol", 1e6, 0.4, 3, 3)],
    references: [
      reference("luna", 2e6, {
        status: "partial",
        knownSubtotalRangeUSDPerAcceptedTask: { minimum: 0.1, maximum: 0.9 },
      }),
    ],
    frontierConfigurationIDs: [],
  }
  // The former rule (the mark's own amount, the low end) put Luna on the frontier.
  expect(ids(comparisonChartMarks(data))).toEqual(["luna", "sol"])
  // From the stored cost, Luna is dominated; membership and position agree.
  const drawn = drawObserved(data, "OpenRouter")
  const luna = drawn.find((item) => item.id === "luna")!
  expect(luna).toMatchObject({ y: 0.5, frontier: false, range: { axis: "y", low: 0.1, high: 0.9 } })
  expect(drawn.find((item) => item.id === "sol")!.frontier).toBe(true)
  expect(ids(comparisonChartMarks({ ...data, costOf: costsOf(data) }))).toEqual(["sol"])
})

test("an observed point's tooltip names model, cost, tokens, accepted n of m and source", () => {
  const [chartPoint] = drawObserved(
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
    "Observed in your runs: $0.35–$0.67 per accepted task",
    "6.2M tokens per accepted task",
    "9 of 11 accepted",
    "OpenRouter prices",
  ])
  // A range is a whisker from low to high with the mark at its midpoint, never at the low end.
  expect(chartPoint).toMatchObject({
    x: 6.2e6,
    y: 0.51,
    range: { axis: "y", low: 0.35, high: 0.67 },
    frontier: true,
  })
  expect(chartPoint!.description).toContain("Observed in your runs: $0.35–$0.67")
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
  projected: projectedCostFixture(0.8),
  score: 61,
  contextTokens: null,
  observed: null,
  frontier: false,
  ...extra,
})

test("projected points need a projection and a score; an observed cost is its own ring", () => {
  const points = projectedChartPoints([
    entry("scored"),
    entry("no-score", { score: null }),
    entry("no-price", { projected: projectedCostFixture(null), price: null }),
    entry("backed", {
      tags: ["observed", "catalog"],
      observed: {
        configurationID: "c",
        cost: observedCostFixture(0.9),
        tokens: 6e6,
        accepted: 9,
        terminal: 11,
      },
    }),
  ])
  expect(points.map((chartPoint) => chartPoint.id)).toEqual(["scored", "backed"])
  // The ring sits at the observed cost, never at the projected one.
  expect(points.map((chartPoint) => chartPoint.observed)).toEqual([
    undefined,
    { value: 0.9, low: 0.9, high: 0.9 },
  ])
  expect(points[0]).toMatchObject({ x: 0.8, y: 61 })
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
    entry("dear", { projected: projectedCostFixture(14.4), score: null }),
    entry("unpriced", { projected: projectedCostFixture(null), price: null }),
    entry("cheap", { projected: projectedCostFixture(0.4), score: 42 }),
    entry("backed", {
      projected: projectedCostFixture(2),
      score: null,
      tags: ["observed"],
      observed: {
        configurationID: "c",
        cost: observedCostFixture(2.1),
        tokens: 1e6,
        accepted: 2,
        terminal: 2,
      },
    }),
  ])
  // No score is needed to appear: the ranking exists whenever any source prices anything.
  expect(rows.map((row) => row.id)).toEqual(["cheap", "backed", "dear"])
  expect(rows.map((row) => row.observed?.value)).toEqual([undefined, 2.1, undefined])
  expect(rows[0]!.tooltip).toContain("Projected from list prices × your median tokens: $0.4")
  expect(rows[1]!.tooltip.join(" ")).toContain("Observed in your runs: $2.1")
  expect(projectedRankRows([])).toEqual([])
})

test("live Bug repair points: partial cohorts with no terminal count are both on the frontier", () => {
  // The real overview payload for kind = Bug repair: neither point carries `terminalTaskCount`
  // and both cohorts are partial. Sol is leaner in tokens, Luna is cheaper: neither dominates.
  const marks = comparisonChartMarks({
    points: [
      point("gpt-6.1-sol default", 19e6, 4.05, 1, undefined, { partial: true }),
      point("gpt-6-luna max", 42e6, 0.6, 1, undefined, { partial: true }),
    ],
    frontierConfigurationIDs: [],
  })
  expect(ids(marks)).toEqual(["gpt-6.1-sol default", "gpt-6-luna max"])
  const drawn = drawObserved(
    {
      points: [
        point("gpt-6.1-sol default", 19e6, 4.05, 1, undefined, { partial: true }),
        point("gpt-6-luna max", 42e6, 0.6, 1, undefined, { partial: true }),
      ],
      frontierConfigurationIDs: [],
    },
    "OpenRouter",
  )
  expect(drawn.every((entry) => entry.frontier)).toBe(true)
  // A point with no accepted task is still not eligible.
  expect(
    ids(
      comparisonChartMarks({
        points: [point("none", 1, 1, 0, undefined)],
        frontierConfigurationIDs: [],
      }),
    ),
  ).toEqual([])
})

test("the cost-vs-score scatter puts cost on x and the score on y, best at the upper left", () => {
  const entries = [
    entry("cheap-weak", { score: 40, projected: projectedCostFixture(0.5) }),
    entry("mid", { score: 60, projected: projectedCostFixture(1.5) }),
    entry("dear-strong", { score: 80, projected: projectedCostFixture(4) }),
    entry("dominated", { score: 50, projected: projectedCostFixture(3) }),
  ]
  // The frontier is cost down, score up: `dominated` costs more than `mid` and scores less.
  const withFrontier = entries.map((item) => ({
    ...item,
    frontier: item.route.modelID !== "dominated",
  }))
  const points = projectedChartPoints(withFrontier)
  expect(points.find((p) => p.id === "mid")).toMatchObject({ x: 1.5, y: 60 })
  const layout = layoutChart({
    width: 474,
    points,
    selectedID: null,
    xScale: "auto-log",
    xLogRatio: 200,
    formatX: String,
    formatY: String,
  })
  // Linear from $0, spread under 200x: cost grows to the right, the score upward.
  expect(layout.xScale.kind).toBe("linear")
  const at = (id: string) => layout.points.find((p) => p.id === id)!
  expect(at("dear-strong").cx).toBeGreaterThan(at("cheap-weak").cx)
  expect(at("dear-strong").cy).toBeLessThan(at("cheap-weak").cy)
  // The polyline runs the upper-left envelope in cost order and skips the dominated model.
  const order = [...layout.frontierPath.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((m) => Number(m[1]))
  expect(order).toEqual(
    [at("cheap-weak").cx, at("mid").cx, at("dear-strong").cx].map((v) => Number(v.toFixed(1))),
  )
  // A spread past 200x goes log, and says so.
  const wide = layoutChart({
    width: 474,
    points: [
      { id: "a", x: 0.01, y: 10, label: "a", frontier: false },
      { id: "b", x: 5, y: 20, label: "b", frontier: false },
    ],
    selectedID: null,
    xScale: "auto-log",
    xLogRatio: 200,
    formatX: String,
    formatY: String,
  })
  expect(wide.xScale.kind).toBe("log")
})

test("the score basis switch re-bases the scores on the picked benchmark", () => {
  const rows = (id: string, name: string, score: number) => [
    {
      kind: "epoch-benchmark",
      benchmarkID: id,
      benchmark: name,
      score,
      origin: "x",
      modelVersion: "m",
      modelKey: "m",
      effort: null,
      stderr: null,
      agent: null,
      releaseDate: null,
    },
  ]
  const candidate = (modelID: string, swe: number, aider: number) =>
    ({
      candidateID: modelID,
      identity: { providerID: "p", modelID, variant: null },
      benchmarkCorrespondence: { status: "none" },
      externalBenchmark: null,
      publicBenchmarks: [
        ...rows("swe-bench-verified", "SWE-bench Verified", swe),
        ...rows("aider-polyglot", "Aider polyglot", aider),
      ],
    }) as never
  const set = [candidate("a", 0.7, 0.3), candidate("b", 0.5, 0.9)]
  const options = scoreOptions(set)
  expect(options.map((option) => option.key).sort()).toEqual([
    "aider-polyglot",
    "swe-bench-verified",
  ])
  expect(chooseScoreBasis(set).basis).toMatchObject({ benchmarkID: "swe-bench-verified" })
  const picked = chooseScoreBasis(set, "aider-polyglot").basis
  expect(picked).toMatchObject({ benchmarkID: "aider-polyglot", label: "Aider polyglot (%)" })
  expect(scoreOn(set[1]!, picked)?.value).toBe(90)
  // An unavailable pick is ignored rather than leaving the set unscored.
  expect(chooseScoreBasis(set, "terminal-bench").basis).toMatchObject({
    benchmarkID: "swe-bench-verified",
  })
})
