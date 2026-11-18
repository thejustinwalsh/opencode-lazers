import { expect, test } from "bun:test"
import { inspectTrajectory } from "../trajectory/read.ts"
import { InspectTrajectoryInput } from "../trajectory/schema.ts"
import { makeFixture, cursorSecret, taskID } from "../../test/trajectory/fixture.ts"
import {
  exactRouteMatch,
  candidateFocusIndex,
  boundedModelLabel,
  currentMarketEstimateSummary,
  compactCount,
  formatDate,
  formatPriceRange,
  joinSegments,
  numericValue,
  selectedModelFacts,
  boundedModelEffortLabel,
  chartModelEffortLabel,
  modelEffortLabel,
  modelDisplayName,
  modelDisplayLabel,
  readTaskEffortBasis,
  routeLabel,
  sourceState,
} from "./comparison-presentation.ts"
import type { ModelCandidate, ModelSource } from "./comparison-presentation.ts"
import type { ModelDecisionEstimate } from "./decision-contract.ts"
import type { ModelDecisionReferenceEstimate } from "./reference-estimate.ts"

test("categorized effort parser reads the real versioned task basis and not legacy token scalars", async () => {
  const fixture = makeFixture()
  try {
    const report = await inspectTrajectory(
      fixture.store,
      fixture.host,
      "project",
      InspectTrajectoryInput.parse({ taskID }),
      cursorSecret,
    )
    const basis = readTaskEffortBasis(report)
    expect(basis?.schemaVersion).toBe(1)
    expect(basis?.attempts.count).toBe(2)
    expect(basis?.usage.coverage.totalUniqueSessions).toBe(2)
    expect(basis?.usage.categories.uncachedInput.unit).toBe("tokens")
    expect(basis?.routes.assignments).toHaveLength(2)
    expect(basis?.cost.fullTaskCostUSD).toMatchObject({ status: "unknown", valueUSD: null })
    expect(basis?.cost.marketEquivalentCostUSD).toMatchObject({ status: "unknown", valueUSD: null })
    expect(basis?.quality).toMatchObject({ status: "not-recorded", value: null })
  } finally {
    fixture.close()
  }
})

test("missing categorized projection remains unavailable even when legacy scalar tokens exist", () => {
  expect(
    readTaskEffortBasis({
      effort: { tokenUsage: { legacyTokenCount: 12_000 }, taskEffortBasis: null },
    }),
  ).toBeUndefined()
})

test("route identity comparison includes provider, model and exact variant", () => {
  const candidate = {
    identity: { providerID: "openai", modelID: "gpt-6", variant: "high" },
  } as ModelCandidate
  expect(
    exactRouteMatch({ providerID: "openai", modelID: "gpt-6", variant: "high" }, candidate),
  ).toBe(true)
  expect(
    exactRouteMatch({ providerID: "openai", modelID: "gpt-6", variant: null }, candidate),
  ).toBe(false)
  expect(routeLabel({ providerID: "openai", modelID: "gpt-6", variant: "high" })).toBe(
    "openai / gpt-6 · high",
  )
})

test("model names use exact provider/model metadata independent of effort and fallback without guessing", () => {
  const candidates = [
    {
      identity: { providerID: "openai", modelID: "gpt-6", variant: null },
      native: { name: "Cached GPT-6" },
    },
  ]
  const catalog = [
    { providerID: "openai", id: "gpt-6-mini", name: "GPT-6 Mini" },
    { providerID: "openai", id: "gpt-6", name: "GPT-6 from native catalog" },
  ]

  expect(
    modelDisplayName(
      { providerID: "openai", modelID: "gpt-6", variant: "effort-not-in-catalog" },
      candidates,
      catalog,
    ),
  ).toBe("GPT-6 from native catalog")
  expect(
    modelDisplayName(
      { providerID: "anthropic", modelID: "gpt-6", variant: null },
      candidates,
      catalog,
    ),
  ).toBe("gpt-6")
  expect(
    modelDisplayName({ providerID: "openai", modelID: "gpt-6", variant: "low" }, candidates, []),
  ).toBe("Cached GPT-6")
  expect(boundedModelLabel("a-model-id-that-is-far-too-long-to-display-in-one-row", 18)).toBe(
    "a-model-id-that-i…",
  )
})

test("ambiguous metadata falls back to the route and colliding catalog names remain distinguishable", () => {
  const routeA = { providerID: "provider-a", modelID: "model-a", variant: null }
  const routeB = { providerID: "provider-b", modelID: "model-b", variant: null }
  const routeC = { providerID: "provider-a", modelID: "model-c", variant: null }
  const routeAHigh = { ...routeA, variant: "high" }
  const collidingCatalog = [
    { providerID: "provider-a", id: "model-a", name: "Same long catalog display name" },
    { providerID: "provider-b", id: "model-b", name: "Same long catalog display name" },
    { providerID: "provider-a", id: "model-c", name: "Same long catalog display name" },
  ]
  expect(modelDisplayName(routeA, [], collidingCatalog)).toBe("Same long catalog display name")
  const routes = [routeA, routeB, routeC, routeAHigh]
  const labels = routes.map((route) => modelDisplayLabel(route, routes, [], collidingCatalog))
  expect(labels).toEqual([
    "Same long catalog display name · provider-a / model-a",
    "Same long catalog display name · provider-b / model-b",
    "Same long catalog display name · provider-a / model-c",
    "Same long catalog display name · provider-a / model-a · high",
  ])
  expect(new Set(labels).size).toBe(routes.length)
  expect(modelDisplayLabel(routeA, [routeA, routeAHigh], [], collidingCatalog)).toBe(
    "Same long catalog display name · provider-a / model-a",
  )
  expect(modelDisplayLabel(routeAHigh, [routeA, routeAHigh], [], collidingCatalog)).toBe(
    "Same long catalog display name · provider-a / model-a · high",
  )

  const ambiguousCatalog = [
    { providerID: "provider-a", id: "model-a", name: "Conflicting name one" },
    { providerID: "provider-a", id: "model-a", name: "Conflicting name two" },
  ]
  expect(modelDisplayName(routeA, [], ambiguousCatalog)).toBe("model-a")
  expect(modelDisplayName(routeA, [], [])).toBe("model-a")
})

test("chart labels keep the friendly model and effort while route identity stays exact", () => {
  const route = { providerID: "openai", modelID: "gpt-6-luna", variant: "high" }
  const fullDisplayLabel = "GPT-6 Luna · openai / gpt-6-luna · high"

  expect(modelEffortLabel(fullDisplayLabel, route)).toBe("GPT-6 Luna · high")
  expect(chartModelEffortLabel(fullDisplayLabel, route, 18)).toBe("GPT-6 Luna\nhigh")
  expect(
    chartModelEffortLabel("Qwen 7 · qwen / qwen-7 · preview-effort", {
      providerID: "qwen",
      modelID: "qwen-7",
      variant: "preview-effort",
    }),
  ).toBe("Qwen 7\npreview-effort")
  const longVariant = `preview-effort-${"x".repeat(512 - "preview-effort-".length)}`
  const longIdentity = chartModelEffortLabel(`Qwen 7 · qwen / qwen-7 · ${longVariant}`, {
    providerID: "qwen",
    modelID: "qwen-7",
    variant: longVariant,
  })
  expect(longIdentity).toBe("Qwen 7\npreview-effort-xx…")
  expect(longIdentity.length).toBeLessThanOrEqual(37)
  expect(boundedModelEffortLabel(modelEffortLabel(fullDisplayLabel, route), 16)).toBe(
    "GPT-6 Lu… · high",
  )
  expect(routeLabel(route)).toBe("openai / gpt-6-luna · high")
  expect(modelEffortLabel(fullDisplayLabel, route)).not.toMatch(/[pme]:/)
})

test("candidate keyboard focus is bounded and does not intercept unrelated keys", () => {
  expect(candidateFocusIndex(0, 3, "ArrowUp")).toBe(0)
  expect(candidateFocusIndex(0, 3, "ArrowDown")).toBe(1)
  expect(candidateFocusIndex(1, 3, "Home")).toBe(0)
  expect(candidateFocusIndex(1, 3, "End")).toBe(2)
  expect(candidateFocusIndex(1, 3, "Enter")).toBeUndefined()
  expect(candidateFocusIndex(0, 0, "ArrowDown")).toBeUndefined()
})

test("source presentation distinguishes no-cache failure from missing refresh history and dated cache", () => {
  const failed = {
    source: "native-catalog",
    storage: "ready",
    snapshotState: "none",
    selectedSnapshotID: null,
    refresh: { state: "failed" },
    snapshot: null,
  } as ModelSource
  expect(sourceState(failed)).toContain("latest refresh failed")

  const missingHistory = {
    ...failed,
    storage: "missing-refresh-table",
    refresh: null,
  } as ModelSource
  expect(sourceState(missingHistory)).toContain("no refresh history")

  const cached = {
    ...failed,
    snapshotState: "available",
    snapshot: { recordCount: 3, retrievedAt: "2026-11-03T00:00:00.000Z" },
  } as ModelSource
  expect(sourceState(cached)).toContain("3 records · retrieved")
})

const marketEstimate = (
  status: ModelDecisionEstimate["status"],
  currentMarketUSD: { minimum: number; maximum: number } | null,
  observationCount = 2,
) =>
  ({
    status,
    observationCount,
    range: { tokens: null, currentMarketUSD },
    ...(status === "partial" ? { missing: ["current-price"] } : {}),
  }) as ModelDecisionEstimate

const referenceEstimate = (change: Partial<ModelDecisionReferenceEstimate> = {}) =>
  ({
    status: "exact",
    basis: "openrouter-published-model-reference-cost-per-accepted-task",
    route: { providerID: "openai", modelID: "gpt-6", variant: null },
    acceptedTaskCount: 2,
    numeratorUSD: 0.2,
    numeratorRangeUSD: null,
    valueUSDPerAcceptedTask: 0.1,
    rangeUSDPerAcceptedTask: null,
    knownSubtotalUSD: null,
    knownSubtotalRangeUSD: null,
    knownSubtotalUSDPerAcceptedTask: null,
    knownSubtotalRangeUSDPerAcceptedTask: null,
    identityStatus: "exact",
    provenance: {
      source: "openrouter-models",
      policyRevision: 1,
      availability: "available",
      access: "configured",
      snapshotID: "snapshot:openrouter:1",
      generation: 1,
      retrievedAt: "2026-11-05T12:00:00.000Z",
      sourceURL: "https://openrouter.ai/api/v1/models",
      recordID: "openai/gpt-6",
      recordIndex: 0,
      freshness: "current",
    },
    coverage: {
      categories: {
        uncachedInput: { tokens: 10, status: "observed", rateCoverage: "complete" },
        output: { tokens: 5, status: "observed", rateCoverage: "complete" },
        reasoning: { tokens: 0, status: "observed", rateCoverage: "not-required" },
        cacheRead: { tokens: 0, status: "observed", rateCoverage: "not-required" },
        cacheWrite: { tokens: 0, status: "observed", rateCoverage: "not-required" },
      },
      retries: {
        status: "complete",
        attemptCount: 2,
        failedAttemptCount: 0,
        retryAttemptCount: 0,
        attemptsWithCompleteUsage: 2,
        failedAttemptsWithCompleteUsage: 0,
        retryAttemptsWithCompleteUsage: 0,
      },
      attribution: {
        status: "complete",
        relatedTaskCount: 2,
        unknownRouteTaskCount: 0,
        relatedSessionCount: 2,
        matchedRouteSessionCount: 2,
        includedSessionCount: 2,
        otherRouteSessionCount: 0,
        mixedRouteSessionCount: 0,
        unknownRouteSessionCount: 0,
        sharedSessionCount: 0,
        unattributedSessionCount: 0,
      },
    },
    reasons: [],
    ...change,
  }) as ModelDecisionReferenceEstimate

test("selected current-market summary rounds producer scalars and preserves tiny positive references", () => {
  const configured = currentMarketEstimateSummary({
    estimate: marketEstimate("available", { minimum: 0.123456, maximum: 0.123456 }),
    referenceEstimate: referenceEstimate({
      valueUSDPerAcceptedTask: 9,
      numeratorUSD: 36,
    }),
    acceptedTaskCount: 4,
    priceSource: "opencode",
    priceFreshness: "current",
  })
  expect(configured?.amount).toBe("≈$0.123 / accepted task")
  expect(configured?.context).toBe("OpenCode model catalog · current")
  expect(configured?.title).toContain("0.123456")

  const tiny = currentMarketEstimateSummary({
    estimate: marketEstimate("unknown", null),
    referenceEstimate: referenceEstimate({
      numeratorUSD: 2.469e-11,
      valueUSDPerAcceptedTask: 1.2345e-11,
    }),
    acceptedTaskCount: 2,
    priceSource: "unavailable",
    priceFreshness: "unavailable",
  })
  expect(tiny?.amount).toBe("≈$1.23e-11 / accepted task")
  expect(tiny?.title).toContain("1.2345e-11")

  const staleProducer = currentMarketEstimateSummary({
    estimate: marketEstimate("partial", { minimum: 0.00000004, maximum: 0.00000012 }),
    referenceEstimate: referenceEstimate({ valueUSDPerAcceptedTask: 8 }),
    acceptedTaskCount: 3,
    priceSource: "openrouter",
    priceFreshness: "stale",
  })
  expect(staleProducer?.amount).toBe("≈$4e-8–$1.2e-7 priced portion / accepted task")
  expect(staleProducer?.context).toBe("OpenRouter model catalog · range · stale")
  expect(staleProducer?.title).toContain("exact USD per accepted task 4e-8–1.2e-7")
  expect(staleProducer?.title).toContain("partial observed cohort")
  expect(staleProducer?.title).toContain("denominator 3 accepted tasks")
  expect(staleProducer?.context).not.toContain("partial observed cohort")
})

test("selected current-market summary identifies conditional ranges and stale producer prices", () => {
  const conditional = currentMarketEstimateSummary({
    estimate: marketEstimate("unknown", null),
    referenceEstimate: referenceEstimate({
      status: "conditional",
      numeratorUSD: null,
      numeratorRangeUSD: { minimum: 0.0000004, maximum: 0.0000012 },
      valueUSDPerAcceptedTask: null,
      rangeUSDPerAcceptedTask: { minimum: 0.00000004, maximum: 0.00000012 },
      provenance: {
        ...referenceEstimate().provenance,
        freshness: "stale",
      },
    }),
    acceptedTaskCount: 2,
    priceSource: "openrouter",
    priceFreshness: "current",
  })
  expect(conditional?.amount).toBe("≈$4e-8–$1.2e-7 / accepted task")
  expect(conditional?.context).toBe("OpenRouter model catalog · range · stale")
  expect(conditional?.title).toContain("retrieved 2026-11-05T12:00:00.000Z")
  expect(conditional?.title).toContain("denominator 2 accepted tasks")
})

test("selected current-market summary keeps partial subtotals qualified and omits unknown costs", () => {
  const partial = currentMarketEstimateSummary({
    estimate: marketEstimate("unknown", null),
    referenceEstimate: referenceEstimate({
      status: "partial",
      numeratorUSD: null,
      valueUSDPerAcceptedTask: null,
      knownSubtotalUSD: 0.0000001,
      knownSubtotalUSDPerAcceptedTask: 0.00000005,
      coverage: {
        ...referenceEstimate().coverage,
        retries: { ...referenceEstimate().coverage.retries, status: "partial" },
      },
    }),
    acceptedTaskCount: 1,
    priceSource: "openrouter",
    priceFreshness: "current",
  })
  expect(partial?.amount).toBe("≈$5e-8 priced portion / accepted task")
  expect(partial?.context).toBe("OpenRouter model catalog · current")
  expect(partial?.amount).not.toContain("priced subtotal")
  expect(partial?.context).not.toContain("remainder unknown")
  expect(partial?.title).toContain("total and remainder unknown")
  expect(partial?.title).toContain("denominator 2 accepted tasks")
  expect(partial?.amount).not.toContain("complete")

  const zeroDenominator = currentMarketEstimateSummary({
    estimate: marketEstimate("zero-accepted", null),
    referenceEstimate: referenceEstimate({
      status: "zero-accepted",
      acceptedTaskCount: 0,
      numeratorUSD: null,
      valueUSDPerAcceptedTask: null,
    }),
    acceptedTaskCount: 0,
    priceSource: "openrouter",
    priceFreshness: "current",
  })
  expect(zeroDenominator).toBeUndefined()

  const unpriced = currentMarketEstimateSummary({
    estimate: marketEstimate("unknown", null),
    referenceEstimate: referenceEstimate({
      status: "unavailable",
      numeratorUSD: null,
      valueUSDPerAcceptedTask: null,
      identityStatus: "source-unavailable",
      provenance: {
        ...referenceEstimate().provenance,
        availability: "unavailable",
        source: null,
        access: "not-configured",
        snapshotID: null,
        generation: null,
        retrievedAt: null,
        sourceURL: null,
        recordID: null,
        recordIndex: null,
        freshness: "unavailable",
      },
    }),
    acceptedTaskCount: 1,
    priceSource: "unavailable",
    priceFreshness: "unavailable",
  })
  expect(unpriced).toBeUndefined()
})

const unknownWords = /unknown|unavailable|not reported|not recorded/i

test("a missing optional fact is absent instead of labelled", () => {
  expect(formatDate(null)).toBeUndefined()
  expect(formatDate("not a date")).toBeUndefined()
  expect(numericValue(null)).toBeUndefined()
  expect(numericValue(1234)).toBe((1234).toLocaleString())
  expect(joinSegments(["a", undefined, null, false, "b"])).toBe("a · b")
})

test("market summaries never name an unknown age or retrieval date", () => {
  const summary = currentMarketEstimateSummary({
    estimate: marketEstimate("available", { minimum: 0.1, maximum: 0.2 }),
    referenceEstimate: referenceEstimate({
      provenance: { ...referenceEstimate().provenance, freshness: "unknown", retrievedAt: null },
    }),
    acceptedTaskCount: 3,
    priceSource: "openrouter",
    priceFreshness: "unavailable",
  })
  expect(summary?.context).toBe("OpenRouter model catalog · range")
  expect(`${summary?.amount} ${summary?.context} ${summary?.title}`).not.toMatch(unknownWords)

  const reference = currentMarketEstimateSummary({
    estimate: marketEstimate("unknown", null),
    referenceEstimate: referenceEstimate({
      provenance: { ...referenceEstimate().provenance, freshness: "unknown", retrievedAt: null },
    }),
    acceptedTaskCount: 3,
    priceSource: "unavailable",
    priceFreshness: "unavailable",
  })
  expect(`${reference?.amount} ${reference?.context} ${reference?.title}`).not.toMatch(
    /freshness unknown|retrieval date unavailable/,
  )
})

test("the selected-model facts are a rounded price range, counts and per-task averages", () => {
  const facts = selectedModelFacts({
    estimate: {
      status: "available",
      basis: "empirical-observed-spread",
      observationCount: 9,
      range: {
        tokens: { minimum: 5_000_000, maximum: 7_000_000 },
        currentMarketUSD: { minimum: 0.35, maximum: 0.67 },
      },
      confidenceInterval: null,
    } as unknown as ModelDecisionEstimate,
    efficiency: {
      status: "available",
      tokensPerAcceptedTask: 6_200_000,
      currentMarketUSDPerAcceptedTask: 0.5,
      observationCount: 9,
    } as never,
    cohort: {
      acceptedTaskCount: 9,
      terminalTaskCount: 11,
      attemptCount: 11,
      failedAttemptCount: 2,
      retryAttemptCount: 0,
    } as never,
  })
  expect(facts).toEqual({
    price: "$0.35 – 0.67",
    accepted: 9,
    terminal: 11,
    tokens: "6.2M",
    attempts: "1.2",
  })
  expect(JSON.stringify(facts)).not.toMatch(unknownWords)
  expect(formatPriceRange({ minimum: 0.35, maximum: 0.35 })).toBe("$0.35")
  expect(compactCount(840_000)).toBe("840k")
  expect(compactCount(930)).toBe("930")
})

test("a partial price is omitted from the facts rather than shown as a price", () => {
  const facts = selectedModelFacts({
    estimate: marketEstimate("partial", { minimum: 0.1, maximum: 0.2 }),
    referenceEstimate: referenceEstimate({
      status: "partial",
      valueUSDPerAcceptedTask: null,
      knownSubtotalUSDPerAcceptedTask: 0.00000005,
    }),
    efficiency: {
      status: "partial",
      tokensPerAcceptedTask: null,
      currentMarketUSDPerAcceptedTask: null,
    } as never,
    cohort: {
      acceptedTaskCount: 1,
      terminalTaskCount: 10,
      attemptCount: 14,
      failedAttemptCount: 6,
      retryAttemptCount: 4,
    } as never,
  })
  expect(facts.price).toBeUndefined()
  expect(facts.tokens).toBeUndefined()
  expect(facts.accepted).toBe(1)
  expect(
    selectedModelFacts({
      estimate: marketEstimate("zero-accepted", null),
      efficiency: {} as never,
      cohort: { acceptedTaskCount: 0, terminalTaskCount: 3, attemptCount: 3 } as never,
    }),
  ).toEqual({})
})
