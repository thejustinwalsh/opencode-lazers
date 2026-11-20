import { expect, test } from "bun:test"
import type { ManagedUsageGeneration } from "../../src/managed-usage/projection.ts"
import {
  projectManagedUsageValuation,
  managedUsageTotals,
} from "../../src/models/managed-usage-valuation.ts"
import type { CurrentPriceIndex } from "../../src/models/valuation-schema.ts"

const generation: ManagedUsageGeneration = {
  sessionID: "ses-managed",
  assistantMessageID: "msg-managed",
  startSequence: 10,
  terminalSequence: 11,
  startEventIDs: ["event-start"],
  terminalEventIDs: ["event-end"],
  eventFactCount: 2,
  provenanceTruncated: false,
  route: { providerID: "openai", modelID: "fixture-model", variant: "high" },
  routeStatus: "observed",
  categories: {
    uncachedInput: { tokens: 10, status: "observed" },
    output: { tokens: 2, status: "observed" },
    reasoning: { tokens: 3, status: "observed" },
    cacheRead: { tokens: 4, status: "observed" },
    cacheWrite: { tokens: 5, status: "observed" },
  },
  outcome: "succeeded",
  status: "observed",
  association: {
    kind: "task",
    planID: "11111111-1111-4111-8111-111111111111",
    taskID: "22222222-2222-4222-8222-222222222222",
  },
  associationRevision: 1,
  associationBoundarySequence: 4,
  associationReason: null,
}

function index(
  input: {
    rates?: Partial<CurrentPriceIndex["pins"][number]["rates"]>
    indexID?: string
  } = {},
): CurrentPriceIndex {
  return {
    indexID: input.indexID ?? "current-price-index-test",
    retrievedAt: "2026-11-11T00:00:00.000Z",
    pins: [
      {
        route: { providerID: "openai", modelID: "fixture-model", variant: "high" },
        productID: "openai/fixture-model",
        configurationID: "fixture-config",
        semantics: "average",
        resolution: {
          route: "resolved",
          sku: "resolved",
          configuration: "resolved",
          tier: "not-applicable",
          schedule: "not-applicable",
        },
        tier: {
          id: null,
          contextTierTokens: null,
          minPromptTokens: null,
          utcStart: null,
          utcEnd: null,
        },
        rates: {
          unit: "USD per token",
          uncachedInput: "0.000001",
          completion: "0.000002",
          cacheRead: "0.0000005",
          cacheWrite: "0.000003",
          ...input.rates,
        },
        provenance: {
          source: "openrouter-models",
          snapshotID: "33333333-3333-4333-8333-333333333333",
          generation: 1,
          retrievedAt: "2026-11-11T00:00:00.000Z",
          asOf: null,
          sourceURL: "https://openrouter.ai/api/v1/models",
          recordIndex: 0,
          recordID: "openai/fixture-model",
        },
      },
    ],
  }
}

test("managed report values native categories against exact current cached route pins and retains provenance", () => {
  const result = projectManagedUsageValuation({
    calls: [generation],
    index: index(),
    freshness: "current",
    settings: {
      policy: {
        schemaVersion: 1,
        revision: 4,
        sources: ["openrouter", "opencode"],
        fallback: "whole-model",
      },
      access: { openrouter: "configured", opencode: "configured" },
    },
  })
  expect(result.calls[0]?.quote).toMatchObject({
    valueUSD: 0.000037,
    subtotalUSD: 0.000037,
    status: "observed",
    pinStatus: "resolved",
  })
  expect(result.currentPrice).toMatchObject({
    indexID: "current-price-index-test",
    policy: { revision: 4, sources: ["openrouter", "opencode"] },
    pins: [{ provenance: { source: "openrouter-models", recordID: "openai/fixture-model" } }],
  })
  expect(managedUsageTotals(result.calls)).toMatchObject({
    generationCount: 1,
    valueUSD: 0.000037,
    status: "observed",
    marketCategories: {
      uncachedInput: { valueUSD: 0.00001, subtotalUSD: 0.00001, status: "observed" },
      reasoning: { valueUSD: 0.000006, status: "observed" },
    },
  })
  const repriced = projectManagedUsageValuation({
    calls: [generation],
    index: index({
      indexID: "current-price-index-refreshed",
      rates: { completion: "0.000004" },
    }),
    freshness: "current",
  })
  expect(repriced.calls[0]?.quote.valueUSD).toBe(0.000047)
  expect(repriced.calls[0]?.categories).toEqual(generation.categories)
})

test("missing categories and unresolved routes remain unknown, while partial quotes expose only a subtotal", () => {
  const partial = {
    ...generation,
    categories: {
      ...generation.categories,
      output: { tokens: null, status: "missing" as const },
    },
    status: "partial" as const,
  }
  const result = projectManagedUsageValuation({
    calls: [partial],
    index: index(),
    freshness: "current",
  })
  expect(result.calls[0]?.quote).toMatchObject({
    valueUSD: null,
    subtotalUSD: 0.000033,
    status: "partial",
    categories: {
      output: { tokens: null, valueUSD: null, status: "unknown" },
    },
  })
  expect(managedUsageTotals(result.calls)).toMatchObject({
    valueUSD: null,
    subtotalUSD: 0.000033,
    status: "partial",
  })

  const unresolvedRoute = projectManagedUsageValuation({
    calls: [{ ...generation, route: null, routeStatus: "missing" }],
    index: index(),
    freshness: "current",
  })
  expect(unresolvedRoute.calls[0]?.quote.categories.uncachedInput).toMatchObject({
    tokens: 10,
    valueUSD: null,
    status: "unknown",
  })
})

test("stale cached rates remain a labelled subtotal rather than a complete current-market value", () => {
  const result = projectManagedUsageValuation({
    calls: [generation],
    index: index(),
    freshness: "stale",
  })

  expect(result.calls[0]?.quote).toMatchObject({
    valueUSD: null,
    subtotalUSD: 0.000037,
    status: "partial",
  })
  expect(result.currentPrice?.freshness).toBe("stale")
  expect(managedUsageTotals(result.calls)).toMatchObject({
    valueUSD: null,
    subtotalUSD: 0.000037,
    status: "partial",
  })
})

test("unavailable source, conflicting variants, and zero observed usage are not misreported as market cost", () => {
  const unavailable = projectManagedUsageValuation({
    calls: [generation],
    index: null,
    freshness: "unavailable",
  })
  expect(unavailable.calls[0]?.quote).toMatchObject({
    valueUSD: null,
    status: "unavailable",
    categories: { uncachedInput: { valueUSD: null, status: "unavailable" } },
  })

  const zero = {
    ...generation,
    categories: {
      uncachedInput: { tokens: 0, status: "observed" as const },
      output: { tokens: 0, status: "observed" as const },
      reasoning: { tokens: 0, status: "observed" as const },
      cacheRead: { tokens: 0, status: "observed" as const },
      cacheWrite: { tokens: 0, status: "observed" as const },
    },
  }
  const zeroValuation = projectManagedUsageValuation({
    calls: [zero],
    index: null,
    freshness: "unknown",
  })
  expect(zeroValuation.calls[0]?.quote).toMatchObject({
    valueUSD: 0,
    subtotalUSD: 0,
    status: "observed",
  })
  expect(zeroValuation.currentPrice).toBeNull()
})
