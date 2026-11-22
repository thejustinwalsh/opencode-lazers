import { expect, test } from "bun:test"
import { costText } from "./configuration-cost.ts"
import { observedCostFixture } from "./cost.fixture.ts"
import {
  benchmarkCaveats,
  benchmarkHeadline,
  benchmarkPaneModel,
  benchmarkStats,
  exactMoney,
  headlineMoney,
  headlineRange,
  observedPaneModel,
  outcomeLabels,
  perMillionRate,
  priceSemanticsLabels,
  priceSemanticsText,
  priceSourceLabels,
  rateCoverageLabels,
  realSlug,
  runsCoverage,
  runsHeadline,
  runsStats,
  tokenRows,
} from "./pane-presentation.ts"

const raw = /[a-z]+-[a-z]+|unknown|unavailable|not recorded|not a scalar/i

const usage = (tokens: number | null, rateCoverage: string, status = "observed") => ({
  tokens,
  status,
  rateCoverage,
})

const categories = (change: Record<string, ReturnType<typeof usage>> = {}) => ({
  uncachedInput: usage(100, "complete"),
  output: usage(50, "complete"),
  reasoning: usage(0, "not-required"),
  cacheRead: usage(0, "not-required"),
  cacheWrite: usage(0, "not-required"),
  ...change,
})

const reference = (
  change: Record<string, ReturnType<typeof usage>> = {},
  status: { retries?: string; attribution?: string } = {},
) =>
  ({
    provenance: { snapshotID: null, generation: null, recordID: null, recordIndex: null },
    coverage: {
      categories: categories(change),
      retries: { status: status.retries ?? "complete" },
      attribution: { status: status.attribution ?? "complete" },
    },
  }) as never

test("the headline is one two-decimal figure with its unit", () => {
  expect(headlineMoney(2.9278646)).toBe("$2.93")
  expect(headlineMoney(12.4)).toBe("$12.40")
  expect(headlineMoney(0.0785)).toBe("$0.08")
  expect(headlineMoney(0.00785)).toBe("$0.0079")
  expect(headlineRange({ minimum: 2.9278646, maximum: 2.9278646 })).toBe("$2.93")
  expect(headlineRange({ minimum: 0.35, maximum: 0.67 })).toBe("$0.35 – 0.67")
  // The headline writes the stored cost as every view does, and names its basis.
  const headline = runsHeadline({
    cost: observedCostFixture(2.9278646),
    accepted: 1,
    terminal: 2,
  })
  expect(headline).toEqual({
    value: costText(observedCostFixture(2.9278646)),
    unit: "per accepted task · Observed in your runs",
    smallSample: true,
  })
  expect(runsHeadline({ cost: observedCostFixture(0.57, 1.09) })?.value).toBe("$0.57–$1.09")
})

test("the small sample label follows the chart's threshold", () => {
  const cost = observedCostFixture(1)
  expect(runsHeadline({ cost, terminal: 2 })?.smallSample).toBe(true)
  expect(runsHeadline({ cost, terminal: 3 })?.smallSample).toBe(false)
})

test("a missing price omits the headline instead of labelling it", () => {
  expect(runsHeadline({ accepted: 1, terminal: 2 })).toBeUndefined()
  expect(runsHeadline(undefined)).toBeUndefined()
})

test("exact figures keep at most four significant digits", () => {
  expect(exactMoney(2.326410157)).toBe("$2.326")
  expect(exactMoney(0.0771692)).toBe("$0.07717")
  expect(perMillionRate("0.000002")).toBe("$2")
  expect(perMillionRate(null)).toBeUndefined()
  expect(perMillionRate("n/a")).toBeUndefined()
})

test("stats keep their order and the empty ones have no value", () => {
  const stats = runsStats({ accepted: 1, terminal: 2, tokens: "10.8M", attempts: "2" })
  expect(stats.filter((stat) => stat.value).map((stat) => stat.label)).toEqual([
    "Accepted",
    "Tokens / task",
    "Attempts / task",
  ])
  expect(stats[0]?.value).toBe("1 of 2")
})

test("coverage is the priced share of tokens and one caption names what is not priced", () => {
  const coverage = runsCoverage(reference({ cacheWrite: usage(50, "missing") }))
  expect(coverage?.priced).toBe(150)
  expect(coverage?.unpriced).toBe(50)
  expect(coverage?.caption).toBe("75% of tokens priced · OpenRouter catalog")
  expect(coverage?.note).toBe("cache write has no published price")
  expect(runsCoverage(reference())?.note).toBeUndefined()
  expect(runsCoverage(undefined)).toBeUndefined()
  expect(
    runsCoverage(
      reference({ uncachedInput: usage(0, "complete"), output: usage(null, "unknown") }),
    ),
  ).toBeUndefined()
})

test("coverage never reads 100 percent while something is unpriced", () => {
  const coverage = runsCoverage(
    reference({ uncachedInput: usage(100_000, "complete"), cacheWrite: usage(1, "missing") }),
  )
  expect(coverage?.caption.startsWith("<100%")).toBe(true)
})

test("every translated enum value reads as plain language or is omitted", () => {
  for (const [key, label] of Object.entries(priceSemanticsLabels)) {
    if (label === undefined) {
      expect(key).toBe("unknown")
      continue
    }
    expect(label).not.toBe(key)
    expect(label).not.toMatch(/-/)
    expect(label).not.toMatch(/unknown|unavailable/i)
  }
  expect(priceSemanticsText("exact-native-model-quote")).toBe("OpenCode model quote")
  expect(priceSemanticsText("observed-endpoint-averages")).toBe("Endpoint averages")
  expect(priceSemanticsText("unknown")).toBeUndefined()
  for (const label of [
    ...Object.values(priceSourceLabels),
    ...Object.values(rateCoverageLabels),
    ...Object.values(outcomeLabels),
  ])
    if (label !== undefined) expect(label).not.toMatch(raw)
  expect(outcomeLabels).toEqual({ accepted: "Accepted", failed: "Failed", retry: "Retry" })
})

test("a placeholder catalog slug is not shown", () => {
  expect(realSlug("gpt-5.5_unknown")).toBeUndefined()
  expect(realSlug("openai/gpt-5.5")).toBe("openai/gpt-5.5")
  expect(realSlug(undefined)).toBeUndefined()
})

test("token rows carry coverage and, with one rate set, the rate per 1M", () => {
  const rows = tokenRows(reference({ cacheWrite: usage(194_816, "missing") }), [
    { prompt: "0.000002", completion: "0.00001", cacheRead: "0.0000002", cacheWrite: null },
  ])
  expect(rows.map((row) => row.kind)).toEqual(["Input", "Output", "Cache write"])
  expect(rows[0]).toEqual({ kind: "Input", tokens: "100", coverage: "Priced", rate: "$2" })
  expect(rows[2]).toEqual({
    kind: "Cache write",
    tokens: "194,816",
    coverage: "No price",
    rate: undefined,
  })
  // Several tiers have no single rate: no row carries one.
  expect(
    tokenRows(reference(), [
      { prompt: "1", completion: "1", cacheRead: null, cacheWrite: null },
      { prompt: "2", completion: "2", cacheRead: null, cacheWrite: null },
    ]).every((row) => row.rate === undefined),
  ).toBe(true)
  expect(tokenRows(undefined)).toEqual([])
})

const contributor = (extra: Record<string, unknown> = {}) => ({
  taskID: "t",
  taskReference: "LZ-104",
  attemptID: "5fab7e91-64b0-420b-b2d7-52773b30e5d9",
  sessionID: "ses_186dbc76c2a64b3cbd0ff0fcd4836ff9",
  contribution: "retry",
  membership: "cohort-effort",
  tokens: 37_723,
  currentMarketUSD: 0.0771692,
  nativeReportedUSD: null,
  observedAt: null,
  ...extra,
})

const baseContext = {
  snapshotID: "snapshot-1",
  freshness: "current",
  priceSourcePolicy: { revision: 3 },
  priceIndex: {
    pins: [
      {
        source: "opencode",
        snapshotID: "7756609e-0b28-4373-b662-efc858ca8e22",
        retrievedAt: "2026-11-19T08:59:48.000Z",
        freshness: "current",
        semantics: "exact-native-model-quotes",
      },
    ],
  },
}

const inspection = (extra: Record<string, unknown> = {}) =>
  ({
    status: "found",
    context: baseContext,
    configuration: {
      configurationID: "cfg",
      route: { providerID: "opencode-go", modelID: "kimi-k3.1-pro", variant: "high" },
      currentPrice: { sourceRecordID: "kimi-k3.1-pro" },
    },
    cohort: { acceptedTaskCount: 1, terminalTaskCount: 2 },
    nativeReportedCost: { status: "unmetered", totalUSD: null },
    contributorPage: { contributors: [contributor()], totalCount: 2, nextCursor: null },
    referenceEstimate: reference({ cacheWrite: usage(1_000, "missing") }),
    ...extra,
  }) as never

test("the observed model shows no raw enum or id outside Identifiers", () => {
  const model = observedPaneModel({
    inspection: inspection(),
    facts: {
      cost: observedCostFixture(2.93),
      accepted: 1,
      terminal: 2,
      tokens: "10.8M",
    },
    sources: [],
    warnings: [],
  })
  const { identifiers, ...rest } = model
  const text = JSON.stringify({
    ...rest,
    runs: model.runs.map(({ contributor: _unused, ...row }) => row),
  })
  expect(text).not.toMatch(/exact-native|observed-endpoint|cohort-effort|not a scalar|membership/i)
  expect(text).not.toMatch(/\d\.\d{5,}/)
  expect(text).not.toMatch(/5fab7e91|ses_186dbc/)
  expect(model.sources).toEqual([
    { name: "OpenCode prices", detail: "OpenCode model quotes", time: expect.any(String) },
  ])
  expect(model.runs[0]).toMatchObject({
    task: "LZ-104",
    outcome: "Retry",
    tokens: "37.7k",
    cost: "$0.08",
  })
  expect(identifiers.map((item) => item.label)).toContain("LZ-104 attempt")
  expect(identifiers.find((item) => item.label === "LZ-104 session")?.value).toBe(
    "ses_186dbc76c2a64b3cbd0ff0fcd4836ff9",
  )
})

test("a run with no cost or tokens leaves those cells empty", () => {
  const model = observedPaneModel({
    inspection: inspection({
      contributorPage: {
        contributors: [contributor({ tokens: null, currentMarketUSD: null })],
        totalCount: 1,
        nextCursor: "next",
      },
    }),
    facts: undefined,
    sources: [],
    warnings: [],
  })
  expect(model.runs[0]?.tokens).toBeUndefined()
  expect(model.runs[0]?.cost).toBeUndefined()
  expect(model.hasMoreRuns).toBe(true)
  expect(model.headline).toBeUndefined()
})

test("caveats are at most three short lines", () => {
  const model = observedPaneModel({
    inspection: inspection({
      nativeReportedCost: { status: "available", totalUSD: 3 },
      referenceEstimate: reference({}, { retries: "partial", attribution: "partial" }),
      context: { ...baseContext, freshness: "stale" },
    }),
    facts: undefined,
    sources: [],
    warnings: [],
  })
  expect(model.caveats).toHaveLength(3)
  for (const line of model.caveats) expect(line.length).toBeLessThan(80)
})

const scores = (extra = {}) => ({
  scoreName: "Terminal-Bench 2.0 (%)",
  displayName: "GPT-5.5",
  modelPermaslug: "gpt-5.5_unknown",
  codingIndex: 84.7,
  agenticIndex: null,
  intelligenceIndex: null,
  ...extra,
})
const price = {
  source: "openrouter",
  input: 5,
  output: 30,
  cacheRead: 0.5,
  cacheWrite: null,
  blended: 11.25,
  appliesBelowTokens: null,
  retrievedAt: "2026-11-19T08:59:49.000Z",
} as const

test("the benchmark pane leads with the score and its benchmark name, then per-1M prices", () => {
  expect(benchmarkHeadline(scores())).toEqual({
    value: "84.7",
    unit: "Terminal-Bench 2.0 (%)",
    smallSample: false,
  })
  expect(benchmarkHeadline(scores({ codingIndex: null }))).toBeUndefined()
  expect(benchmarkStats(price).map((stat) => [stat.label, stat.value])).toEqual([
    ["Input / 1M", "$5"],
    ["Output / 1M", "$30"],
    ["Cached / 1M", "$0.5"],
  ])
  expect(benchmarkStats(null)).toEqual([])
})

test("blank score components are omitted and the blended price is labelled once", () => {
  const model = benchmarkPaneModel({
    route: { providerID: "openai", modelID: "gpt-5.5" },
    scores: scores({ agenticIndex: 71 }),
    price,
    citation: "Artificial Analysis via OpenRouter",
    snapshot: { snapshotID: "s1", retrievedAt: "2026-11-19T08:57:50.000Z" },
    priceSourceName: "OpenRouter",
    order: "OpenRouter, then OpenCode",
    mix: { input: 3, output: 1 },
    sources: [],
    warnings: [],
  })
  expect(model.scores).toEqual([{ name: "Agentic", detail: "71" }])
  expect(model.caveats.filter((line) => /blends/.test(line))).toHaveLength(1)
  expect(JSON.stringify(model.stats)).not.toContain("blend")
  expect(model.identifiers.find((item) => item.label === "Catalog slug")?.value).toBeUndefined()
  expect(JSON.stringify(model)).not.toContain("gpt-5.5_unknown")
  expect(benchmarkCaveats({ price: null, mix: { input: 3, output: 1 } })).toHaveLength(2)
})
