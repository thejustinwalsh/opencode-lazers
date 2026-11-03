import type { CurrentPriceIndex } from "../../../src/models/valuation-schema.ts"

const route = { providerID: "openrouter", modelID: "vendor/model", variant: null }

const resolution = {
  route: "resolved",
  sku: "resolved",
  configuration: "resolved",
  tier: "resolved",
  schedule: "not-applicable",
} as const

const nativePin = {
  route,
  productID: "vendor/model",
  configurationID: "default",
  semantics: "quote",
  resolution,
  tier: {
    id: "default",
    contextTierTokens: null,
    minPromptTokens: null,
    utcStart: null,
    utcEnd: null,
  },
  rates: {
    unit: "USD per million tokens",
    uncachedInput: 2,
    completion: 10,
    cacheRead: 0.2,
    cacheWrite: 2,
  },
  provenance: {
    source: "native-catalog",
    snapshotID: "30000000-0000-4000-8000-000000000001",
    generation: 1,
    retrievedAt: "2026-11-03T12:00:00.000Z",
    asOf: null,
    sourceURL: "https://opencode.ai/v2/docs/models/",
    recordIndex: 0,
    recordID: "vendor/model",
  },
} satisfies CurrentPriceIndex["pins"][number]

const openRouterPin = {
  route,
  productID: "vendor/model",
  configurationID: "vendor/model-default",
  semantics: "average",
  resolution,
  tier: {
    id: "base",
    contextTierTokens: null,
    minPromptTokens: null,
    utcStart: null,
    utcEnd: null,
  },
  rates: {
    unit: "USD per token",
    uncachedInput: "0.000002",
    completion: "0.000010",
    cacheRead: "0.0000002",
    cacheWrite: "0.000002",
  },
  provenance: {
    source: "openrouter-models",
    snapshotID: "30000000-0000-4000-8000-000000000002",
    generation: 2,
    retrievedAt: "2026-11-03T14:00:00.000Z",
    asOf: null,
    sourceURL: "https://openrouter.ai/api/v1/models",
    recordIndex: 5,
    recordID: "vendor/model",
  },
} satisfies CurrentPriceIndex["pins"][number]

export const nativeMillionTokenIndex = {
  indexID: "native-price-index-1",
  retrievedAt: "2026-11-03T12:00:00.000Z",
  pins: [nativePin],
} satisfies CurrentPriceIndex

export const openRouterPerTokenIndex = {
  indexID: "openrouter-price-index-2",
  retrievedAt: "2026-11-03T14:00:00.000Z",
  pins: [openRouterPin],
} satisfies CurrentPriceIndex

export const repricedOpenRouterIndex = {
  indexID: "openrouter-price-index-3",
  retrievedAt: "2026-11-03T16:00:00.000Z",
  pins: [
    {
      ...openRouterPin,
      rates: {
        unit: "USD per token",
        uncachedInput: "0.000004",
        completion: "0.000020",
        cacheRead: "0.0000004",
        cacheWrite: "0.000004",
      },
      provenance: {
        ...openRouterPin.provenance,
        snapshotID: "30000000-0000-4000-8000-000000000003",
        generation: 3,
        retrievedAt: "2026-11-03T16:00:00.000Z",
      },
    },
  ],
} satisfies CurrentPriceIndex
