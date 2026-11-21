import { expect, test } from "bun:test"
import {
  BYOK_PER_PROVIDER,
  CATALOG_SOURCE_TOP,
  CATALOG_TOP,
  buildCatalog,
  buildCatalogSet,
  catalogSummaryText,
  entryCost,
  projectCost,
  rankCatalog,
  tokenProfile,
} from "./catalog-projection.ts"
import type { CatalogEntry, ObservedFacts, TokenProfile } from "./catalog-projection.ts"
import { routeKey } from "./benchmark-baseline.ts"
import type { ModelCandidate } from "./comparison-presentation.ts"

/** A candidate priced by OpenRouter (USD per token strings) or by the native catalog. */
function candidate(
  providerID: string,
  modelID: string,
  options: {
    score?: number | null
    openrouter?: { prompt: string; completion: string; cacheRead?: string | null }
    native?: {
      input: number
      output: number
      cacheRead?: number | null
      cacheWrite?: number | null
    }
    slug?: string
  } = {},
): ModelCandidate {
  const { score = null, openrouter, native, slug } = options
  return {
    candidateID: `${providerID}:${modelID}`,
    identity: { providerID, modelID, variant: null },
    native: {
      name: modelID,
      enabled: true,
      type: null,
      contextTokens: null,
      capabilities: null,
      availableVariants: null,
      variantCoverage: { status: "complete", totalVariants: 0, omittedVariants: 0 },
      prices: native
        ? {
            tiers: [
              {
                contextTierTokens: null,
                input: native.input,
                output: native.output,
                cacheRead: native.cacheRead ?? null,
                cacheWrite: native.cacheWrite ?? null,
              },
            ],
          }
        : null,
      ambiguousIdentity: false,
      evidence: { recordCount: 0, records: [] },
    },
    correspondence: { status: openrouter ? "exact" : "none" },
    externalModel: openrouter
      ? {
          id: slug ?? `${providerID}/${modelID}`,
          prices: {
            tiers: [
              {
                minPromptTokens: null,
                utcStart: null,
                utcEnd: null,
                prompt: openrouter.prompt,
                completion: openrouter.completion,
                inputCacheRead: openrouter.cacheRead ?? null,
                inputCacheWrite: null,
              },
            ],
          },
        }
      : null,
    externalModelEvidence: { recordCount: 0, records: [] },
    benchmarkCorrespondence: { status: score === null ? "none" : "exact" },
    externalBenchmark:
      score === null
        ? null
        : {
            displayName: modelID,
            modelPermaslug: modelID,
            codingIndex: score,
            agenticIndex: null,
            intelligenceIndex: null,
          },
    externalBenchmarkEvidence: { recordCount: 0, records: [] },
    effortApplicability: { status: "unknown" },
  } as never
}

const profile: TokenProfile = {
  uncachedInput: 1_000_000,
  cacheRead: 0,
  cacheWrite: 0,
  output: 200_000,
  reasoning: 100_000,
  configurations: 3,
  acceptedTasks: 12,
}

const base = {
  priceSources: ["openrouter", "opencode"] as const,
  sourceDates: { openrouter: "2026-11-17T12:00:00.000Z", opencode: null },
  profile,
  observed: new Map<string, ObservedFacts>(),
  routed: [] as Array<{ providerID: string; modelID: string }>,
  label: (route: { modelID: string }) => route.modelID,
}

test("the token profile is the per-category median across observed configurations", () => {
  const empty = {
    uncachedInput: null,
    cacheRead: null,
    cacheWrite: null,
    output: null,
    reasoning: null,
  }
  const result = tokenProfile([
    // 10M input over 10 accepted tasks = 1M per task; 2M output = 200k per task.
    {
      accepted: 10,
      tokens: { ...empty, uncachedInput: 10_000_000, output: 2_000_000, reasoning: 0 },
    },
    {
      accepted: 2,
      tokens: { ...empty, uncachedInput: 6_000_000, output: 400_000, reasoning: 200_000 },
    },
    {
      accepted: 4,
      tokens: { ...empty, uncachedInput: 2_000_000, output: 1_600_000, reasoning: 400_000 },
    },
    // No accepted task: not counted.
    { accepted: 0, tokens: { ...empty, uncachedInput: 99_000_000 } },
  ])
  // Per task: input 1M, 3M, 0.5M -> median 1M; output 200k, 200k, 400k -> 200k; reasoning 0, 100k, 100k -> 100k.
  expect(result).toMatchObject({
    uncachedInput: 1_000_000,
    output: 200_000,
    reasoning: 100_000,
    cacheRead: 0,
    configurations: 3,
    acceptedTasks: 16,
  })
  expect(tokenProfile([])).toBeUndefined()
  expect(tokenProfile([{ accepted: 3, tokens: empty }])).toBeUndefined()
})

test("projection is list prices times the profile, reasoning billed as output", () => {
  const price = {
    source: "openrouter" as const,
    input: 2,
    output: 10,
    cacheRead: null,
    cacheWrite: null,
    blended: 4,
    appliesBelowTokens: null,
    retrievedAt: null,
  }
  // 1M input at $2 + (200k output + 100k reasoning) at $10 per 1M = $2 + $3.
  expect(projectCost(profile, price)).toEqual({ usd: 5, cacheAtInputRate: false })
  // A cache rate that is absent prices the cached tokens at the input rate, and says so.
  const cached = { ...profile, cacheRead: 500_000 }
  expect(projectCost(cached, price)).toEqual({ usd: 6, cacheAtInputRate: true })
  expect(projectCost(cached, { ...price, cacheRead: 0.5 })).toEqual({
    usd: 5.25,
    cacheAtInputRate: false,
  })
})

test("the set is a union by model: observed, routed and catalog, tagged and de-duplicated", () => {
  const top = Array.from({ length: CATALOG_TOP + 5 }, (_, index) =>
    candidate("acme", `model-${index}`, {
      score: 100 - index,
      openrouter: { prompt: "0.000001", completion: "0.000004" },
    }),
  )
  const luna = candidate("openai", "gpt-6-luna", {
    openrouter: { prompt: "0.000002", completion: "0.00001" },
  })
  const routedOnly = candidate("zed", "router-pick", {
    openrouter: { prompt: "0.000003", completion: "0.000012" },
  })
  const entries = buildCatalogSet({
    ...base,
    candidates: [...top, luna, routedOnly],
    observed: new Map([
      [
        routeKey({ providerID: "openai", modelID: "gpt-6-luna" }),
        { configurationID: "c1", usd: 0.5, tokens: 6e6, accepted: 9, terminal: 11 },
      ],
      // Observed but absent from every catalog: still listed, with no price to project.
      [
        routeKey({ providerID: "local", modelID: "home-grown" }),
        { configurationID: "c2", usd: 0.1, tokens: 1e6, accepted: 2, terminal: 2 },
      ],
    ]),
    routed: [
      { providerID: "zed", modelID: "router-pick" },
      { providerID: "openai", modelID: "gpt-6-luna" },
    ],
  })
  const byModel = new Map(entries.map((item) => [item.route.modelID, item]))
  // Each model appears once however many sources name it.
  expect(new Set(entries.map((item) => routeKey(item.route))).size).toBe(entries.length)
  // Luna is also in the OpenAI lineup, which BYOK always includes.
  expect(byModel.get("gpt-6-luna")!.tags).toEqual(["observed", "routed", "catalog"])
  expect(byModel.get("router-pick")!.tags).toEqual(["routed"])
  expect(byModel.get("home-grown")!.tags).toEqual(["observed"])
  expect(byModel.get("home-grown")!.projection).toBeNull()
  expect(byModel.get("home-grown")!.price).toBeNull()
  // A public score is a reason to list a model: every scored, priced model is in, however many.
  const catalogTagged = entries.filter((item) => item.tags.includes("catalog"))
  // (Luna joins them as part of the OpenAI lineup.)
  expect(catalogTagged.filter((item) => item.route.providerID === "acme")).toHaveLength(
    CATALOG_TOP + 5,
  )
  expect(byModel.get("model-0")!.tags).toEqual(["catalog"])
  expect(byModel.has(`model-${CATALOG_TOP}`)).toBe(true)
  // Projection comes from the configured source's list price and the profile.
  expect(byModel.get("model-0")!.projection!.usd).toBeCloseTo(1 + 0.3 * 4)
  expect(byModel.get("model-0")!.price).toMatchObject({
    source: "openrouter",
    retrievedAt: "2026-11-17T12:00:00.000Z",
  })
})

test("BYOK always includes the Anthropic and OpenAI lineups, by native provider or slug", () => {
  const lineup = (provider: string, count: number) =>
    Array.from({ length: count }, (_, index) =>
      candidate(provider, `${provider}-${index}`, {
        score: 10 + index,
        openrouter: { prompt: "0.000001", completion: "0.000001" },
      }),
    )
  const viaOpenRouter = candidate("openrouter", "anthropic/claude-x", {
    score: 5,
    openrouter: { prompt: "0.000001", completion: "0.000001" },
    slug: "anthropic/claude-x",
  })
  const entries = buildCatalogSet({
    ...base,
    candidates: [
      // Enough better-scored models elsewhere that the lineups get in only as BYOK.
      ...Array.from({ length: CATALOG_TOP }, (_, index) =>
        candidate("acme", `top-${index}`, {
          score: 500 + index,
          openrouter: { prompt: "0.000001", completion: "0.000001" },
        }),
      ),
      ...lineup("anthropic", BYOK_PER_PROVIDER + 3),
      ...lineup("openai", 2),
      viaOpenRouter,
    ],
  })
  const providers = entries.filter((item) => item.route.providerID === "anthropic")
  // Every scored model is in; the BYOK cap only limits the unscored remainder of a lineup.
  expect(providers).toHaveLength(BYOK_PER_PROVIDER + 3)
  // The best-scored of a lineup are kept.
  expect(
    providers.some((item) => item.route.modelID === `anthropic-${BYOK_PER_PROVIDER + 2}`),
  ).toBe(true)
  expect(entries.filter((item) => item.route.providerID === "openai")).toHaveLength(2)
})

test("an unavailable source contributes nothing: the next in order prices the model, or none does", () => {
  const nativeOnly = candidate("openai", "gpt-6", { score: 50, native: { input: 2, output: 8 } })
  const orderedOpenCodeFirst = buildCatalogSet({
    ...base,
    priceSources: ["opencode", "openrouter"],
    sourceDates: { openrouter: null, opencode: "2026-11-17T09:00:00.000Z" },
    candidates: [nativeOnly],
  })
  expect(orderedOpenCodeFirst[0]!.price).toMatchObject({ source: "opencode", input: 2, output: 8 })
  // OpenRouter is configured first but has no entry: it is skipped, not guessed.
  const skipped = buildCatalogSet({ ...base, candidates: [nativeOnly] })
  expect(skipped[0]!.price?.source).toBe("opencode")
  // No source prices the model: it is not in the catalog part, and nothing is invented.
  const unpriced = buildCatalogSet({
    ...base,
    candidates: [candidate("openai", "gpt-7", { score: 90 })],
  })
  expect(unpriced).toEqual([])
  // With no candidates at all (every source unreachable) only observed and routed models remain.
  const none = buildCatalogSet({
    ...base,
    candidates: [],
    routed: [{ providerID: "openai", modelID: "gpt-6" }],
  })
  expect(none.map((item) => item.tags)).toEqual([["routed"]])
  expect(none[0]!.projection).toBeNull()
  // Without a token profile nothing is projected either.
  expect(
    buildCatalogSet({ ...base, profile: undefined, candidates: [nativeOnly] })[0]!.projection,
  ).toBeNull()
})

test("the projected frontier is cost lower, score higher", () => {
  const entries = buildCatalogSet({
    ...base,
    candidates: [
      candidate("a", "cheap-weak", {
        score: 30,
        openrouter: { prompt: "0.0000005", completion: "0.000001" },
      }),
      candidate("a", "mid", {
        score: 50,
        openrouter: { prompt: "0.000002", completion: "0.000004" },
      }),
      candidate("a", "dominated", {
        score: 40,
        openrouter: { prompt: "0.000003", completion: "0.000006" },
      }),
      candidate("a", "strong", {
        score: 70,
        openrouter: { prompt: "0.000006", completion: "0.00002" },
      }),
      candidate("a", "unscored", {
        openrouter: { prompt: "0.0000001", completion: "0.0000001" },
        score: null,
      }),
    ],
    observed: new Map([
      [
        routeKey({ providerID: "a", modelID: "unscored" }),
        { configurationID: "u", usd: 0.01, tokens: 1, accepted: 2, terminal: 2 },
      ],
    ]),
  })
  const frontier = entries.filter((item) => item.frontier).map((item) => item.route.modelID)
  expect(frontier.toSorted()).toEqual(["cheap-weak", "mid", "strong"])
})

const row = (id: string, extra: Partial<CatalogEntry>): CatalogEntry => ({
  id,
  route: { providerID: "p", modelID: id },
  label: id,
  tags: ["catalog"],
  price: null,
  projection: null,
  score: null,
  contextTokens: null,
  observed: null,
  frontier: false,
  ...extra,
})

test("ranking puts the best trade-off first, then cost per task ascending, unpriced last", () => {
  const ranked = rankCatalog([
    row("c-dear", { projection: { usd: 3, cacheAtInputRate: false } }),
    row("none-b", {}),
    row("a-frontier-dear", { frontier: true, projection: { usd: 2, cacheAtInputRate: false } }),
    row("b-cheap", { projection: { usd: 0.5, cacheAtInputRate: false } }),
    row("a-frontier-cheap", { frontier: true, projection: { usd: 0.4, cacheAtInputRate: false } }),
    // Observed cost is measured, and wins over a projection for ordering.
    row("measured", {
      observed: { configurationID: "m", usd: 1, tokens: null, accepted: 1, terminal: null },
      projection: { usd: 9, cacheAtInputRate: false },
    }),
    row("none-a", {}),
  ])
  expect(ranked.map((item) => item.id)).toEqual([
    "a-frontier-cheap",
    "a-frontier-dear",
    "b-cheap",
    "measured",
    "c-dear",
    "none-a",
    "none-b",
  ])
  expect(entryCost(ranked[3]!)).toBe(1)
})

test("without any public score the catalog is the first priced models in the source's own order", () => {
  const listed = (index: number, modelID: string, extra: Record<string, unknown> = {}) => {
    const entry = candidate("acme", modelID, {
      openrouter: { prompt: "0.000001", completion: "0.000004" },
    }) as unknown as {
      externalModelEvidence: { records: unknown[] }
      externalModel: Record<string, unknown>
    }
    entry.externalModelEvidence = {
      records: [{ source: "openrouter-models", recordIndex: index, recordID: modelID }],
    } as never
    Object.assign(entry.externalModel, extra)
    return entry as unknown as ModelCandidate
  }
  const candidates = [
    // Listed out of order on purpose: the listing index, not array position, decides.
    ...Array.from({ length: CATALOG_SOURCE_TOP + 10 }, (_, index) =>
      listed(CATALOG_SOURCE_TOP + 10 - index, `m-${index}`),
    ),
    // Image-only and no-tools models are left out when their source says so.
    listed(0, "image-only", { architecture: { outputModalities: ["image"] } }),
    listed(0, "no-tools", { supportedParameters: ["temperature"] }),
  ]
  const { entries, summary } = buildCatalog({ ...base, candidates })
  const names = new Set(entries.map((item) => item.route.modelID))
  expect(entries).toHaveLength(CATALOG_SOURCE_TOP)
  expect(names.has("image-only")).toBe(false)
  expect(names.has("no-tools")).toBe(false)
  // The highest listing indexes are the earliest in the list: the last-built candidates.
  expect(names.has(`m-${CATALOG_SOURCE_TOP + 9}`)).toBe(true)
  expect(names.has("m-0")).toBe(false)
  expect(summary).toMatchObject({
    primary: CATALOG_SOURCE_TOP,
    ordering: "OpenRouter listing order",
    orderSource: "openrouter",
  })
  expect(catalogSummaryText(summary)).toBe(`${CATALOG_SOURCE_TOP} by OpenRouter listing order`)
})

test("the summary counts what BYOK and routing added beyond the primary set", () => {
  const priced = { openrouter: { prompt: "0.000001", completion: "0.000001" } }
  const { summary, entries } = buildCatalog({
    ...base,
    candidates: [
      candidate("anthropic", "claude-a", priced),
      candidate("anthropic", "claude-b", priced),
      candidate("openai", "gpt-a", priced),
      candidate("zed", "router-pick", priced),
    ],
    routed: [{ providerID: "zed", modelID: "router-pick" }],
  })
  // Few enough models that listing order takes them all; BYOK adds nothing beyond that.
  expect(summary.primary).toBe(4)
  expect(summary.anthropic).toBe(0)
  expect(summary.routed).toBe(1)
  expect(entries.find((item) => item.route.modelID === "claude-a")!.tags).toContain("catalog")
  expect(catalogSummaryText({ ...summary, anthropic: 12, openai: 12, routed: 3 })).toBe(
    "4 by OpenRouter listing order · 12 Anthropic · 12 OpenAI · 3 routed",
  )
})
