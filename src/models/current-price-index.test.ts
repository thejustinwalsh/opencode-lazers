import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AccountingAttempt, AccountingRoute } from "../trajectory/accounting.ts"
import captured from "../../test/models-current-price-index/fixtures/captured-catalogs.json" with { type: "json" }
import { ModelEvidenceSnapshotSchema } from "./source-schema.ts"
import type { ModelEvidenceSnapshot } from "./source-schema.ts"
import { ModelEvidenceReadStore, ModelEvidenceStore } from "./source-store.ts"
import { CurrentPriceApplicabilitySchema, buildCurrentPriceIndex } from "./current-price-index.ts"
import type { CurrentPriceApplicability } from "./current-price-index.ts"
import { ModelPriceSourceSettingsSchema } from "./price-source-settings.ts"
import { CurrentPriceIndexSchema } from "./valuation-schema.ts"
import type { CurrentPriceIndex } from "./valuation-schema.ts"
import { projectTaskValuation } from "./valuation.ts"

const projectDirectory = "/models-current-price-index-test"
type NativeSnapshot = Extract<ModelEvidenceSnapshot, { source: "native-catalog" }>
type OpenRouterSnapshot = Extract<ModelEvidenceSnapshot, { source: "openrouter-models" }>
type FixtureSnapshots = { native: NativeSnapshot; openrouter: OpenRouterSnapshot }

function fixtureSnapshots(): FixtureSnapshots {
  const native = ModelEvidenceSnapshotSchema.parse(captured.native)
  const openrouter = ModelEvidenceSnapshotSchema.parse(captured.openrouter)
  if (native.source !== "native-catalog" || openrouter.source !== "openrouter-models")
    throw new Error("Current price index fixture has an unexpected source")
  return { native, openrouter }
}

function makeHarness(
  edit?: (snapshots: FixtureSnapshots) => void,
  include: { native?: boolean; openrouter?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "lazers-current-price-index-"))
  const path = join(root, "models.sqlite")
  const store = new ModelEvidenceStore(path, projectDirectory)
  const generations = store.beginRefresh()
  const snapshots = fixtureSnapshots()
  edit?.(snapshots)

  if (include.native !== false)
    store.saveSnapshot(
      ModelEvidenceSnapshotSchema.parse({
        ...snapshots.native,
        snapshotID: crypto.randomUUID(),
        projectDirectory,
        generation: generations["native-catalog"],
      }) as NativeSnapshot,
    )
  if (include.openrouter !== false)
    store.saveSnapshot(
      ModelEvidenceSnapshotSchema.parse({
        ...snapshots.openrouter,
        snapshotID: crypto.randomUUID(),
        projectDirectory,
        generation: generations["openrouter-models"],
      }) as OpenRouterSnapshot,
    )

  const reader = new ModelEvidenceReadStore(path, projectDirectory)
  return {
    store,
    reader,
    close() {
      reader.close()
      store.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function priceSources(
  sources: Array<"openrouter" | "opencode"> = ["openrouter", "opencode"],
  access: {
    openrouter?: "configured" | "not-configured" | "reauthentication-required" | "unknown"
    opencode?: "configured" | "not-configured" | "reauthentication-required" | "unknown"
  } = {},
  revision = 0,
) {
  return ModelPriceSourceSettingsSchema.parse({
    policy: { schemaVersion: 1, revision, sources, fallback: "whole-model" },
    access: {
      openrouter: access.openrouter ?? "configured",
      opencode: access.opencode ?? "configured",
    },
  })
}

function observation(
  modelID: string,
  options: Partial<Omit<CurrentPriceApplicability, "route">> = {},
  variant: string | null = null,
): CurrentPriceApplicability {
  return CurrentPriceApplicabilitySchema.parse({
    route: { providerID: "openai", modelID, variant },
    ...options,
  })
}

function build(
  harness: ReturnType<typeof makeHarness>,
  observedRoutes: readonly CurrentPriceApplicability[],
  settings = priceSources(),
): CurrentPriceIndex {
  return buildCurrentPriceIndex({
    sourceStore: harness.reader,
    priceSources: settings,
    observedRoutes,
  })
}

function valuationAttempt(route: AccountingRoute): AccountingAttempt {
  return {
    id: "attempt-price-index",
    sessionID: "session-price-index",
    state: "accepted",
    legacyTokenCount: null,
    recordedCostUSD: 0.22,
    planRoute: route,
    planRouteStatus: "explicit",
    frozenRoute: route,
    frozenRouteSource: "runner_attempt.policy.model",
    personaRequested: null,
    personaFrozen: null,
    sessionStatus: "available",
    contextStatus: "available",
    currentRoute: route,
    currentRouteObservedAt: 1_000,
    sessionUsage: {
      input: 1_000,
      output: 100,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    sessionUsageObservedAt: 1_000,
    stepRoutes: [],
  }
}

function value(index: CurrentPriceIndex, route: AccountingRoute) {
  return projectTaskValuation({
    attempts: [valuationAttempt(route)],
    progressFacts: [],
    progressTruncated: false,
    truncatedContextSessionIDs: [],
    currentIndex: index,
  })
}

test("builds schema-valid pins from cached whole catalogs and values fixture usage exactly", () => {
  const harness = makeHarness()
  try {
    const settings = priceSources()
    const settingsBefore = structuredClone(settings)
    const route: AccountingRoute = {
      providerID: "openai",
      modelID: "fixture-model",
      variant: "high",
    }
    const index = build(harness, [observation("fixture-model", {}, "high")], settings)

    expect(CurrentPriceIndexSchema.parse(index)).toEqual(index)
    expect(index.pins).toHaveLength(1)
    expect(index.pins[0]).toMatchObject({
      route,
      productID: "openai/fixture-model",
      configurationID: "6:openai|13:fixture-model|4:high",
      semantics: "average",
      resolution: {
        route: "resolved",
        sku: "resolved",
        configuration: "resolved",
        tier: "resolved",
        schedule: "not-applicable",
      },
      rates: {
        unit: "USD per token",
        uncachedInput: "0.000002",
        completion: "0.000010",
        cacheRead: "0.0000005",
        cacheWrite: "0.000003",
      },
      provenance: {
        source: "openrouter-models",
        generation: 1,
        retrievedAt: "2026-11-04T11:00:00.000Z",
        sourceURL: "https://openrouter.ai/api/v1/models",
        recordIndex: 0,
        recordID: "openai/fixture-model",
      },
    })
    const result = value(index, route)
    expect(result.marketEquivalentCost.valueUSD).toBe(0.003)
    expect(result.marketEquivalentCost.status).toBe("observed")
    expect(result.usage.sessions[0]?.categories).toMatchObject({
      uncachedInput: { value: 1_000 },
      output: { value: 100 },
    })
    expect(result.reportedWorkerCost.valueUSD).toBe(0.22)
    expect(settings).toEqual(settingsBefore)
  } finally {
    harness.close()
  }
})

test("policy order and configured access deterministically choose one complete whole-source quote", () => {
  const harness = makeHarness()
  try {
    const route = observation("fixture-model")
    const defaultOrder = build(harness, [route])
    const reversed = build(harness, [route], priceSources(["opencode", "openrouter"], {}, 1))
    expect(defaultOrder.pins[0]?.provenance.source).toBe("openrouter-models")
    expect(reversed.pins[0]).toMatchObject({
      semantics: "quote",
      rates: {
        unit: "USD per million tokens",
        uncachedInput: 2,
        completion: 10,
        cacheRead: 0.2,
        cacheWrite: 2,
      },
      provenance: { source: "native-catalog", recordID: "fixture-model", recordIndex: 0 },
    })

    for (const access of ["not-configured", "reauthentication-required", "unknown"] as const) {
      const skipped = build(harness, [route], priceSources(undefined, { openrouter: access }))
      expect(skipped.pins[0]?.provenance.source).toBe("native-catalog")
    }
    const disabled = build(harness, [route], priceSources(["opencode"], {}, 2))
    expect(disabled.pins[0]?.provenance.source).toBe("native-catalog")
    const noneEnabled = build(harness, [route], priceSources([], {}, 3))
    expect(noneEnabled.pins).toEqual([])
  } finally {
    harness.close()
  }

  const withoutRouter = makeHarness(undefined, { openrouter: false })
  try {
    expect(build(withoutRouter, [observation("fixture-model")]).pins[0]?.provenance.source).toBe(
      "native-catalog",
    )
  } finally {
    withoutRouter.close()
  }
})

test("an incomplete preferred quote falls back to the next source's entire quote", () => {
  const harness = makeHarness()
  try {
    const index = build(harness, [observation("fallback-model")])
    expect(index.pins).toHaveLength(1)
    expect(index.pins[0]).toMatchObject({
      provenance: {
        source: "native-catalog",
        snapshotID: expect.any(String),
        recordID: "fallback-model",
      },
      rates: {
        unit: "USD per million tokens",
        uncachedInput: 3,
        completion: 11,
        cacheRead: 0.3,
        cacheWrite: 3,
      },
    })
  } finally {
    harness.close()
  }
})

test("unresolved tiers and schedules do not select a base/default quote", () => {
  const harness = makeHarness()
  try {
    const routerOnly = priceSources(["openrouter"])
    expect(build(harness, [observation("tiered-router")], routerOnly).pins).toEqual([])
    const selectedTier = build(
      harness,
      [observation("tiered-router", { openRouterMinPromptTokens: 100_000 })],
      routerOnly,
    )
    expect(selectedTier.pins[0]).toMatchObject({
      tier: { minPromptTokens: 100_000 },
      rates: { uncachedInput: "0.000003", completion: "0.000006" },
    })
    expect(
      build(
        harness,
        [observation("tiered-router", { openRouterMinPromptTokens: 300_000 })],
        routerOnly,
      ).pins,
    ).toEqual([])

    expect(build(harness, [observation("scheduled-router")], routerOnly).pins).toEqual([])
    const scheduled = build(
      harness,
      [
        observation("scheduled-router", {
          openRouterUtcStart: 100,
          openRouterUtcEnd: 200,
        }),
      ],
      routerOnly,
    )
    expect(scheduled.pins[0]).toMatchObject({
      resolution: { schedule: "resolved" },
      tier: { utcStart: 100, utcEnd: 200 },
      rates: { uncachedInput: "0.000003", completion: "0.000006" },
    })

    const nativeOnly = priceSources(["opencode"])
    expect(build(harness, [observation("tiered-native")], nativeOnly).pins).toEqual([])
    const nativeTier = build(
      harness,
      [observation("tiered-native", { nativeContextTierTokens: 400_000 })],
      nativeOnly,
    )
    expect(nativeTier.pins[0]).toMatchObject({
      tier: { contextTierTokens: 400_000 },
      rates: { uncachedInput: 4, completion: 20 },
    })

    const ambiguous = build(
      harness,
      [
        observation("tiered-router", { openRouterMinPromptTokens: null }),
        observation("tiered-router", { openRouterMinPromptTokens: 100_000 }),
      ],
      routerOnly,
    )
    expect(ambiguous.pins).toEqual([])
  } finally {
    harness.close()
  }

  const ambiguousCatalog = makeHarness((snapshots) => {
    snapshots.openrouter.records.push(structuredClone(snapshots.openrouter.records[0]!))
  })
  try {
    expect(
      build(ambiguousCatalog, [observation("fixture-model")], priceSources(["openrouter"])).pins,
    ).toEqual([])
  } finally {
    ambiguousCatalog.close()
  }
})

test("missing rates stay unknown while supported published zero remains a real quote", () => {
  const harness = makeHarness((snapshots) => {
    const empty = snapshots.native.records.find((record) => record.id === "empty-model")!
    if (empty.kind !== "native-model") throw new Error("Expected native model fixture")
    empty.prices = { unit: "USD per million tokens", tiers: [] }
  })
  try {
    const unknown = build(harness, [observation("empty-model")])
    expect(unknown.pins).toEqual([])
    const unknownValue = value(unknown, {
      providerID: "openai",
      modelID: "empty-model",
      variant: null,
    })
    expect(unknownValue.marketEquivalentCost.valueUSD).toBeNull()
    expect(unknownValue.marketEquivalentCost.sessions[0]?.categories.uncachedInput).toMatchObject({
      status: "unknown",
      valueUSD: null,
    })

    const zero = build(harness, [observation("zero-model")])
    expect(zero.pins[0]).toMatchObject({
      provenance: { source: "openrouter-models" },
      rates: {
        uncachedInput: "0",
        completion: "0",
        cacheRead: "0",
        cacheWrite: "0",
      },
    })
  } finally {
    harness.close()
  }
})

test("identity hashes policy, access, selectors and source state while pins retain authentic dates", () => {
  const harness = makeHarness()
  try {
    const route = observation("fixture-model")
    const base = build(harness, [route])
    expect(build(harness, [route]).indexID).toBe(base.indexID)
    expect(build(harness, [route], priceSources(undefined, {}, 1)).indexID).not.toBe(base.indexID)
    expect(
      build(harness, [route], priceSources(undefined, { openrouter: "unknown" })).indexID,
    ).not.toBe(base.indexID)
    expect(
      build(harness, [observation("fixture-model", { openRouterMinPromptTokens: null })]).indexID,
    ).not.toBe(base.indexID)

    const firstPin = base.pins[0]!
    const generation = harness.store.beginRefresh()["openrouter-models"]
    harness.store.failRefresh("openrouter-models", generation, "rate-limited", 429)
    expect(
      harness.reader.readComparisonSources().find((source) => source.source === "openrouter-models")
        ?.refresh,
    ).toMatchObject({ state: "failed", errorCode: "rate-limited", httpStatus: 429 })
    const afterFailedRefresh = build(harness, [route])
    expect(afterFailedRefresh.indexID).not.toBe(base.indexID)
    expect(afterFailedRefresh.pins[0]).toMatchObject({
      provenance: {
        snapshotID: firstPin.provenance.snapshotID,
        generation: firstPin.provenance.generation,
        retrievedAt: "2026-11-04T11:00:00.000Z",
      },
    })
  } finally {
    harness.close()
  }
})

test("the builder consumes complete snapshots, not the first evidence page", () => {
  const harness = makeHarness((snapshots) => {
    const targetNative = structuredClone(snapshots.native.records[0]!)
    const targetRouter = structuredClone(snapshots.openrouter.records[0]!)
    if (targetNative.kind !== "native-model" || targetRouter.kind !== "openrouter-model")
      throw new Error("Expected model fixture records")
    targetNative.id = "late-snapshot-model"
    targetNative.variants = null
    targetRouter.id = "openai/late-snapshot-model"
    targetRouter.canonicalSlug = "openai/late-snapshot-model-20261104"
    snapshots.native.records.push(targetNative)
    for (let index = 0; index < 105; index++) {
      const filler = structuredClone(snapshots.openrouter.records[0]!)
      if (filler.kind !== "openrouter-model") throw new Error("Expected OpenRouter fixture record")
      filler.id = `openai/filler-${index}`
      filler.canonicalSlug = `openai/filler-${index}-20261104`
      snapshots.openrouter.records.push(filler)
    }
    snapshots.openrouter.records.push(targetRouter)
  })
  try {
    const index = build(harness, [observation("late-snapshot-model")])
    expect(index.pins[0]).toMatchObject({
      provenance: {
        source: "openrouter-models",
        recordIndex: 111,
        recordID: "openai/late-snapshot-model",
      },
    })
  } finally {
    harness.close()
  }
})

test("repricing refreshed cached pins changes market value without changing usage or reported charges", () => {
  const harness = makeHarness()
  try {
    const route: AccountingRoute = {
      providerID: "openai",
      modelID: "fixture-model",
      variant: null,
    }
    const observed = [observation("fixture-model")]
    const beforeIndex = build(harness, observed)
    const nextOpenRouter = fixtureSnapshots().openrouter
    const record = nextOpenRouter.records[0]!
    if (record.kind !== "openrouter-model" || !record.prices)
      throw new Error("Expected priced OpenRouter fixture")
    record.prices.tiers[0]!.prompt = "0.000004"
    record.prices.tiers[0]!.completion = "0.000020"
    nextOpenRouter.snapshotID = crypto.randomUUID()
    nextOpenRouter.projectDirectory = projectDirectory
    nextOpenRouter.generation = harness.store.beginRefresh()["openrouter-models"]
    nextOpenRouter.retrievedAt = "2026-11-04T12:00:00.000Z"
    harness.store.saveSnapshot(
      ModelEvidenceSnapshotSchema.parse(nextOpenRouter) as OpenRouterSnapshot,
    )
    const afterIndex = build(harness, observed)
    const before = value(beforeIndex, route)
    const after = value(afterIndex, route)

    expect(after.marketEquivalentCost.valueUSD).toBe(0.006)
    expect(afterIndex.indexID).not.toBe(beforeIndex.indexID)
    expect(afterIndex.pins[0]?.provenance).not.toEqual(beforeIndex.pins[0]?.provenance)
    expect(after.usage).toEqual(before.usage)
    expect(after.reportedWorkerCost).toEqual(before.reportedWorkerCost)
  } finally {
    harness.close()
  }
})
