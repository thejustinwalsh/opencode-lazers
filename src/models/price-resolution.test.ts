import { expect, test } from "bun:test"
import { benchmarkBaseline } from "./benchmark-baseline.ts"
import { benchmarkPointText, benchmarkSourceName } from "./chart-data.ts"
import { buildCatalog, entryProvenanceText } from "./catalog-projection.ts"
import type { PublicCatalogItem } from "./comparison-schema.ts"
import type { ModelCandidate } from "./comparison-state.ts"
import { candidateQuotes, externalQuotes, priceExternal, resolvePrice } from "./price-resolution.ts"
import type { PriceQuote } from "./price-resolution.ts"
import type { ModelPriceSource } from "./price-source-settings.ts"

const dates = {
  openrouter: "2026-11-18T10:00:00.000Z",
  opencode: "2026-11-18T09:00:00.000Z",
  modelsDev: "2026-11-18T08:00:00.000Z",
}
const order = ["openrouter", "opencode", "models-dev"] as const
const profile = {
  uncachedInput: 1e6,
  cacheRead: 0,
  cacheWrite: 0,
  output: 2e5,
  reasoning: 0,
  configurations: 1,
  acceptedTasks: 3,
}

const quote = (source: PriceQuote["source"], input: number, output: number): PriceQuote => ({
  source,
  input,
  output,
  cacheRead: null,
  cacheWrite: null,
})

const frontierSWE = (score: number) => [
  {
    kind: "epoch-benchmark" as const,
    benchmarkID: "frontierswe",
    benchmark: "FrontierSWE",
    origin: "FrontierSWE",
    modelVersion: "m",
    modelKey: "m",
    effort: null,
    score,
    stderr: null,
    agent: null,
    releaseDate: null,
  },
]

/** A public-catalog item: names, scores and prices cut from the real payloads. */
const item = (
  providerID: string,
  modelID: string,
  score: number,
  quotes: PriceQuote[],
  options: Partial<PublicCatalogItem> = {},
): PublicCatalogItem => ({
  source: "models-dev",
  providerID,
  modelID,
  name: null,
  releaseDate: null,
  contextTokens: null,
  prices: null,
  quotes,
  benchmarks: frontierSWE(score),
  ...options,
})

const catalogOf = (
  external: PublicCatalogItem[],
  priceSources: readonly ModelPriceSource[] = order,
) =>
  buildCatalog({
    candidates: [],
    priceSources: [...priceSources],
    sourceDates: dates,
    profile,
    observed: new Map(),
    routed: [],
    external,
    preferredBasis: "frontierswe",
    label: (route) => route.modelID,
  })

const baselineOf = (
  external: PublicCatalogItem[],
  priceSources: readonly ModelPriceSource[] = order,
) =>
  benchmarkBaseline({
    candidates: [],
    priceSources: [...priceSources],
    sourceDates: dates,
    observedRoutes: new Set(),
    preferredBasis: "frontierswe",
    external,
    label: (route) => route.modelID,
  })

// -- the one walk ---------------------------------------------------------------------------------

test("a source with no quote is skipped: GPT-6 Astra is priced by OpenRouter at $10/$50", () => {
  // models.dev lists it without a price; OpenRouter lists $10 in, $50 out per 1M tokens.
  const astra = item("openai", "gpt-6-astra", 65.5 / 100, [quote("openrouter", 10, 50)], {
    prices: null,
  })
  expect(priceExternal(astra, order, dates)).toMatchObject({
    source: "openrouter",
    input: 10,
    output: 50,
    retrievedAt: dates.openrouter,
  })
  // The same model with only the listing source's own price falls to that source.
  const own = item("openai", "gpt-6-astra", 0.655, [], {
    prices: { input: 12, output: 60, cacheRead: null, cacheWrite: null },
  })
  expect(priceExternal(own, order, dates)).toMatchObject({ source: "models-dev", input: 12 })
})

test("the higher-priority source wins when two price the model, and the user's order is honoured", () => {
  const both = [quote("models-dev", 8, 40), quote("openrouter", 10, 50)]
  expect(resolvePrice(both, order, dates)).toMatchObject({ source: "openrouter", input: 10 })
  expect(resolvePrice(both, ["models-dev", "openrouter"], dates)).toMatchObject({
    source: "models-dev",
    input: 8,
    retrievedAt: dates.modelsDev,
  })
  // A source not in the order is never consulted.
  expect(resolvePrice(both, ["opencode"], dates)).toBeNull()
  expect(resolvePrice([], order, dates)).toBeNull()
})

test("a candidate is priced from its own catalog, OpenRouter's exact match, or an identity-joined quote", () => {
  const route = (extra: Record<string, unknown>) =>
    ({
      identity: { providerID: "opencode-go", modelID: "glm-5.3", variant: null },
      native: { prices: null },
      correspondence: { status: "unresolved" },
      externalModel: null,
      publicModel: null,
      ...extra,
    }) as unknown as ModelCandidate
  // No exact OpenRouter match and no native price: the identity-joined OpenRouter quote prices it.
  const joined = route({ publicQuotes: [quote("openrouter", 1.4, 4.4)] })
  expect(candidateQuotes(joined).map((q) => q.source)).toEqual(["openrouter"])
  expect(resolvePrice(candidateQuotes(joined), order, dates)).toMatchObject({ input: 1.4 })
  // OpenCode's own catalog quote sits between OpenRouter and models.dev in the default order.
  const native = route({
    native: {
      prices: {
        tiers: [
          { contextTierTokens: null, input: 1, output: 3, cacheRead: null, cacheWrite: null },
        ],
      },
    },
    publicQuotes: [quote("models-dev", 2, 6)],
  })
  expect(resolvePrice(candidateQuotes(native), order, dates)).toMatchObject({
    source: "opencode",
    input: 1,
  })
  expect(resolvePrice(candidateQuotes(native), ["models-dev", "opencode"], dates)).toMatchObject({
    source: "models-dev",
  })
})

// -- every view uses it, and says which source supplied the price ---------------------------------

test("Benchmark plot, Projected ranking and scatter, details and tooltips all show the same source", () => {
  const astra = item(
    "openai",
    "gpt-6-astra",
    0.655,
    [quote("openrouter", 10, 50), quote("models-dev", 9, 45)],
    {
      name: "GPT-6 Astra",
    },
  )
  const baseline = baselineOf([astra])
  const point = baseline.points[0]!
  expect(point.price).toMatchObject({ source: "openrouter", input: 10, output: 50 })
  expect(benchmarkPointText(point)).toContain(`${benchmarkSourceName.openrouter} list price`)

  const { entries } = catalogOf([astra])
  const entry = entries[0]!
  expect(entry.price).toMatchObject({ source: "openrouter", input: 10, output: 50 })
  // Ranking row and scatter point come from the entry, so they carry the same price.
  expect(entry.projection!.usd).toBeCloseTo(
    (profile.uncachedInput * 10 + profile.output * 50) / 1e6,
    9,
  )
  expect(entry.score).toBe(65.5)
  // The details line names who priced it.
  expect(entryProvenanceText(entry)).toContain("priced by OpenRouter")
  // And the user's order changes all of them together.
  const reordered = catalogOf([astra], ["models-dev", "openrouter", "opencode"]).entries[0]!
  expect(reordered.price?.source).toBe("models-dev")
  expect(
    baselineOf([astra], ["models-dev", "openrouter", "opencode"]).points[0]!.price.source,
  ).toBe("models-dev")
})

// -- scored models no source prices ----------------------------------------------------------------

test("a scored model no source prices is left off the plots, counted and named", () => {
  const unpriced = item("acme", "mystery-1", 0.3, [], { name: "Acme Mystery 1" })
  const priced = item("acme", "known-1", 0.4, [quote("openrouter", 2, 8)], { name: "Acme Known 1" })
  const baseline = baselineOf([unpriced, priced])
  expect(baseline.points.map((p) => p.label)).toEqual(["Acme Known 1"])
  expect(baseline.gaps.map((gap) => [gap.label, gap.reason])).toEqual([
    ["Acme Mystery 1", "no-price"],
  ])
  const { entries, summary } = catalogOf([unpriced, priced])
  expect(entries.map((e) => e.label)).toEqual(["Acme Known 1"])
  expect(summary.unpriced).toEqual([
    { name: "Acme Mystery 1", reason: "no price in any configured source" },
  ])
  expect(summary.hidden).toEqual([])
})

// -- the four models that did not plot ---------------------------------------------------------------

test("GLM-5.3, Qwen3.8 Max, Muse and Inkling are scored and priced, so each plots", () => {
  // Routed models of opencode-go / opencode / openrouter that sit on later pages: the first page
  // lists them as scored routes, priced through the ordered sources.
  const scored = [
    item("opencode-go", "glm-5.3", 0.302, [quote("openrouter", 1.4, 4.4)], {
      name: "GLM 5.3",
      routed: true,
      source: "opencode",
    }),
    item(
      "opencode-go",
      "qwen3.8-max",
      0.178,
      [quote("opencode", 1.6, 6.4), quote("openrouter", 1.5, 6)],
      { name: "Qwen3.8 Max", routed: true, source: "opencode" },
    ),
    item("opencode-go", "muse-spark-1.3-contributor", 0.258, [quote("models-dev", 2, 12)], {
      name: "Muse Spark 1.3",
      routed: true,
      source: "opencode",
    }),
    item("opencode", "inkling-2-small-free", 0.251, [quote("openrouter", 0, 0)], {
      name: "Inkling 2 Small",
      routed: true,
      source: "opencode",
    }),
  ]
  const baseline = baselineOf(scored)
  expect(baseline.points.map((p) => p.route.modelID).sort()).toEqual([
    "glm-5.3",
    "inkling-2-small-free",
    "muse-spark-1.3-contributor",
    "qwen3.8-max",
  ])
  expect(baseline.gaps).toEqual([])
  // Each takes the first configured source that prices it.
  const source = (id: string) => baseline.points.find((p) => p.route.modelID === id)!.price.source
  expect(source("glm-5.3")).toBe("openrouter")
  expect(source("qwen3.8-max")).toBe("openrouter")
  expect(source("muse-spark-1.3-contributor")).toBe("models-dev")
  const { entries } = catalogOf(scored)
  const scatter = entries.filter((e) => e.projection && e.score !== null)
  expect(scatter.map((e) => e.route.modelID).sort()).toEqual(
    baseline.points.map((p) => p.route.modelID).sort(),
  )
  // A public score is itself a reason to list a model: a long tail of unscored models does not
  // push scored ones out of the set.
  const noise = Array.from({ length: 80 }, (_, at) =>
    item("acme", `plain-${at}`, 0, [quote("openrouter", 1, 2)], { benchmarks: [] }),
  )
  expect(catalogOf([...noise, ...scored]).entries.filter((e) => e.score !== null)).toHaveLength(4)
})

test("a model its loaded route already carries is not listed twice", () => {
  const route = {
    candidateID: "c",
    identity: { providerID: "opencode-go", modelID: "glm-5.3", variant: null },
    native: {
      name: "GLM 5.3",
      enabled: true,
      type: null,
      contextTokens: null,
      capabilities: null,
      availableVariants: null,
      variantCoverage: { status: "complete", totalVariants: 0, omittedVariants: 0 },
      prices: null,
      ambiguousIdentity: false,
      evidence: { recordCount: 0, records: [] },
    },
    correspondence: { status: "unresolved" },
    externalModel: null,
    externalModelEvidence: { recordCount: 0, records: [] },
    benchmarkCorrespondence: { status: "none" },
    externalBenchmark: null,
    externalBenchmarkEvidence: { recordCount: 0, records: [] },
    effortApplicability: { status: "unknown" },
    publicModel: null,
    publicBenchmarks: frontierSWE(0.302),
    publicQuotes: [quote("openrouter", 1.4, 4.4)],
  } as unknown as ModelCandidate
  const listed = item("opencode-go", "glm-5.3", 0.302, [quote("openrouter", 1.4, 4.4)], {
    routed: true,
  })
  const sibling = item("github-copilot", "glm-5.3", 0.302, [quote("openrouter", 1.4, 4.4)], {
    routed: true,
  })
  const baseline = benchmarkBaseline({
    candidates: [route],
    priceSources: [...order],
    sourceDates: dates,
    observedRoutes: new Set(),
    preferredBasis: "frontierswe",
    external: [listed, sibling],
    label: (r) => r.modelID,
  })
  expect(baseline.points).toHaveLength(1)
  expect(baseline.points[0]!.price.source).toBe("openrouter")
})

test("quotes of a public-catalog item: every listing source, then its own price", () => {
  expect(
    externalQuotes(
      item("p", "m", 0, [quote("openrouter", 1, 2)], {
        source: "models-dev",
        prices: { input: 3, output: 4, cacheRead: null, cacheWrite: null },
      }),
    ).map((q) => q.source),
  ).toEqual(["openrouter", "models-dev"])
})
