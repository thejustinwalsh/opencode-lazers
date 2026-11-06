import { expect, test } from "bun:test"
import {
  ENDPOINT_PRICING_PRODUCTS,
  EndpointPricingReadSchema,
  EndpointPricingRecordSchema,
  endpointPricingProduct,
} from "./endpoint-pricing.ts"
import type {
  EndpointPricingProductID,
  EndpointPricingRead,
  EndpointPricingRecord,
} from "./endpoint-pricing.ts"
import { calculateKnownUsageMarket } from "./market-range.ts"
import type {
  KnownUsageMarketSession,
  KnownUsagePerCall,
  MarketRangeRoute,
} from "./market-range.ts"
import captured from "../../test/models-identity/fixtures/captured-20261103.json" with { type: "json" }
import capturedGo from "../../test/models-identity/fixtures/captured-go-openrouter-20261103.json" with { type: "json" }
import { ModelEvidenceSnapshotSchema } from "./source-schema.ts"
import type { ModelEvidenceSnapshot } from "./source-schema.ts"
import type { ModelEvidenceComparisonSourceRead } from "./source-store.ts"
import { resolveModelIdentity } from "./model-identity.ts"

const lunaRoute = { providerID: "openrouter", modelID: "openai/gpt-6-luna", variant: null }
const kimiRoute = { providerID: "openrouter", modelID: "moonshotai/kimi-k3.1-pro", variant: null }
const qwenRoute = { providerID: "openrouter", modelID: "qwen/qwen3.8-flash", variant: null }
const parsedCatalog = ModelEvidenceSnapshotSchema.parse(captured.openrouter.snapshot)
const parsedGoCatalog = ModelEvidenceSnapshotSchema.parse(capturedGo.openrouter.snapshot)

if (parsedCatalog.source !== "openrouter-models" || parsedGoCatalog.source !== "openrouter-models")
  throw new Error("Expected OpenRouter model-identity catalog fixtures")

function catalogRead(
  snapshot: Extract<ModelEvidenceSnapshot, { source: "openrouter-models" }>,
): ModelEvidenceComparisonSourceRead {
  return {
    source: "openrouter-models",
    storage: "ready",
    snapshotState: "available",
    snapshotID: snapshot.snapshotID,
    refresh: null,
    snapshot,
  }
}

const directCatalogRead = catalogRead(parsedCatalog)
const goCatalogRead = catalogRead(parsedGoCatalog)

function identityForRoute(
  route: MarketRangeRoute,
  catalogSource?: ModelEvidenceComparisonSourceRead,
) {
  const source =
    catalogSource ??
    (route.providerID === "opencode-go" ||
    route.modelID.includes("kimi-k3.1-pro") ||
    route.modelID.includes("qwen3.8-flash")
      ? goCatalogRead
      : directCatalogRead)
  return resolveModelIdentity({
    route: { providerID: route.providerID, modelID: route.modelID },
    nativeEvidence: [],
    catalogSource: source,
  }).resolution
}

const cacheWriteDocumentation = {
  field: "input_cache_write" as const,
  supportedRate: "0" as const,
  sourceURL: "https://openrouter.ai/docs/guides/best-practices/prompt-caching" as const,
  retrievedAt: "2026-11-05T12:00:00.000Z",
  statement: "Moonshot AI prompt caching documentation: cache writes have no cost." as const,
  policyID: "openrouter-moonshot-kimi-mxfp4-cache-write-zero-v1" as const,
  scope: {
    productID: "moonshotai/kimi-k3.1-pro" as const,
    providerName: "Moonshot AI" as const,
    tag: "moonshotai/mxfp4" as const,
    serviceTier: null,
  },
}

function record(
  productID: EndpointPricingProductID,
  identity: { providerName: string; tag: string; serviceTier?: string | null },
  pricing: EndpointPricingRecord["pricing"],
  documentation: EndpointPricingRecord["cacheWriteDocumentation"] = null,
) {
  return EndpointPricingRecordSchema.parse({
    productID,
    name: `${identity.providerName} endpoint`,
    providerName: identity.providerName,
    tag: identity.tag,
    serviceTier: identity.serviceTier ?? null,
    pricing,
    cacheWriteDocumentation: documentation,
  })
}

function endpointRead(
  productID: EndpointPricingProductID,
  item: EndpointPricingRecord,
  state: "succeeded" | "failed" = "succeeded",
): EndpointPricingRead {
  const retrievedAt = "2026-11-05T12:00:00.000Z"
  const generation = state === "succeeded" ? 1 : 2
  const snapshotID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001"
  return EndpointPricingReadSchema.parse({
    state: "partial",
    generation,
    complete: false,
    scenarios: ENDPOINT_PRICING_PRODUCTS.map(({ productID: candidate, sourceURL }) => {
      if (candidate !== productID)
        return {
          productID: candidate,
          sourceURL,
          state: "never",
          generation: 0,
          startedAt: null,
          completedAt: null,
          latestSnapshotID: null,
          latestRetrievedAt: null,
          latestRecordCount: null,
          errorCode: null,
          httpStatus: null,
          snapshot: null,
        }
      const snapshot = {
        snapshotID,
        projectDirectory: "/market-test",
        productID,
        generation: 1,
        retrievedAt,
        sourceURL: endpointPricingProduct(productID).sourceURL,
        httpStatus: 200,
        records: [item],
      }
      return {
        productID,
        sourceURL,
        state,
        generation,
        startedAt: retrievedAt,
        completedAt: retrievedAt,
        latestSnapshotID: snapshotID,
        latestRetrievedAt: retrievedAt,
        latestRecordCount: 1,
        errorCode: state === "failed" ? "network-error" : null,
        httpStatus: state === "failed" ? 503 : null,
        snapshot,
      }
    }),
  })
}

function measures(
  values: Partial<Record<keyof KnownUsageMarketSession["categories"], number | null>> = {},
) {
  return Object.fromEntries(
    (["uncachedInput", "output", "reasoning", "cacheRead", "cacheWrite"] as const).map(
      (category) => {
        const value = Object.hasOwn(values, category) ? values[category]! : 0
        return [
          category,
          {
            tokens: value,
            status: value === null ? "missing" : "observed",
          },
        ]
      },
    ),
  ) as KnownUsageMarketSession["categories"]
}

function usageSession(
  route: MarketRangeRoute,
  categories: KnownUsageMarketSession["categories"],
  options: {
    id?: string
    routeStatus?: KnownUsageMarketSession["routeStatus"]
    shared?: boolean
    attempts?: KnownUsageMarketSession["attempts"]
  } = {},
): KnownUsageMarketSession {
  return {
    sessionID: options.id ?? "ses-market-known",
    route:
      options.routeStatus === "single-observed-route" || options.routeStatus === undefined
        ? route
        : null,
    routeStatus: options.routeStatus ?? "single-observed-route",
    shared: options.shared ?? false,
    categories,
    attempts: options.attempts ?? [
      { id: `attempt-${options.id ?? "known"}`, state: "accepted", retry: false },
    ],
  }
}

function lunaRecord() {
  return record(
    "openai/gpt-6-luna",
    { providerName: "OpenAI", tag: "openai" },
    {
      unit: "USD per token",
      prompt: "0.0000001",
      completion: "0.0000005",
      inputCacheRead: "0.00000001",
      inputCacheWrite: "0.000000125",
      overrides: [
        {
          minPromptTokens: 272_000,
          prompt: "0.0000002",
          completion: "0.00000075",
          inputCacheRead: "0.00000002",
          inputCacheWrite: "0.00000025",
        },
      ],
    },
  )
}

function evaluate(
  route: MarketRangeRoute,
  evidence: EndpointPricingRead,
  sessions: KnownUsageMarketSession[],
  perCallUsage?: readonly KnownUsagePerCall[],
  identity = identityForRoute(route),
) {
  return calculateKnownUsageMarket({
    route,
    identity,
    endpointPricing: evidence,
    sessions,
    perCallUsage,
    perCallCoverageComplete: perCallUsage !== undefined,
  }).scenarios[0]!
}

test("strict Luna prompt thresholds are selected only from complete per-call usage", () => {
  const evidence = endpointRead("openai/gpt-6-luna", lunaRecord())
  const atThreshold = measures({ uncachedInput: 272_000 })
  const aboveThreshold = measures({ uncachedInput: 272_001 })
  const baseCall: KnownUsagePerCall = {
    callID: "api-call-base",
    route: lunaRoute,
    categories: { uncachedInput: 272_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  }
  const overrideCall: KnownUsagePerCall = {
    callID: "api-call-override",
    route: lunaRoute,
    categories: { uncachedInput: 272_001, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  }

  const base = evaluate(lunaRoute, evidence, [usageSession(lunaRoute, atThreshold)], [baseCall])
  const override = evaluate(
    lunaRoute,
    evidence,
    [usageSession(lunaRoute, aboveThreshold)],
    [overrideCall],
  )
  expect(base).toMatchObject({
    status: "exact",
    tierAttribution: {
      status: "resolved-per-call",
      selectedTierIDs: ["base"],
      promptThresholds: [272_000],
      thresholdSemantics:
        "override applies when per-call prompt tokens are greater than minPromptTokens",
    },
  })
  expect(override).toMatchObject({
    status: "exact",
    tierAttribution: { status: "resolved-per-call", selectedTierIDs: ["override:272000:1"] },
  })
  expect(base.valueUSD).toBeCloseTo(0.0272, 12)
  expect(override.valueUSD).toBeCloseTo(0.0544002, 12)
})

test("mixed known Luna tiers sum each attributable call and aggregate usage stays an envelope", () => {
  const evidence = endpointRead("openai/gpt-6-luna", lunaRecord())
  const calls: KnownUsagePerCall[] = [
    {
      callID: "api-call-base",
      route: lunaRoute,
      categories: { uncachedInput: 271_991, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
    },
    {
      callID: "api-call-override",
      route: lunaRoute,
      categories: { uncachedInput: 272_001, output: 6, reasoning: 7, cacheRead: 8, cacheWrite: 9 },
    },
  ]
  const summed = measures({
    uncachedInput: 543_992,
    output: 8,
    reasoning: 10,
    cacheRead: 12,
    cacheWrite: 14,
  })
  const exact = evaluate(lunaRoute, evidence, [usageSession(lunaRoute, summed)], calls)
  const aggregate = evaluate(lunaRoute, evidence, [usageSession(lunaRoute, summed)])
  const base = 271_991 * 0.0000001 + 5 * 0.0000005 + 4 * 0.00000001 + 5 * 0.000000125
  const override = 272_001 * 0.0000002 + 13 * 0.00000075 + 8 * 0.00000002 + 9 * 0.00000025

  expect(exact.valueUSD).toBeCloseTo(base + override, 12)
  expect(exact.tierAttribution.selectedTierIDs).toEqual(["base", "override:272000:1"])
  expect(aggregate).toMatchObject({
    status: "range",
    valueUSD: null,
    tierAttribution: { status: "unresolved", basis: "aggregate-tier-envelope" },
  })
  expect(aggregate.rangeUSD?.minimum).toBeCloseTo(
    543_992 * 0.0000001 + 18 * 0.0000005 + 12 * 0.00000001 + 14 * 0.000000125,
    12,
  )
  expect(aggregate.rangeUSD?.maximum).toBeCloseTo(
    543_992 * 0.0000002 + 18 * 0.00000075 + 12 * 0.00000002 + 14 * 0.00000025,
    12,
  )
})

test("market identity supports direct OpenAI Luna and source-backed configured Go routes", () => {
  const directOpenAI = { providerID: "openai", modelID: "gpt-6-luna", variant: "max" }
  const directIdentity = identityForRoute(directOpenAI)
  expect(structuredClone(directIdentity)).toMatchObject({
    status: "exact",
    productID: "openai/gpt-6-luna",
    basis: "provider-owner-qualification",
    evidence: {
      catalog: [expect.objectContaining({ recordID: "openai/gpt-6-luna" })],
    },
  })
  const directMarket = calculateKnownUsageMarket({
    route: directOpenAI,
    identity: directIdentity,
    endpointPricing: endpointRead("openai/gpt-6-luna", lunaRecord()),
    sessions: [usageSession(directOpenAI, measures({ uncachedInput: 100 }))],
  })
  expect(directMarket).toMatchObject({
    route: directOpenAI,
    identity: { status: "exact", productID: "openai/gpt-6-luna" },
    status: "range",
    scenarios: [
      {
        id: "luna-openai-standard",
        status: "range",
        provenance: { source: "openrouter-endpoints", productID: "openai/gpt-6-luna" },
        tierAttribution: { status: "unresolved", basis: "aggregate-tier-envelope" },
      },
    ],
  })
  expect(directMarket.route).toEqual(directOpenAI)

  const goKimi = { providerID: "opencode-go", modelID: "kimi-k3.1-pro", variant: "high" }
  const kimiIdentity = identityForRoute(goKimi)
  expect(structuredClone(kimiIdentity)).toMatchObject({
    status: "exact",
    productID: "moonshotai/kimi-k3.1-pro",
    basis: "verified-source-backed-route-alias",
    rules: [{ id: "opencode-go-kimi-k3-1-pro-to-openrouter-kimi-k3-1-pro-v1" }],
    evidence: { catalog: [expect.objectContaining({ recordID: "moonshotai/kimi-k3.1-pro" })] },
  })
  const kimiRates = record(
    "moonshotai/kimi-k3.1-pro",
    { providerName: "Moonshot AI", tag: "moonshotai/mxfp4" },
    {
      unit: "USD per token",
      prompt: "0.000002",
      completion: "0.00001",
      inputCacheRead: "0.0000002",
    },
    cacheWriteDocumentation,
  )
  const kimiMarket = calculateKnownUsageMarket({
    route: goKimi,
    identity: kimiIdentity,
    endpointPricing: endpointRead("moonshotai/kimi-k3.1-pro", kimiRates),
    sessions: [usageSession(goKimi, measures({ uncachedInput: 10 }))],
  })
  expect(kimiMarket).toMatchObject({
    route: goKimi,
    status: "exact",
    scenarios: [
      {
        id: "kimi-moonshot-mxfp4",
        status: "exact",
        provenance: { productID: "moonshotai/kimi-k3.1-pro" },
      },
    ],
  })
  expect(kimiMarket.scenarios[0]?.valueUSD).toBeCloseTo(0.00002, 12)

  const goQwen = { providerID: "opencode-go", modelID: "qwen3.8-flash", variant: "medium" }
  const qwenIdentity = identityForRoute(goQwen)
  expect(structuredClone(qwenIdentity)).toMatchObject({
    status: "exact",
    productID: "qwen/qwen3.8-flash",
    basis: "verified-source-backed-route-alias",
    rules: [{ id: "opencode-go-qwen3-8-flash-to-openrouter-qwen3-8-flash-v1" }],
  })
  const qwenRates = record(
    "qwen/qwen3.8-flash",
    { providerName: "Alibaba", tag: "alibaba" },
    {
      unit: "USD per token",
      prompt: "0.00000015",
      completion: "0.00000047",
      inputCacheRead: "0.000000016",
      inputCacheWrite: "0.0000002",
    },
  )
  const qwenMarket = calculateKnownUsageMarket({
    route: goQwen,
    identity: qwenIdentity,
    endpointPricing: endpointRead("qwen/qwen3.8-flash", qwenRates),
    sessions: [usageSession(goQwen, measures({ uncachedInput: 20 }))],
  })
  expect(qwenMarket).toMatchObject({
    route: goQwen,
    status: "exact",
    scenarios: [
      {
        id: "qwen-alibaba",
        status: "exact",
        provenance: { productID: "qwen/qwen3.8-flash" },
      },
    ],
  })
  expect(qwenMarket.scenarios[0]?.valueUSD).toBeCloseTo(0.000003, 12)
})

test("unsupported, ambiguous, and absent route mappings do not borrow endpoint identity", () => {
  const route = { providerID: "openai", modelID: "gpt-6-luna", variant: "max" }
  const lunaCatalogRecord = parsedCatalog.records.find((item) => item.id === "openai/gpt-6-luna")!
  const ambiguousSource = catalogRead(
    ModelEvidenceSnapshotSchema.parse({
      ...parsedCatalog,
      snapshotID: crypto.randomUUID(),
      records: [...parsedCatalog.records, lunaCatalogRecord],
    }) as Extract<ModelEvidenceSnapshot, { source: "openrouter-models" }>,
  )
  const missingSource = catalogRead(
    ModelEvidenceSnapshotSchema.parse({
      ...parsedCatalog,
      snapshotID: crypto.randomUUID(),
      records: parsedCatalog.records.filter((item) => item.id !== "openai/gpt-6-luna"),
    }) as Extract<ModelEvidenceSnapshot, { source: "openrouter-models" }>,
  )
  const cases = [
    {
      route: { providerID: "opencode-go", modelID: "unlisted-model", variant: "max" },
      identity: identityForRoute(
        { providerID: "opencode-go", modelID: "unlisted-model", variant: "max" },
        directCatalogRead,
      ),
      expectedIdentity: "unsupported",
    },
    {
      route,
      identity: identityForRoute(route, ambiguousSource),
      expectedIdentity: "ambiguous",
    },
    {
      route,
      identity: identityForRoute(route, missingSource),
      expectedIdentity: "supported-but-absent",
    },
  ] as const

  for (const item of cases) {
    const market = calculateKnownUsageMarket({
      route: item.route,
      identity: item.identity,
      endpointPricing: endpointRead("openai/gpt-6-luna", lunaRecord()),
      sessions: [usageSession(item.route, measures({ uncachedInput: 100 }))],
    })
    expect(market).toMatchObject({
      route: item.route,
      status: "not-applicable",
      scenarios: [],
    })
    expect(market.identity.status).toBe(item.expectedIdentity)
  }
})

test("Kimi cache-write documentation stays scoped and Qwen writes use only the retained endpoint rate", () => {
  const kimi = record(
    "moonshotai/kimi-k3.1-pro",
    { providerName: "Moonshot AI", tag: "moonshotai/mxfp4" },
    {
      unit: "USD per token",
      prompt: "0.000002",
      completion: "0.00001",
      inputCacheRead: "0.0000002",
    },
    cacheWriteDocumentation,
  )
  const kimiOutput = evaluate(kimiRoute, endpointRead("moonshotai/kimi-k3.1-pro", kimi), [
    usageSession(kimiRoute, measures({ uncachedInput: 10, cacheWrite: 5 })),
  ])
  expect(kimiOutput).toMatchObject({
    status: "exact",
    cacheWriteEvidence: {
      basis: "scoped-documentation",
      policyID: cacheWriteDocumentation.policyID,
      sourceURL: cacheWriteDocumentation.sourceURL,
    },
    rateSets: [{ cacheWrite: "0" }],
  })
  expect(kimiOutput.valueUSD).toBeCloseTo(0.00002, 12)

  const qwenRate = record(
    "qwen/qwen3.8-flash",
    { providerName: "Alibaba", tag: "alibaba" },
    {
      unit: "USD per token",
      prompt: "0.00000015",
      completion: "0.00000047",
      inputCacheRead: "0.000000016",
      inputCacheWrite: "0.0000002",
    },
  )
  const qwenOutput = evaluate(qwenRoute, endpointRead("qwen/qwen3.8-flash", qwenRate), [
    usageSession(qwenRoute, measures({ uncachedInput: 10, cacheWrite: 5 })),
  ])
  expect(qwenOutput).toMatchObject({
    status: "exact",
    cacheWriteEvidence: { basis: "endpoint-rate", policyID: null },
    rateSets: [{ cacheWrite: "0.0000002" }],
  })
  expect(qwenOutput.valueUSD).toBeCloseTo(0.0000015 + 0.000001, 12)

  const unsupportedQwen = record(
    "qwen/qwen3.8-flash",
    { providerName: "Alibaba", tag: "alibaba/us-east-1" },
    { unit: "USD per token", prompt: "0.00000015", completion: "0.00000047" },
  )
  const notGeneralized = evaluate(qwenRoute, endpointRead("qwen/qwen3.8-flash", unsupportedQwen), [
    usageSession(qwenRoute, measures({ uncachedInput: 10, cacheWrite: 5 })),
  ])
  expect(notGeneralized).toMatchObject({ status: "unavailable", valueUSD: null })
})

test("missing rates, missing categories, and measured zeros have different outcomes", () => {
  const qwenMissingWrite = record(
    "qwen/qwen3.8-flash",
    { providerName: "Alibaba", tag: "alibaba" },
    { unit: "USD per token", prompt: null, completion: "0.00000047" },
  )
  const evidence = endpointRead("qwen/qwen3.8-flash", qwenMissingWrite)
  const zeroWrite = evaluate(qwenRoute, evidence, [usageSession(qwenRoute, measures())])
  expect(zeroWrite).toMatchObject({ status: "exact", valueUSD: 0 })
  expect(zeroWrite.missingRates).toEqual([])

  const nonzeroInput = evaluate(qwenRoute, evidence, [
    usageSession(qwenRoute, measures({ uncachedInput: 1 })),
  ])
  expect(nonzeroInput).toMatchObject({
    status: "partial",
    valueUSD: null,
    rangeUSD: null,
    missingRates: ["uncachedInput"],
  })

  const missingTokens = measures({ uncachedInput: null })
  const unknownUsage = evaluate(qwenRoute, evidence, [usageSession(qwenRoute, missingTokens)])
  expect(unknownUsage).toMatchObject({
    status: "partial",
    valueUSD: null,
    rangeUSD: null,
    coverage: { categories: { uncachedInput: { tokens: null, status: "missing" } } },
  })

  const knownOnly = record(
    "qwen/qwen3.8-flash",
    { providerName: "Alibaba", tag: "alibaba" },
    { unit: "USD per token", prompt: "0.00000015", completion: "0.00000047" },
  )
  const partialKnown = evaluate(qwenRoute, endpointRead("qwen/qwen3.8-flash", knownOnly), [
    usageSession(qwenRoute, measures({ uncachedInput: 10, output: null })),
  ])
  expect(partialKnown).toMatchObject({
    status: "partial",
    valueUSD: null,
    rangeUSD: null,
    knownSubtotalUSD: { minimum: 0.0000015, maximum: 0.0000015 },
    coverage: { categories: { output: { tokens: null, status: "missing" } } },
  })
})

test("stale endpoint rates remain visibly stale and incomplete retry histories cannot become totals", () => {
  const stale = endpointRead("openai/gpt-6-luna", lunaRecord(), "failed")
  const matching = usageSession(lunaRoute, measures({ uncachedInput: 100 }), {
    id: "ses-current-route",
    attempts: [{ id: "attempt-current-route", state: "accepted", retry: false }],
  })
  const unknownRetry = usageSession(lunaRoute, measures({ uncachedInput: null }), {
    id: "ses-unknown-retry-route",
    routeStatus: "identity-unavailable",
    attempts: [{ id: "attempt-unknown-retry", state: "failed", retry: true }],
  })
  const partial = evaluate(lunaRoute, stale, [matching, unknownRetry])
  expect(partial).toMatchObject({
    status: "partial",
    freshness: "stale",
    valueUSD: null,
    rangeUSD: null,
    knownSubtotalUSD: { minimum: expect.any(Number), maximum: expect.any(Number) },
    coverage: {
      wholeTaskBound: false,
      route: { matchedRouteSessionCount: 1, unknownRouteSessionCount: 1 },
      retries: {
        status: "partial",
        attemptCount: 2,
        failedAttemptCount: 1,
        retryAttemptCount: 1,
      },
    },
  })

  const failedHistory = evaluate(lunaRoute, stale, [
    usageSession(lunaRoute, measures({ uncachedInput: 10 }), {
      attempts: [{ id: "attempt-failed", state: "failed", retry: false }],
    }),
  ])
  expect(failedHistory).toMatchObject({
    status: "range",
    freshness: "stale",
    coverage: { retries: { status: "complete", failedAttemptCount: 1 } },
  })

  const sharedSessionAttempts = evaluate(lunaRoute, stale, [
    usageSession(lunaRoute, measures({ uncachedInput: 10 }), {
      attempts: [
        { id: "attempt-same-session-one", state: "failed", retry: false },
        { id: "attempt-same-session-two", state: "accepted", retry: true },
      ],
    }),
  ])
  expect(sharedSessionAttempts).toMatchObject({
    status: "partial",
    rangeUSD: null,
    coverage: {
      retries: {
        status: "partial",
        attemptCount: 2,
        attemptsWithCompleteUsage: 0,
      },
    },
  })
})

test("mixed routes and absent endpoint evidence remain unavailable rather than allocating unrelated usage", () => {
  const evidence = endpointRead("openai/gpt-6-luna", lunaRecord())
  const mixed = evaluate(lunaRoute, evidence, [
    usageSession(lunaRoute, measures({ uncachedInput: 100 }), {
      routeStatus: "mixed-observed-routes",
    }),
  ])
  expect(mixed).toMatchObject({
    status: "unavailable",
    valueUSD: null,
    coverage: { route: { mixedRouteSessionCount: 1, includedSessionCount: 0 } },
  })

  const noEvidence = calculateKnownUsageMarket({
    route: lunaRoute,
    identity: identityForRoute(lunaRoute),
    sessions: [usageSession(lunaRoute, measures({ uncachedInput: 100 }))],
  })
  expect(noEvidence).toMatchObject({
    status: "unavailable",
    scenarios: [{ status: "unavailable", freshness: "unavailable", valueUSD: null }],
  })
})
