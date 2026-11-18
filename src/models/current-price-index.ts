import { createHash } from "node:crypto"
import { z } from "zod"
import {
  modelConfigurationID,
  modelIdentityReference,
  resolveModelIdentity,
} from "./model-identity.ts"
import type { ModelEvidenceComparisonSourceRead, ModelEvidenceReadStore } from "./source-store.ts"
import type { ModelEvidenceSnapshot } from "./source-schema.ts"
import {
  ModelPriceSourceSettingsSchema,
  type ModelPriceSource,
  type ModelPriceSourceSettings,
} from "./price-source-settings.ts"
import { CurrentPriceIndexSchema, ValuationRouteSchema } from "./valuation-schema.ts"
import type { CurrentPriceIndex, CurrentPricePin } from "./valuation-schema.ts"

const FiniteNonnegative = z.number().finite().nonnegative()
const UsageCategoryEvidenceSchema = z.strictObject({
  value: FiniteNonnegative.nullable(),
  status: z.enum(["observed", "partial", "missing", "unavailable"]),
})
const CurrentPriceUsageEvidenceSchema = z.strictObject({
  uncachedInput: UsageCategoryEvidenceSchema.optional(),
  output: UsageCategoryEvidenceSchema.optional(),
  reasoning: UsageCategoryEvidenceSchema.optional(),
  cacheRead: UsageCategoryEvidenceSchema.optional(),
  cacheWrite: UsageCategoryEvidenceSchema.optional(),
})

const USAGE_CATEGORIES = [
  "uncachedInput",
  "output",
  "reasoning",
  "cacheRead",
  "cacheWrite",
] as const
type UsageCategory = (typeof USAGE_CATEGORIES)[number]

/** Route selectors and usage evidence are caller-observed; unresolved choices stay conservative. */
export const CurrentPriceApplicabilitySchema = z.strictObject({
  route: ValuationRouteSchema,
  nativeContextTierTokens: FiniteNonnegative.nullable().optional(),
  openRouterMinPromptTokens: FiniteNonnegative.nullable().optional(),
  openRouterUtcStart: FiniteNonnegative.nullable().optional(),
  openRouterUtcEnd: FiniteNonnegative.nullable().optional(),
  usage: CurrentPriceUsageEvidenceSchema.optional(),
})
export type CurrentPriceApplicability = z.infer<typeof CurrentPriceApplicabilitySchema>

const CurrentPriceIndexBuildInputSchema = z.strictObject({
  priceSources: ModelPriceSourceSettingsSchema,
  observedRoutes: z.array(CurrentPriceApplicabilitySchema).max(4_000),
})

type NativeSnapshot = Extract<ModelEvidenceSnapshot, { source: "native-catalog" }>
type OpenRouterSnapshot = Extract<ModelEvidenceSnapshot, { source: "openrouter-models" }>
type NativeRecord = NativeSnapshot["records"][number]
type OpenRouterRecord = OpenRouterSnapshot["records"][number]
type NativePriceTier = NonNullable<NativeRecord["prices"]>["tiers"][number]
type OpenRouterPriceTier = NonNullable<OpenRouterRecord["prices"]>["tiers"][number]
type SourceRead = ModelEvidenceComparisonSourceRead

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .flatMap((key) =>
        record[key] === undefined ? [] : [`${JSON.stringify(key)}:${canonical(record[key])}`],
      )
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function recordIndex(source: SourceRead, index: number): number {
  const indexes = (source as SourceRead & { recordIndexes?: readonly number[] }).recordIndexes
  return indexes?.[index] ?? index
}

function selectedSource(
  sources: readonly SourceRead[],
  source: "native-catalog" | "openrouter-models",
): SourceRead | null {
  const read = sources.find((candidate) => candidate.source === source)
  return read?.snapshotState === "available" && read.snapshot?.source === source ? read : null
}

function snapshotOf<T extends ModelEvidenceSnapshot["source"]>(
  source: SourceRead | null,
  expected: T,
): Extract<ModelEvidenceSnapshot, { source: T }> | null {
  return source?.snapshot?.source === expected
    ? (source.snapshot as Extract<ModelEvidenceSnapshot, { source: T }>)
    : null
}

function exactNativeRecords(
  source: SourceRead | null,
  route: CurrentPriceApplicability["route"],
): Array<{ record: NativeRecord; recordIndex: number }> {
  const snapshot = snapshotOf(source, "native-catalog")
  if (!snapshot) return []
  return snapshot.records.flatMap((record, index) =>
    record.providerID === route.providerID && record.id === route.modelID
      ? [{ record, recordIndex: recordIndex(source!, index) }]
      : [],
  )
}

function hasNativeConfiguration(
  record: NativeRecord,
  route: CurrentPriceApplicability["route"],
): boolean {
  return (
    route.variant === null || record.variants === null || record.variants.includes(route.variant)
  )
}

function chooseNativeTier(
  tiers: readonly NativePriceTier[],
  applicability: CurrentPriceApplicability,
): NativePriceTier | null {
  if (!tiers.length) return null
  const hasContextTiers = tiers.some((tier) => tier.contextTierTokens !== null)
  const supplied = applicability.nativeContextTierTokens

  if (hasContextTiers && supplied === undefined) return null
  if (supplied !== undefined && !hasContextTiers && supplied !== null) return null
  if (tiers.length === 1 && !hasContextTiers && supplied === undefined) return tiers[0]!

  const matches = tiers.filter((tier) =>
    supplied === undefined ? tier.contextTierTokens === null : tier.contextTierTokens === supplied,
  )
  return matches.length === 1 ? matches[0]! : null
}

function chooseOpenRouterTier(
  tiers: readonly OpenRouterPriceTier[],
  applicability: CurrentPriceApplicability,
): OpenRouterPriceTier | null {
  if (!tiers.length) return null
  const hasPromptTiers = tiers.some((tier) => tier.minPromptTokens !== null)
  const hasScheduleTiers = tiers.some(
    (tier) => (tier.utcStart ?? null) !== null || (tier.utcEnd ?? null) !== null,
  )
  const promptSelector = applicability.openRouterMinPromptTokens
  const utcStartSelector = applicability.openRouterUtcStart
  const utcEndSelector = applicability.openRouterUtcEnd

  if (hasPromptTiers && promptSelector === undefined) return null
  if (hasScheduleTiers && (utcStartSelector === undefined || utcEndSelector === undefined))
    return null
  if (!hasPromptTiers && promptSelector !== undefined && promptSelector !== null) return null
  if (
    !hasScheduleTiers &&
    ((utcStartSelector !== undefined && utcStartSelector !== null) ||
      (utcEndSelector !== undefined && utcEndSelector !== null))
  )
    return null

  if (tiers.length === 1 && !hasPromptTiers && !hasScheduleTiers) return tiers[0]!

  const matches = tiers.filter((tier) => {
    if (hasPromptTiers && tier.minPromptTokens !== promptSelector) return false
    if (
      hasScheduleTiers &&
      ((tier.utcStart ?? null) !== utcStartSelector || (tier.utcEnd ?? null) !== utcEndSelector)
    )
      return false
    if (!hasPromptTiers && promptSelector !== undefined && tier.minPromptTokens !== promptSelector)
      return false
    if (
      !hasScheduleTiers &&
      ((utcStartSelector !== undefined && (tier.utcStart ?? null) !== utcStartSelector) ||
        (utcEndSelector !== undefined && (tier.utcEnd ?? null) !== utcEndSelector))
    )
      return false
    return true
  })
  return matches.length === 1 ? matches[0]! : null
}

function completeObservedZero(
  evidence: NonNullable<CurrentPriceApplicability["usage"]>[UsageCategory] | undefined,
) {
  return evidence?.status === "observed" && evidence.value === 0
}

function rateRequired(usage: CurrentPriceApplicability["usage"], category: UsageCategory) {
  return !completeObservedZero(usage?.[category])
}

function nativeRatesApplicable(tier: NativePriceTier, usage: CurrentPriceApplicability["usage"]) {
  return (
    (!rateRequired(usage, "uncachedInput") || tier.input !== null) &&
    (!(rateRequired(usage, "output") || rateRequired(usage, "reasoning")) ||
      tier.output !== null) &&
    (!rateRequired(usage, "cacheRead") || tier.cacheRead !== null) &&
    (!rateRequired(usage, "cacheWrite") || tier.cacheWrite !== null)
  )
}

function openRouterRatesApplicable(
  tier: OpenRouterPriceTier,
  usage: CurrentPriceApplicability["usage"],
) {
  return (
    (!rateRequired(usage, "uncachedInput") || tier.prompt !== null) &&
    (!(rateRequired(usage, "output") || rateRequired(usage, "reasoning")) ||
      tier.completion !== null) &&
    (!rateRequired(usage, "cacheRead") || tier.inputCacheRead !== null) &&
    (!rateRequired(usage, "cacheWrite") || tier.inputCacheWrite !== null)
  )
}

function selectorIdentity(applicability: CurrentPriceApplicability) {
  return canonical({
    nativeContextTierTokens: applicability.nativeContextTierTokens,
    openRouterMinPromptTokens: applicability.openRouterMinPromptTokens,
    openRouterUtcStart: applicability.openRouterUtcStart,
    openRouterUtcEnd: applicability.openRouterUtcEnd,
  })
}

function combineApplicabilities(
  observations: readonly CurrentPriceApplicability[],
): CurrentPriceApplicability | null {
  const first = observations[0]
  if (!first) return null
  const usage = Object.fromEntries(
    USAGE_CATEGORIES.flatMap((category) =>
      observations.every((observation) => completeObservedZero(observation.usage?.[category]))
        ? [[category, { value: 0, status: "observed" as const }]]
        : [],
    ),
  ) as NonNullable<CurrentPriceApplicability["usage"]>

  return {
    route: first.route,
    nativeContextTierTokens: first.nativeContextTierTokens,
    openRouterMinPromptTokens: first.openRouterMinPromptTokens,
    openRouterUtcStart: first.openRouterUtcStart,
    openRouterUtcEnd: first.openRouterUtcEnd,
    usage,
  }
}

function nativePin(
  source: SourceRead | null,
  route: CurrentPriceApplicability["route"],
  applicability: CurrentPriceApplicability,
): CurrentPricePin | null {
  const snapshot = snapshotOf(source, "native-catalog")
  if (!source || !snapshot) return null
  const matches = exactNativeRecords(source, route)
  if (matches.length !== 1) return null
  const match = matches[0]!
  if (!hasNativeConfiguration(match.record, route) || !match.record.prices) return null
  const tier = chooseNativeTier(match.record.prices.tiers, applicability)
  if (!tier || !nativeRatesApplicable(tier, applicability.usage)) return null

  return CurrentPriceIndexSchema.shape.pins.element.parse({
    route,
    productID: match.record.id,
    configurationID: modelConfigurationID(route.providerID, route.modelID, route.variant),
    semantics: "quote",
    resolution: {
      route: "resolved",
      sku: "resolved",
      configuration: "resolved",
      tier: "resolved",
      schedule: "not-applicable",
    },
    tier: {
      id: tier.contextTierTokens === null ? "default" : `context-${tier.contextTierTokens}`,
      contextTierTokens: tier.contextTierTokens,
      minPromptTokens: null,
      utcStart: null,
      utcEnd: null,
    },
    rates: {
      unit: match.record.prices.unit,
      uncachedInput: tier.input,
      completion: tier.output,
      cacheRead: tier.cacheRead,
      cacheWrite: tier.cacheWrite,
    },
    provenance: {
      source: "native-catalog",
      snapshotID: snapshot.snapshotID,
      generation: snapshot.generation,
      retrievedAt: snapshot.retrievedAt,
      asOf: snapshot.asOf,
      sourceURL: snapshot.sourceURL,
      recordIndex: match.recordIndex,
      recordID: match.record.id,
    },
  })
}

function nativeIdentityEvidence(
  source: SourceRead | null,
  route: CurrentPriceApplicability["route"],
) {
  const snapshot = snapshotOf(source, "native-catalog")
  if (!source || !snapshot) return []
  return exactNativeRecords(source, route).map(({ record, recordIndex }) =>
    modelIdentityReference("native-catalog", snapshot, recordIndex, record.id),
  )
}

function openRouterPin(
  source: SourceRead | null,
  nativeSource: SourceRead | null,
  route: CurrentPriceApplicability["route"],
  applicability: CurrentPriceApplicability,
): CurrentPricePin | null {
  const snapshot = snapshotOf(source, "openrouter-models")
  if (!source || !snapshot) return null
  const identity = resolveModelIdentity({
    route: { providerID: route.providerID, modelID: route.modelID },
    nativeEvidence: nativeIdentityEvidence(nativeSource, route),
    catalogSource: source,
  })
  if (identity.resolution.status !== "exact" || identity.catalogMatches.length !== 1) return null
  const match = identity.catalogMatches[0]!
  if (!match.record.prices) return null
  const tier = chooseOpenRouterTier(match.record.prices.tiers, applicability)
  if (!tier || !openRouterRatesApplicable(tier, applicability.usage)) return null
  const hasSchedule =
    (tier.utcStart ?? null) !== null ||
    (tier.utcEnd ?? null) !== null ||
    snapshot.records.some(
      (record) =>
        record.id === match.record.id &&
        record.prices?.tiers.some(
          (candidate) =>
            (candidate.utcStart ?? null) !== null || (candidate.utcEnd ?? null) !== null,
        ),
    )

  return CurrentPriceIndexSchema.shape.pins.element.parse({
    route,
    productID: identity.resolution.productID,
    configurationID: modelConfigurationID(route.providerID, route.modelID, route.variant),
    semantics: "average",
    resolution: {
      route: "resolved",
      sku: "resolved",
      configuration: "resolved",
      tier: "resolved",
      schedule: hasSchedule ? "resolved" : "not-applicable",
    },
    tier: {
      id:
        tier.minPromptTokens === null &&
        (tier.utcStart ?? null) === null &&
        (tier.utcEnd ?? null) === null
          ? "base"
          : `min-prompt-${tier.minPromptTokens ?? "none"};utc-${tier.utcStart ?? "none"}-${tier.utcEnd ?? "none"}`,
      contextTierTokens: null,
      minPromptTokens: tier.minPromptTokens,
      utcStart: tier.utcStart ?? null,
      utcEnd: tier.utcEnd ?? null,
    },
    rates: {
      unit: match.record.prices.unit,
      uncachedInput: tier.prompt,
      completion: tier.completion,
      cacheRead: tier.inputCacheRead,
      cacheWrite: tier.inputCacheWrite,
    },
    provenance: {
      source: "openrouter-models",
      snapshotID: snapshot.snapshotID,
      generation: snapshot.generation,
      retrievedAt: snapshot.retrievedAt,
      asOf: snapshot.asOf,
      sourceURL: snapshot.sourceURL,
      recordIndex: match.recordIndex,
      recordID: match.record.id,
    },
  })
}

function compareRoutes(left: CurrentPricePin, right: CurrentPricePin): number {
  const key = (pin: CurrentPricePin) =>
    modelConfigurationID(pin.route!.providerID, pin.route!.modelID, pin.route!.variant)
  return key(left).localeCompare(key(right))
}

function inputIdentity(
  settings: ModelPriceSourceSettings,
  observedRoutes: readonly CurrentPriceApplicability[],
  sources: readonly SourceRead[],
) {
  const relevantSources = sources
    .filter((source) => source.source !== "openrouter-benchmarks")
    .map((source) => ({
      source: source.source,
      storage: source.storage,
      snapshotState: source.snapshotState,
      snapshotID: source.snapshotID,
      refresh: source.refresh,
      snapshot: source.snapshot,
    }))
  const routes = [...observedRoutes].sort(
    (left, right) =>
      modelConfigurationID(
        left.route.providerID,
        left.route.modelID,
        left.route.variant,
      ).localeCompare(
        modelConfigurationID(right.route.providerID, right.route.modelID, right.route.variant),
      ) || canonical(left).localeCompare(canonical(right)),
  )
  return canonical({ settings, routes, sources: relevantSources })
}

/** Build valuation pins from configured, cached whole-catalog snapshots only. */
export function buildCurrentPriceIndex(input: {
  sourceStore: Pick<ModelEvidenceReadStore, "readComparisonSources">
  priceSources: ModelPriceSourceSettings
  observedRoutes: readonly CurrentPriceApplicability[]
}): CurrentPriceIndex {
  const parsed = CurrentPriceIndexBuildInputSchema.parse({
    priceSources: input.priceSources,
    observedRoutes: input.observedRoutes,
  })
  const sources = input.sourceStore.readComparisonSources()
  const native = selectedSource(sources, "native-catalog")
  const openRouter = selectedSource(sources, "openrouter-models")
  const routeGroups = new Map<string, Map<string, CurrentPriceApplicability[]>>()

  for (const applicability of parsed.observedRoutes) {
    const routeKey = modelConfigurationID(
      applicability.route.providerID,
      applicability.route.modelID,
      applicability.route.variant,
    )
    const group = routeGroups.get(routeKey) ?? new Map<string, CurrentPriceApplicability[]>()
    const selectors = selectorIdentity(applicability)
    const observations = group.get(selectors) ?? []
    observations.push(applicability)
    group.set(selectors, observations)
    routeGroups.set(routeKey, group)
  }

  const pins: CurrentPricePin[] = []
  for (const group of routeGroups.values()) {
    // Conflicting selectors are unresolved; usage amounts only combine rate requirements.
    if (group.size !== 1) continue
    const observations = group.values().next().value as CurrentPriceApplicability[] | undefined
    const applicability = observations ? combineApplicabilities(observations) : null
    if (!applicability) continue

    for (const priceSource of parsed.priceSources.policy.sources) {
      if (parsed.priceSources.access[priceSource] !== "configured") continue
      const pin = pinFromSource(priceSource, native, openRouter, applicability)
      if (pin) {
        pins.push(pin)
        break
      }
    }
  }

  const indexID = `current-price-index-v1:${createHash("sha256")
    .update(inputIdentity(parsed.priceSources, parsed.observedRoutes, sources))
    .digest("hex")}`
  return CurrentPriceIndexSchema.parse({
    indexID,
    retrievedAt: new Date().toISOString(),
    pins: pins.sort(compareRoutes),
  })
}

function pinFromSource(
  source: ModelPriceSource,
  native: SourceRead | null,
  openRouter: SourceRead | null,
  applicability: CurrentPriceApplicability,
): CurrentPricePin | null {
  // models.dev prices the catalog and unobserved models; recorded usage is repriced from the
  // whole-model OpenRouter and OpenCode quotes only.
  if (source === "models-dev") return null
  return source === "opencode"
    ? nativePin(native, applicability.route, applicability)
    : openRouterPin(openRouter, native, applicability.route, applicability)
}
