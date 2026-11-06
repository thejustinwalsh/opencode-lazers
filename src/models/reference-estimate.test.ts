import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import capturedCatalogs from "../../test/models-current-price-index/fixtures/captured-catalogs.json" with { type: "json" }
import { ModelEvidenceSnapshotSchema } from "./source-schema.ts"
import type { ModelEvidenceComparisonSourceRead } from "./source-store.ts"
import {
  calculateModelDecisionReferenceEstimate,
  type ReferenceEstimateSession,
} from "./reference-estimate.ts"
import {
  defaultModelPriceSourcePolicy,
  ModelPriceSourceSettingsSchema,
} from "./price-source-settings.ts"

const route = { providerID: "openai", modelID: "fixture-model", variant: null }
const completeCategories: ReferenceEstimateSession["categories"] = {
  uncachedInput: { tokens: 10, status: "observed" },
  output: { tokens: 20, status: "observed" },
  reasoning: { tokens: 0, status: "observed" },
  cacheRead: { tokens: 2, status: "observed" },
  cacheWrite: { tokens: 3, status: "observed" },
}

function session(
  sessionID: string,
  options: Partial<ReferenceEstimateSession> = {},
): ReferenceEstimateSession {
  return {
    sessionID,
    route,
    routeStatus: "single-observed-route",
    shared: false,
    attributable: true,
    categories: completeCategories,
    attempts: [{ id: `${sessionID}-accepted`, state: "accepted", retry: false }],
    ...options,
  }
}

function settings(
  sources: ("openrouter" | "opencode")[] = ["openrouter"],
  openrouterAccess:
    "configured" | "not-configured" | "reauthentication-required" | "unknown" = "configured",
) {
  return ModelPriceSourceSettingsSchema.parse({
    policy: { ...defaultModelPriceSourcePolicy(), revision: 3, sources },
    access: { openrouter: openrouterAccess, opencode: "not-configured" },
  })
}

function source(
  options: {
    tiers?: Array<{
      minPromptTokens: number | null
      utcStart?: number | null
      utcEnd?: number | null
      prompt: string | null
      completion: string | null
      inputCacheRead: string | null
      inputCacheWrite: string | null
    }>
    stale?: boolean
  } = {},
): ModelEvidenceComparisonSourceRead {
  const original = ModelEvidenceSnapshotSchema.parse(capturedCatalogs.openrouter)
  if (original.source !== "openrouter-models") throw new Error("Expected OpenRouter fixture")
  const snapshot = ModelEvidenceSnapshotSchema.parse({
    ...original,
    snapshotID: randomUUID(),
    projectDirectory: "/models-reference-estimate-test",
    generation: 4,
    retrievedAt: "2026-11-05T12:00:00.000Z",
    records: original.records.map((record) => {
      if (record.id !== "openai/fixture-model" || !record.prices || !options.tiers) return record
      return { ...record, prices: { ...record.prices, tiers: options.tiers } }
    }),
  })
  if (snapshot.source !== "openrouter-models") throw new Error("Expected OpenRouter fixture")
  return {
    source: "openrouter-models",
    storage: "ready",
    snapshotState: "available",
    snapshotID: snapshot.snapshotID,
    snapshot,
    refresh: {
      source: "openrouter-models",
      state: "succeeded",
      generation: options.stale ? 5 : snapshot.generation,
      startedAt: "2026-11-05T11:59:00.000Z",
      completedAt: "2026-11-05T12:00:00.000Z",
      latestSnapshotID: options.stale ? randomUUID() : snapshot.snapshotID,
      latestRetrievedAt: options.stale ? "2026-11-05T13:00:00.000Z" : snapshot.retrievedAt,
      latestRecordCount: snapshot.records.length,
      errorCode: null,
      httpStatus: 200,
    },
  }
}

function estimate(
  options: {
    acceptedTaskCount?: number
    relatedTaskCount?: number
    unknownRouteTaskCount?: number
    relatedSessions?: ReferenceEstimateSession[]
    missingAttribution?: boolean
    settings?: ReturnType<typeof settings>
    catalog?: ModelEvidenceComparisonSourceRead
    route?: typeof route
  } = {},
) {
  return calculateModelDecisionReferenceEstimate({
    route: options.route ?? route,
    acceptedTaskCount: options.acceptedTaskCount ?? 1,
    relatedTaskCount: options.relatedTaskCount ?? 1,
    unknownRouteTaskCount: options.unknownRouteTaskCount ?? 0,
    relatedSessions: options.relatedSessions ?? [session("one")],
    unattributedSessionCount: 0,
    missingAttribution: options.missingAttribution ?? false,
    settings: options.settings ?? settings(),
    identityCatalogSource: options.catalog ?? source(),
  })
}

test("reference estimate prices exact route cohort effort once and divides only by accepted tasks", () => {
  const first = session("retry-session", {
    attempts: [
      { id: "failed", state: "failed", retry: false },
      { id: "retry", state: "accepted", retry: true },
    ],
  })
  const second = session("accepted-session", {
    attempts: [{ id: "accepted", state: "accepted", retry: false }],
  })
  const catalog = source()
  const result = estimate({
    acceptedTaskCount: 2,
    relatedTaskCount: 2,
    relatedSessions: [first, first, second],
    catalog,
  })

  expect(result).toMatchObject({
    status: "exact",
    route,
    acceptedTaskCount: 2,
    numeratorUSD: 0.00046,
    valueUSDPerAcceptedTask: 0.00023,
    identityStatus: "exact",
    provenance: {
      source: "openrouter-models",
      recordID: "openai/fixture-model",
      freshness: "current",
    },
    coverage: {
      categories: {
        uncachedInput: { tokens: 20, status: "observed", rateCoverage: "complete" },
      },
      retries: {
        status: "complete",
        attemptCount: 3,
        failedAttemptCount: 1,
        retryAttemptCount: 1,
        attemptsWithCompleteUsage: 3,
      },
      attribution: {
        status: "complete",
        relatedTaskCount: 2,
        includedSessionCount: 2,
      },
    },
  })
  expect(result.provenance.snapshotID).toBe(catalog.snapshotID)
})

test("supported prompt tiers publish a conditional envelope without selecting a call tier", () => {
  const base = source()
  const record = base.snapshot?.records.find(
    (item) => item.kind === "openrouter-model" && item.id === "openai/fixture-model",
  )
  if (!record || record.kind !== "openrouter-model" || !record.prices)
    throw new Error("OpenRouter fixture record is absent")
  const first = record.prices.tiers[0]!
  const catalog = source({
    tiers: [
      first,
      {
        ...first,
        minPromptTokens: 100_000,
        prompt: "0.000004",
        completion: "0.000020",
        inputCacheRead: "0.000001",
        inputCacheWrite: "0.000006",
      },
    ],
  })
  const result = estimate({ catalog })
  expect(result.status).toBe("conditional")
  expect(result.numeratorUSD).toBeNull()
  expect(result.valueUSDPerAcceptedTask).toBeNull()
  expect(result.numeratorRangeUSD).toEqual({ minimum: 0.00023, maximum: 0.00046 })
  expect(result.rangeUSDPerAcceptedTask).toEqual({ minimum: 0.00023, maximum: 0.00046 })
})

test("conditional tier bounds contain independently priced mixed low- and high-prompt calls", () => {
  const catalog = source({
    tiers: [
      {
        minPromptTokens: null,
        prompt: "0.000001",
        completion: "0.0001",
        inputCacheRead: "0",
        inputCacheWrite: "0",
      },
      {
        minPromptTokens: 100,
        prompt: "0.0001",
        completion: "0.000001",
        inputCacheRead: "0",
        inputCacheWrite: "0",
      },
    ],
  })
  const mixedCalls = [
    session("low-prompt-call", {
      categories: {
        uncachedInput: { tokens: 1, status: "observed" },
        output: { tokens: 100, status: "observed" },
        reasoning: { tokens: 0, status: "observed" },
        cacheRead: { tokens: 0, status: "observed" },
        cacheWrite: { tokens: 0, status: "observed" },
      },
    }),
    session("high-prompt-call", {
      categories: {
        uncachedInput: { tokens: 100, status: "observed" },
        output: { tokens: 0, status: "observed" },
        reasoning: { tokens: 0, status: "observed" },
        cacheRead: { tokens: 0, status: "observed" },
        cacheWrite: { tokens: 0, status: "observed" },
      },
    }),
  ]
  const result = estimate({
    acceptedTaskCount: 4,
    relatedTaskCount: 4,
    relatedSessions: mixedCalls,
    catalog,
  })
  const independentlyPricedTotal = 1 * 0.000001 + 100 * 0.0001 + 100 * 0.0001 + 0 * 0.000001

  expect(independentlyPricedTotal).toBeCloseTo(0.020001, 12)
  expect(result.status).toBe("conditional")
  expect(result.numeratorUSD).toBeNull()
  expect(result.valueUSDPerAcceptedTask).toBeNull()
  expect(result.numeratorRangeUSD?.minimum).toBeCloseTo(0.000201, 12)
  expect(result.numeratorRangeUSD?.maximum).toBeCloseTo(0.0201, 12)
  expect(result.numeratorRangeUSD?.minimum).toBeLessThanOrEqual(independentlyPricedTotal)
  expect(result.numeratorRangeUSD?.maximum).toBeGreaterThanOrEqual(independentlyPricedTotal)
  expect(result.rangeUSDPerAcceptedTask?.minimum).toBeCloseTo(0.000201 / 4, 12)
  expect(result.rangeUSDPerAcceptedTask?.maximum).toBeCloseTo(0.0201 / 4, 12)
})

test("conditional tier bounds contain independently enumerated small mixed-call assignments", () => {
  const catalog = source({
    tiers: [
      {
        minPromptTokens: null,
        prompt: "0.000001",
        completion: "0.0001",
        inputCacheRead: "0",
        inputCacheWrite: "0",
      },
      {
        minPromptTokens: 100,
        prompt: "0.0001",
        completion: "0.000001",
        inputCacheRead: "0",
        inputCacheWrite: "0",
      },
    ],
  })
  const calls = [
    { input: 2, output: 5 },
    { input: 7, output: 1 },
    { input: 3, output: 4 },
  ]
  const result = estimate({
    relatedSessions: [
      session("enumerated-calls", {
        categories: {
          uncachedInput: {
            tokens: calls.reduce((total, call) => total + call.input, 0),
            status: "observed",
          },
          output: {
            tokens: calls.reduce((total, call) => total + call.output, 0),
            status: "observed",
          },
          reasoning: { tokens: 0, status: "observed" },
          cacheRead: { tokens: 0, status: "observed" },
          cacheWrite: { tokens: 0, status: "observed" },
        },
      }),
    ],
    catalog,
  })
  const range = result.numeratorRangeUSD
  if (!range) throw new Error("Expected a conditional mixed-tier range")

  expect(result.status).toBe("conditional")
  expect(result.numeratorUSD).toBeNull()
  for (let assignment = 0; assignment < 2 ** calls.length; assignment += 1) {
    const independentlyPricedTotal = calls.reduce((total, call, index) => {
      const highPromptTier = (assignment & (1 << index)) !== 0
      return (
        total +
        call.input * (highPromptTier ? 0.0001 : 0.000001) +
        call.output * (highPromptTier ? 0.000001 : 0.0001)
      )
    }, 0)
    expect(range.minimum).toBeLessThanOrEqual(independentlyPricedTotal + 1e-15)
    expect(range.maximum).toBeGreaterThanOrEqual(independentlyPricedTotal - 1e-15)
  }
})

test("known mixed-tier subtotals are bounded while a missing positive rate keeps total partial", () => {
  const catalog = source({
    tiers: [
      {
        minPromptTokens: null,
        prompt: "0.000001",
        completion: "0.0001",
        inputCacheRead: "0",
        inputCacheWrite: null,
      },
      {
        minPromptTokens: 100,
        prompt: "0.0001",
        completion: "0.000001",
        inputCacheRead: "0",
        inputCacheWrite: null,
      },
    ],
  })
  const mixedCalls = [
    session("low-prompt-partial-call", {
      categories: {
        uncachedInput: { tokens: 1, status: "observed" },
        output: { tokens: 100, status: "observed" },
        reasoning: { tokens: 0, status: "observed" },
        cacheRead: { tokens: 0, status: "observed" },
        cacheWrite: { tokens: 2, status: "observed" },
      },
    }),
    session("high-prompt-partial-call", {
      categories: {
        uncachedInput: { tokens: 100, status: "observed" },
        output: { tokens: 0, status: "observed" },
        reasoning: { tokens: 0, status: "observed" },
        cacheRead: { tokens: 0, status: "observed" },
        cacheWrite: { tokens: 3, status: "observed" },
      },
    }),
  ]
  const result = estimate({
    acceptedTaskCount: 3,
    relatedTaskCount: 3,
    relatedSessions: mixedCalls,
    catalog,
  })
  const independentlyPricedKnownSubtotal = 1 * 0.000001 + 100 * 0.0001 + 100 * 0.0001

  expect(result.status).toBe("partial")
  expect(result.numeratorUSD).toBeNull()
  expect(result.numeratorRangeUSD).toBeNull()
  expect(result.knownSubtotalRangeUSD?.minimum).toBeLessThanOrEqual(
    independentlyPricedKnownSubtotal,
  )
  expect(result.knownSubtotalRangeUSD?.maximum).toBeGreaterThanOrEqual(
    independentlyPricedKnownSubtotal,
  )
  expect(result.knownSubtotalRangeUSDPerAcceptedTask?.minimum).toBeCloseTo(
    (result.knownSubtotalRangeUSD?.minimum ?? Number.NaN) / 3,
    12,
  )
  expect(result.knownSubtotalRangeUSDPerAcceptedTask?.maximum).toBeCloseTo(
    (result.knownSubtotalRangeUSD?.maximum ?? Number.NaN) / 3,
    12,
  )
  expect(result.coverage.categories.cacheWrite).toMatchObject({
    tokens: 5,
    status: "observed",
    rateCoverage: "missing",
  })
  expect(result.reasons).toContain("missing-rate")
})

test("missing positive cache-write rates expose only the computable priced subtotal", () => {
  const catalog = source({
    tiers: [
      {
        minPromptTokens: null,
        prompt: "0.000002",
        completion: "0.000010",
        inputCacheRead: "0.0000005",
        inputCacheWrite: null,
      },
    ],
  })
  const result = estimate({ catalog })
  expect(result.status).toBe("partial")
  expect(result.numeratorUSD).toBeNull()
  expect(result.numeratorRangeUSD).toBeNull()
  expect(result.valueUSDPerAcceptedTask).toBeNull()
  expect(result.rangeUSDPerAcceptedTask).toBeNull()
  expect(result.knownSubtotalUSD).toBeCloseTo(0.000221, 12)
  expect(result.coverage.categories.cacheWrite).toMatchObject({
    tokens: 3,
    status: "observed",
    rateCoverage: "missing",
  })
  expect(result.reasons).toContain("missing-rate")
})

test("missing usage and partial attribution never publish a complete total or finite bound", () => {
  const missingOutput = session("missing", {
    categories: {
      ...completeCategories,
      output: { tokens: null, status: "missing" },
    },
  })
  const missing = estimate({ relatedSessions: [missingOutput] })
  expect(missing.status).toBe("partial")
  expect(missing.numeratorUSD).toBeNull()
  expect(missing.numeratorRangeUSD).toBeNull()
  expect(missing.knownSubtotalUSD).toBeCloseTo(0.00003, 12)
  expect(missing.coverage.categories.output).toMatchObject({
    tokens: null,
    status: "missing",
    rateCoverage: "unknown",
  })

  const attributed = estimate({ missingAttribution: true })
  expect(attributed.status).toBe("partial")
  expect(attributed.numeratorUSD).toBeNull()
  expect(attributed.numeratorRangeUSD).toBeNull()
  expect(attributed.knownSubtotalUSD).toBeCloseTo(0.00023, 12)
  expect(attributed.coverage.attribution.status).toBe("partial")
  expect(attributed.reasons).toContain("partial-attribution")

  const unknownRouteSession = session("unknown-route", {
    route: null,
    routeStatus: "identity-unavailable",
    attempts: [{ id: "unknown-route-failure", state: "failed", retry: true }],
  })
  const unknownRoute = estimate({
    unknownRouteTaskCount: 1,
    relatedSessions: [session("known-route"), unknownRouteSession],
  })
  expect(unknownRoute.status).toBe("partial")
  expect(unknownRoute.numeratorUSD).toBeNull()
  expect(unknownRoute.knownSubtotalUSD).toBeCloseTo(0.00023, 12)
  expect(unknownRoute.coverage.attribution).toMatchObject({
    status: "partial",
    unknownRouteTaskCount: 1,
    unknownRouteSessionCount: 1,
  })
  expect(unknownRoute.coverage.retries).toMatchObject({
    status: "partial",
    failedAttemptCount: 1,
    retryAttemptCount: 1,
  })
})

test("zero accepted tasks, disabled or unavailable identity and stale or unsupported source stay explicit", () => {
  const zero = estimate({ acceptedTaskCount: 0 })
  expect(zero.status).toBe("zero-accepted")
  expect(zero.numeratorUSD).toBeCloseTo(0.00023, 12)
  expect(zero.valueUSDPerAcceptedTask).toBeNull()
  expect(zero.rangeUSDPerAcceptedTask).toBeNull()

  const disabled = estimate({ settings: settings(["opencode"]) })
  expect(disabled.status).toBe("unavailable")
  expect(disabled.provenance.availability).toBe("disabled")
  expect(disabled.reasons).toContain("openrouter-disabled")
  expect(disabled.knownSubtotalUSD).toBeNull()

  const unavailableAccess = estimate({
    settings: settings(["openrouter"], "reauthentication-required"),
  })
  expect(unavailableAccess.status).toBe("unavailable")
  expect(unavailableAccess.provenance.availability).toBe("unavailable")
  expect(unavailableAccess.provenance.access).toBe("reauthentication-required")
  expect(unavailableAccess.reasons).toContain("openrouter-unavailable")

  const present = source()
  const missingCatalog: ModelEvidenceComparisonSourceRead = {
    ...present,
    snapshotState: "none",
    snapshotID: null,
    snapshot: null,
  }
  const unavailableCatalog = estimate({ catalog: missingCatalog })
  expect(unavailableCatalog.status).toBe("unavailable")
  expect(unavailableCatalog.identityStatus).toBe("source-unavailable")
  expect(unavailableCatalog.reasons).toContain("catalog-unavailable")

  const absent = estimate({ route: { ...route, modelID: "missing-model" } })
  expect(absent.status).toBe("unavailable")
  expect(absent.identityStatus).toBe("supported-but-absent")
  expect(absent.reasons).toContain("identity-absent")

  const stale = estimate({ catalog: source({ stale: true }) })
  expect(stale.provenance.freshness).toBe("stale")
  expect(stale.reasons).toContain("stale-source")

  const unsupported = source({
    tiers: [
      {
        minPromptTokens: null,
        utcStart: 1_000,
        utcEnd: null,
        prompt: "0.000002",
        completion: "0.000010",
        inputCacheRead: "0.0000005",
        inputCacheWrite: "0.000003",
      },
    ],
  })
  const selectorEstimate = estimate({ catalog: unsupported })
  expect(selectorEstimate.status).toBe("partial")
  expect(selectorEstimate.knownSubtotalUSD).toBeNull()
  expect(selectorEstimate.reasons).toContain("unsupported-selector")
})

test("observed zero avoids an unnecessary missing rate and nonfinite published prices are rejected", () => {
  const catalog = source({
    tiers: [
      {
        minPromptTokens: null,
        prompt: "0.000002",
        completion: "0.000010",
        inputCacheRead: "0.0000005",
        inputCacheWrite: null,
      },
    ],
  })
  const zeroCacheWrite = session("zero-cache-write", {
    categories: { ...completeCategories, cacheWrite: { tokens: 0, status: "observed" } },
  })
  const exact = estimate({ catalog, relatedSessions: [zeroCacheWrite] })
  expect(exact.status).toBe("exact")
  expect(exact.coverage.categories.cacheWrite.rateCoverage).toBe("not-required")

  const nonfinite = source({
    tiers: [
      {
        minPromptTokens: null,
        prompt: "1e999",
        completion: "0.000010",
        inputCacheRead: "0.0000005",
        inputCacheWrite: "0.000003",
      },
    ],
  })
  const invalidArithmetic = estimate({ catalog: nonfinite })
  expect(invalidArithmetic.status).toBe("partial")
  expect(invalidArithmetic.numeratorUSD).toBeNull()
  expect(invalidArithmetic.knownSubtotalUSD).toBeNull()
  expect(invalidArithmetic.reasons).toContain("nonfinite-arithmetic")
})

test("ordinary and exponent-form published zero rates price positive usage as zero", () => {
  const catalog = source({
    tiers: [
      {
        minPromptTokens: null,
        prompt: "0",
        completion: "0e-8",
        inputCacheRead: "0.000e+8",
        inputCacheWrite: "0",
      },
    ],
  })
  const result = estimate({ catalog })

  expect(result.status).toBe("exact")
  expect(result.numeratorUSD).toBe(0)
  expect(result.valueUSDPerAcceptedTask).toBe(0)
  expect(result.coverage.categories.uncachedInput.rateCoverage).toBe("complete")
  expect(result.coverage.categories.output.rateCoverage).toBe("complete")
  expect(result.coverage.categories.cacheRead.rateCoverage).toBe("complete")
  expect(result.coverage.categories.cacheWrite.rateCoverage).toBe("complete")
  expect(result.reasons).not.toContain("nonfinite-arithmetic")
})

test("representable positive exponent rates remain computable", () => {
  const catalog = source({
    tiers: [
      {
        minPromptTokens: null,
        prompt: "1e-8",
        completion: "2e-8",
        inputCacheRead: "3e-8",
        inputCacheWrite: "4e-8",
      },
    ],
  })
  const result = estimate({ catalog })

  expect(result.status).toBe("exact")
  expect(result.numeratorUSD).toBeCloseTo(
    10 * 0.00000001 + 20 * 0.00000002 + 2 * 0.00000003 + 3 * 0.00000004,
    15,
  )
  expect(result.reasons).not.toContain("nonfinite-arithmetic")
})

test("nonzero rates that underflow to zero are rejected rather than published as zero", () => {
  const catalog = source({
    tiers: [
      {
        minPromptTokens: null,
        prompt: "1e-999",
        completion: "0.000010",
        inputCacheRead: "0.0000005",
        inputCacheWrite: "0.000003",
      },
    ],
  })
  const result = estimate({ catalog })

  expect(result.status).toBe("partial")
  expect(result.numeratorUSD).toBeNull()
  expect(result.numeratorRangeUSD).toBeNull()
  expect(result.knownSubtotalUSD).toBeNull()
  expect(result.reasons).toContain("nonfinite-arithmetic")
})
