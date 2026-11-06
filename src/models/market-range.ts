import { z } from "zod"
import {
  ENDPOINT_PRICING_PRODUCTS,
  EndpointPricingProductIDSchema,
  endpointPricingProduct,
} from "./endpoint-pricing.ts"
import type {
  EndpointPricingProductID,
  EndpointPricingRead,
  EndpointPricingRecord,
  EndpointPricingScenario,
} from "./endpoint-pricing.ts"
import { ModelIdentityResolutionSchema } from "./model-identity.ts"
import type { ModelIdentityResolution } from "./model-identity.ts"

const Nonnegative = z.number().finite().nonnegative()
const Count = z.number().int().nonnegative().max(100_000)
const Generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const NullableText = z.string().max(512).nullable()
const Range = z
  .strictObject({ minimum: Nonnegative, maximum: Nonnegative })
  .refine((range) => range.minimum <= range.maximum, {
    message: "A known-usage range cannot have its minimum above its maximum",
  })

export const MarketRangeRouteSchema = z.strictObject({
  providerID: z.string().min(1).max(512),
  modelID: z.string().min(1).max(512),
  variant: z.string().max(512).nullable(),
})
export type MarketRangeRoute = z.infer<typeof MarketRangeRouteSchema>

export const KnownUsageMarketCategorySchema = z.strictObject({
  tokens: Nonnegative.nullable(),
  status: z.enum(["observed", "partial", "missing", "unavailable"]),
})

const CategoryUsage = z.strictObject({
  uncachedInput: KnownUsageMarketCategorySchema,
  output: KnownUsageMarketCategorySchema,
  reasoning: KnownUsageMarketCategorySchema,
  cacheRead: KnownUsageMarketCategorySchema,
  cacheWrite: KnownUsageMarketCategorySchema,
})

const RateSetSchema = z.strictObject({
  tierID: z.string().min(1).max(128),
  minPromptTokens: Nonnegative.nullable(),
  utcStart: Nonnegative.nullable(),
  utcEnd: Nonnegative.nullable(),
  prompt: NullableText,
  completion: NullableText,
  cacheRead: NullableText,
  cacheWrite: NullableText,
})

const AttemptCoverageSchema = z.strictObject({
  status: z.enum(["complete", "partial", "unknown"]),
  attemptCount: Count,
  routeMatchedAttemptCount: Count,
  otherRouteAttemptCount: Count,
  mixedRouteAttemptCount: Count,
  unknownRouteAttemptCount: Count,
  sharedAttemptCount: Count,
  failedAttemptCount: Count,
  retryAttemptCount: Count,
  attemptsWithCompleteUsage: Count,
  failedAttemptsWithCompleteUsage: Count,
  retryAttemptsWithCompleteUsage: Count,
})

const RouteCoverageSchema = z.strictObject({
  relatedSessionCount: Count,
  matchedRouteSessionCount: Count,
  includedSessionCount: Count,
  otherRouteSessionCount: Count,
  mixedRouteSessionCount: Count,
  unknownRouteSessionCount: Count,
  sharedSessionCount: Count,
})

const KnownUsageCoverageSchema = z.strictObject({
  scope: z.literal("known-route-matched-retained-usage"),
  wholeTaskBound: z.literal(false),
  categories: CategoryUsage,
  route: RouteCoverageSchema,
  retries: AttemptCoverageSchema,
})

const ProvenanceSchema = z.strictObject({
  source: z.literal("openrouter-endpoints"),
  productID: EndpointPricingProductIDSchema,
  sourceURL: z.string().url().max(2048),
  refreshState: z.enum(["not-read", "never", "refreshing", "succeeded", "failed", "cancelled"]),
  snapshotID: z.uuid().nullable(),
  snapshotGeneration: Generation.nullable(),
  currentGeneration: Generation.nullable(),
  retrievedAt: z.iso.datetime().nullable(),
  recordIndex: Count.nullable(),
  providerName: NullableText,
  tag: NullableText,
  serviceTier: NullableText,
})

const CacheWriteEvidenceSchema = z.strictObject({
  basis: z.enum([
    "endpoint-rate",
    "scoped-documentation",
    "missing",
    "zero-usage-rate-not-required",
  ]),
  policyID: NullableText,
  sourceURL: z.string().url().max(2048).nullable(),
  retrievedAt: z.iso.datetime().nullable(),
})

const TierAttributionSchema = z.strictObject({
  status: z.enum(["not-required", "resolved-per-call", "unresolved", "unsupported"]),
  basis: z.enum([
    "single-published-rate-scenario",
    "complete-per-call-prompt-usage",
    "aggregate-tier-envelope",
    "unavailable",
  ]),
  callCount: Count,
  selectedTierIDs: z.array(z.string().min(1).max(128)).max(100),
  promptThresholds: z.array(Nonnegative).max(99),
  thresholdSemantics: z
    .literal("override applies when per-call prompt tokens are greater than minPromptTokens")
    .nullable(),
})

export const KnownUsageMarketScenarioSchema = z.strictObject({
  id: z.enum(["kimi-moonshot-mxfp4", "qwen-alibaba", "luna-openai-standard"]),
  label: z.string().min(1).max(160),
  status: z.enum(["exact", "range", "partial", "unavailable"]),
  freshness: z.enum(["current", "stale", "unavailable"]),
  valueUSD: Nonnegative.nullable(),
  rangeUSD: Range.nullable(),
  knownSubtotalUSD: Range.nullable(),
  rateSets: z.array(RateSetSchema).max(100),
  missingRates: z
    .array(z.enum(["uncachedInput", "output", "reasoning", "cacheRead", "cacheWrite"]))
    .max(5),
  cacheWriteEvidence: CacheWriteEvidenceSchema,
  tierAttribution: TierAttributionSchema,
  provenance: ProvenanceSchema,
  coverage: KnownUsageCoverageSchema,
  reason: z.string().max(1000).nullable(),
})
export type KnownUsageMarketScenario = z.infer<typeof KnownUsageMarketScenarioSchema>

export const KnownUsageMarketSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.literal("known-retained-token-usage-only"),
  route: MarketRangeRouteSchema,
  identity: ModelIdentityResolutionSchema,
  status: z.enum(["not-applicable", "exact", "range", "partial", "unavailable"]),
  scenarios: z.array(KnownUsageMarketScenarioSchema).max(1),
})
export type KnownUsageMarket = z.infer<typeof KnownUsageMarketSchema>

type UsageCategory = keyof z.infer<typeof CategoryUsage>
type UsageCategories = z.infer<typeof CategoryUsage>
type RateSet = z.infer<typeof RateSetSchema>
type RouteStatus =
  "single-observed-route" | "mixed-observed-routes" | "identity-unavailable" | "unavailable"

export type KnownUsageMarketSession = {
  sessionID: string
  route: MarketRangeRoute | null
  routeStatus: RouteStatus
  shared: boolean
  categories: UsageCategories
  attempts: Array<{ id: string; state: string; retry: boolean }>
}

export type KnownUsagePerCall = {
  callID: string
  route: MarketRangeRoute
  categories: Record<UsageCategory, number>
}

type StandardScenario = {
  id: KnownUsageMarketScenario["id"]
  label: string
  productID: EndpointPricingProductID
  providerName: string
  tag: string
  serviceTier: null
}

const STANDARD_SCENARIOS: readonly StandardScenario[] = [
  {
    id: "kimi-moonshot-mxfp4",
    label: "Kimi · Moonshot AI · mxfp4 · standard",
    productID: "moonshotai/kimi-k3.1-pro",
    providerName: "Moonshot AI",
    tag: "moonshotai/mxfp4",
    serviceTier: null,
  },
  {
    id: "qwen-alibaba",
    label: "Qwen · Alibaba · standard",
    productID: "qwen/qwen3.8-flash",
    providerName: "Alibaba",
    tag: "alibaba",
    serviceTier: null,
  },
  {
    id: "luna-openai-standard",
    label: "Luna · OpenAI · standard service tier",
    productID: "openai/gpt-6-luna",
    providerName: "OpenAI",
    tag: "openai",
    serviceTier: null,
  },
]

const CATEGORIES: readonly UsageCategory[] = [
  "uncachedInput",
  "output",
  "reasoning",
  "cacheRead",
  "cacheWrite",
]

function sameRoute(left: MarketRangeRoute | null, right: MarketRangeRoute) {
  return Boolean(
    left &&
    left.providerID === right.providerID &&
    left.modelID === right.modelID &&
    left.variant === right.variant,
  )
}

function endpointForProduct(
  endpointPricing: EndpointPricingRead | undefined,
  productID: EndpointPricingProductID,
) {
  return endpointPricing?.scenarios.find((scenario) => scenario.productID === productID) ?? null
}

function rateNumber(value: string | null | undefined) {
  if (value === null || value === undefined || value === "-1") return null
  const rate = Number(value)
  return Number.isFinite(rate) && rate >= 0 ? rate : null
}

function rateText(value: string | null | undefined) {
  return rateNumber(value) === null ? null : value!
}

function applicableCacheWriteDocumentation(
  record: EndpointPricingRecord,
  scenario: StandardScenario,
) {
  const documentation = record.cacheWriteDocumentation
  return documentation &&
    documentation.scope.productID === scenario.productID &&
    documentation.scope.providerName === scenario.providerName &&
    documentation.scope.tag === scenario.tag &&
    documentation.scope.serviceTier === scenario.serviceTier &&
    !Object.hasOwn(record.pricing, "inputCacheWrite")
    ? documentation
    : null
}

function effectiveRate(
  base: string | null | undefined,
  override: string | null | undefined,
  hasOverride: boolean,
  documentedWriteRate?: string,
) {
  const selected = hasOverride ? override : base
  if (selected !== null && selected !== undefined) return rateText(selected)
  return documentedWriteRate ?? null
}

function rateSets(record: EndpointPricingRecord, scenario: StandardScenario) {
  const documentation = applicableCacheWriteDocumentation(record, scenario)
  const documentedWriteRate = documentation?.supportedRate
  const base = record.pricing
  const toRateSet = (
    override: NonNullable<typeof base.overrides>[number] | undefined,
    index: number,
  ): RateSet => {
    const has = (key: keyof NonNullable<typeof base.overrides>[number]) =>
      Boolean(override && Object.hasOwn(override, key))
    return {
      tierID:
        index === 0 ? "base" : `override:${override?.minPromptTokens ?? "unresolved"}:${index}`,
      minPromptTokens: index === 0 ? null : (override?.minPromptTokens ?? null),
      utcStart: index === 0 ? null : (override?.utcStart ?? null),
      utcEnd: index === 0 ? null : (override?.utcEnd ?? null),
      prompt: effectiveRate(base.prompt, override?.prompt, has("prompt")),
      completion: effectiveRate(base.completion, override?.completion, has("completion")),
      cacheRead: effectiveRate(
        base.inputCacheRead,
        override?.inputCacheRead,
        has("inputCacheRead"),
      ),
      cacheWrite: effectiveRate(
        base.inputCacheWrite,
        override?.inputCacheWrite,
        has("inputCacheWrite"),
        documentedWriteRate,
      ),
    }
  }
  const schedules = [toRateSet(undefined, 0)]
  if (Array.isArray(base.overrides))
    base.overrides.forEach((override, index) => schedules.push(toRateSet(override, index + 1)))
  return { schedules, documentation, overridesUnknown: base.overrides === null }
}

function aggregateCategories(sessions: readonly KnownUsageMarketSession[]): UsageCategories {
  return Object.fromEntries(
    CATEGORIES.map((category) => {
      const measures = sessions.map((session) => session.categories[category])
      const observed = measures.filter((measure) => measure.tokens !== null)
      const tokens = observed.length
        ? observed.reduce((total, measure) => total + measure.tokens!, 0)
        : null
      const status =
        measures.length > 0 && measures.every((measure) => measure.status === "observed")
          ? "observed"
          : observed.length
            ? "partial"
            : measures.some((measure) => measure.status === "unavailable")
              ? "unavailable"
              : measures.some((measure) => measure.status === "partial")
                ? "partial"
                : "missing"
      return [category, { tokens, status }]
    }),
  ) as UsageCategories
}

function isCompleteUsage(categories: UsageCategories) {
  return CATEGORIES.every(
    (category) =>
      categories[category].status === "observed" && categories[category].tokens !== null,
  )
}

function isCompleteSession(session: KnownUsageMarketSession) {
  return isCompleteUsage(session.categories)
}

function usageRateCategory(
  category: UsageCategory,
): "prompt" | "completion" | "cacheRead" | "cacheWrite" {
  switch (category) {
    case "uncachedInput":
      return "prompt"
    case "output":
    case "reasoning":
      return "completion"
    case "cacheRead":
      return "cacheRead"
    case "cacheWrite":
      return "cacheWrite"
  }
}

function applicableMissingRates(categories: UsageCategories, set: RateSet): UsageCategory[] {
  return CATEGORIES.filter((category) => {
    const measure = categories[category]
    if (measure.tokens === null || measure.tokens === 0) return false
    return rateNumber(set[usageRateCategory(category)]) === null
  })
}

function amountForSet(categories: UsageCategories, set: RateSet): number | null {
  if (!isCompleteUsage(categories)) return null
  const missing = applicableMissingRates(categories, set)
  if (missing.length) return null
  const values = CATEGORIES.map((category) => {
    const tokens = categories[category].tokens
    if (tokens === null) return null
    if (tokens === 0) return 0
    const rate = rateNumber(set[usageRateCategory(category)])
    return rate === null ? null : tokens * rate
  })
  if (values.some((value) => value === null)) return null
  const total = values.reduce<number>((sum, value) => sum + value!, 0)
  return Number.isFinite(total) ? total : null
}

function knownSubtotalForSet(categories: UsageCategories, set: RateSet): number | null {
  const missing = applicableMissingRates(categories, set)
  if (missing.length) return null
  const values = CATEGORIES.map((category) => {
    const tokens = categories[category].tokens
    if (tokens === null || tokens === 0) return 0
    const rate = rateNumber(set[usageRateCategory(category)])
    return rate === null ? null : tokens * rate
  })
  if (values.some((value) => value === null)) return null
  const total = values.reduce<number>((sum, value) => sum + value!, 0)
  return Number.isFinite(total) ? total : null
}

function amountForCall(call: KnownUsagePerCall, set: RateSet): number | null {
  const categories = Object.fromEntries(
    CATEGORIES.map((category) => [
      category,
      { tokens: call.categories[category], status: "observed" },
    ]),
  ) as UsageCategories
  return amountForSet(categories, set)
}

function selectedSchedule(call: KnownUsagePerCall, schedules: readonly RateSet[]): RateSet | null {
  const overrides = schedules.slice(1)
  const promptTokens =
    call.categories.uncachedInput + call.categories.cacheRead + call.categories.cacheWrite
  if (!Number.isFinite(promptTokens)) return null
  const matching = overrides.filter(
    (schedule) =>
      schedule.minPromptTokens !== null &&
      promptTokens > schedule.minPromptTokens &&
      schedule.utcStart === null &&
      schedule.utcEnd === null,
  )
  if (overrides.some((schedule) => schedule.utcStart !== null || schedule.utcEnd !== null))
    return null
  if (overrides.some((schedule) => schedule.minPromptTokens === null)) return null
  if (!matching.length) return schedules[0] ?? null
  const highestThreshold = Math.max(...matching.map((schedule) => schedule.minPromptTokens!))
  const mostSpecific = matching.filter((schedule) => schedule.minPromptTokens === highestThreshold)
  return mostSpecific.length === 1 ? mostSpecific[0]! : null
}

function callCoverageMatches(
  calls: readonly KnownUsagePerCall[],
  categories: UsageCategories,
  route: MarketRangeRoute,
) {
  if (!calls.length || !isCompleteUsage(categories)) return false
  const seen = new Set<string>()
  const totals = Object.fromEntries(CATEGORIES.map((category) => [category, 0])) as Record<
    UsageCategory,
    number
  >
  for (const call of calls) {
    if (!call.callID || seen.has(call.callID) || !sameRoute(call.route, route)) return false
    seen.add(call.callID)
    for (const category of CATEGORIES) {
      const value = call.categories[category]
      if (!Number.isFinite(value) || value < 0) return false
      totals[category] += value
    }
  }
  return CATEGORIES.every((category) => totals[category] === categories[category].tokens)
}

function retryCoverage(sessions: readonly KnownUsageMarketSession[], route: MarketRangeRoute) {
  const seen = new Set<string>()
  const attempts = sessions.flatMap((session) =>
    session.attempts.flatMap((attempt) => {
      if (seen.has(attempt.id)) return []
      seen.add(attempt.id)
      return [{ session, attempt }]
    }),
  )
  const completeForAttempt = ({ session, attempt }: (typeof attempts)[number]) =>
    !session.shared &&
    session.attempts.length === 1 &&
    session.attempts[0]?.id === attempt.id &&
    session.routeStatus === "single-observed-route" &&
    session.route !== null &&
    isCompleteSession(session)
  const routeMatchedAttemptCount = attempts.filter(
    ({ session }) =>
      !session.shared &&
      session.routeStatus === "single-observed-route" &&
      sameRoute(session.route, route),
  ).length
  const otherRouteAttemptCount = attempts.filter(
    ({ session }) =>
      !session.shared &&
      session.routeStatus === "single-observed-route" &&
      session.route !== null &&
      !sameRoute(session.route, route),
  ).length
  const mixedRouteAttemptCount = attempts.filter(
    ({ session }) => session.routeStatus === "mixed-observed-routes",
  ).length
  const unknownRouteAttemptCount = attempts.filter(
    ({ session }) =>
      session.routeStatus === "identity-unavailable" || session.routeStatus === "unavailable",
  ).length
  const sharedAttemptCount = attempts.filter(({ session }) => session.shared).length
  const failed = attempts.filter(({ attempt }) => attempt.state === "failed")
  const retries = attempts.filter(({ attempt }) => attempt.retry)
  const attemptsWithCompleteUsage = attempts.filter(completeForAttempt).length
  const failedAttemptsWithCompleteUsage = failed.filter(completeForAttempt).length
  const retryAttemptsWithCompleteUsage = retries.filter(completeForAttempt).length
  const status =
    attempts.length === 0
      ? "unknown"
      : attemptsWithCompleteUsage === attempts.length
        ? "complete"
        : "partial"
  return {
    status,
    attemptCount: attempts.length,
    routeMatchedAttemptCount,
    otherRouteAttemptCount,
    mixedRouteAttemptCount,
    unknownRouteAttemptCount,
    sharedAttemptCount,
    failedAttemptCount: failed.length,
    retryAttemptCount: retries.length,
    attemptsWithCompleteUsage,
    failedAttemptsWithCompleteUsage,
    retryAttemptsWithCompleteUsage,
  } as const
}

function routeCoverage(sessions: readonly KnownUsageMarketSession[], route: MarketRangeRoute) {
  const matchedRouteSessionCount = sessions.filter(
    (session) => session.routeStatus === "single-observed-route" && sameRoute(session.route, route),
  ).length
  return {
    relatedSessionCount: sessions.length,
    matchedRouteSessionCount,
    includedSessionCount: sessions.filter(
      (session) =>
        !session.shared &&
        session.routeStatus === "single-observed-route" &&
        sameRoute(session.route, route),
    ).length,
    otherRouteSessionCount: sessions.filter(
      (session) =>
        !session.shared &&
        session.routeStatus === "single-observed-route" &&
        session.route !== null &&
        !sameRoute(session.route, route),
    ).length,
    mixedRouteSessionCount: sessions.filter(
      (session) => session.routeStatus === "mixed-observed-routes",
    ).length,
    unknownRouteSessionCount: sessions.filter(
      (session) =>
        session.routeStatus === "identity-unavailable" || session.routeStatus === "unavailable",
    ).length,
    sharedSessionCount: sessions.filter((session) => session.shared).length,
  } as const
}

function freshness(scenario: EndpointPricingScenario | null) {
  if (!scenario?.snapshot) return "unavailable" as const
  return scenario.state === "succeeded" && scenario.snapshot.generation === scenario.generation
    ? ("current" as const)
    : ("stale" as const)
}

function provenance(
  endpointPricing: EndpointPricingRead | undefined,
  scenario: StandardScenario,
  source: EndpointPricingScenario | null,
  recordIndex: number | null,
) {
  const evidence = source?.snapshot
  return {
    source: "openrouter-endpoints" as const,
    productID: scenario.productID,
    sourceURL: evidence?.sourceURL ?? endpointPricingProduct(scenario.productID).sourceURL,
    refreshState: source?.state ?? (endpointPricing ? "never" : "not-read"),
    snapshotID: evidence?.snapshotID ?? null,
    snapshotGeneration: evidence?.generation ?? null,
    currentGeneration: source?.generation ?? null,
    retrievedAt: evidence?.retrievedAt ?? null,
    recordIndex,
    providerName: scenario.providerName,
    tag: scenario.tag,
    serviceTier: scenario.serviceTier,
  }
}

function standardRecord(endpoint: EndpointPricingScenario | null, scenario: StandardScenario) {
  const records = endpoint?.snapshot?.records ?? []
  const matches = records.flatMap((record, index) =>
    record.providerName === scenario.providerName &&
    (record.tag ?? null) === scenario.tag &&
    (record.serviceTier ?? null) === scenario.serviceTier
      ? [{ record, index }]
      : [],
  )
  return matches.length === 1 ? matches[0]! : null
}

function emptyCoverage(sessions: readonly KnownUsageMarketSession[], route: MarketRangeRoute) {
  const included = sessions.filter(
    (session) =>
      !session.shared &&
      session.routeStatus === "single-observed-route" &&
      sameRoute(session.route, route),
  )
  return {
    included,
    categoryUsage: aggregateCategories(included),
    coverage: {
      scope: "known-route-matched-retained-usage" as const,
      wholeTaskBound: false as const,
      categories: aggregateCategories(included),
      route: routeCoverage(sessions, route),
      retries: retryCoverage(sessions, route),
    },
  }
}

function emptyTierAttribution(): z.infer<typeof TierAttributionSchema> {
  return {
    status: "unsupported",
    basis: "unavailable",
    callCount: 0,
    selectedTierIDs: [],
    promptThresholds: [],
    thresholdSemantics: null,
  }
}

function unavailableScenario(input: {
  route: MarketRangeRoute
  endpointPricing: EndpointPricingRead | undefined
  standard: StandardScenario
  endpoint: EndpointPricingScenario | null
  sessions: readonly KnownUsageMarketSession[]
  reason: string
  recordIndex?: number | null
  record?: EndpointPricingRecord
}) {
  const coverage = emptyCoverage(input.sessions, input.route)
  const docs = input.record ? applicableCacheWriteDocumentation(input.record, input.standard) : null
  return KnownUsageMarketScenarioSchema.parse({
    id: input.standard.id,
    label: input.standard.label,
    status: "unavailable",
    freshness: freshness(input.endpoint),
    valueUSD: null,
    rangeUSD: null,
    knownSubtotalUSD: null,
    rateSets: [],
    missingRates: [],
    cacheWriteEvidence: {
      basis: docs ? "scoped-documentation" : "missing",
      policyID: docs?.policyID ?? null,
      sourceURL: docs?.sourceURL ?? null,
      retrievedAt: docs?.retrievedAt ?? null,
    },
    tierAttribution: emptyTierAttribution(),
    provenance: provenance(
      input.endpointPricing,
      input.standard,
      input.endpoint,
      input.recordIndex ?? null,
    ),
    coverage: coverage.coverage,
    reason: input.reason,
  })
}

function calculateScenario(input: {
  route: MarketRangeRoute
  endpointPricing: EndpointPricingRead | undefined
  standard: StandardScenario
  sessions: readonly KnownUsageMarketSession[]
  perCallUsage: readonly KnownUsagePerCall[]
  perCallCoverageComplete: boolean
}): KnownUsageMarketScenario {
  const endpoint = endpointForProduct(input.endpointPricing, input.standard.productID)
  const match = standardRecord(endpoint, input.standard)
  if (!endpoint?.snapshot)
    return unavailableScenario({
      ...input,
      endpoint,
      reason: endpoint?.errorCode
        ? `Retained endpoint evidence is unavailable (${endpoint.errorCode}).`
        : "No retained endpoint snapshot is available for this product.",
    })
  if (!match)
    return unavailableScenario({
      ...input,
      endpoint,
      reason: "The exact standard endpoint scenario is absent or ambiguous in retained evidence.",
    })

  const { record, index: recordIndex } = match
  const coverage = emptyCoverage(input.sessions, input.route)
  const { included, categoryUsage, coverage: usageCoverage } = coverage
  if (!included.length)
    return unavailableScenario({
      ...input,
      endpoint,
      record,
      recordIndex,
      reason: "No non-shared retained usage has a matching exact observed route.",
    })

  const scheduleResult = rateSets(record, input.standard)
  const schedules = scheduleResult.schedules
  const promptThresholds = schedules
    .slice(1)
    .flatMap((schedule) => (schedule.minPromptTokens === null ? [] : [schedule.minPromptTokens]))
  const tiered = schedules.length > 1 || scheduleResult.overridesUnknown
  const hasUnsupportedSelector =
    schedules.some((schedule) => schedule.utcStart !== null || schedule.utcEnd !== null) ||
    schedules.slice(1).some((schedule) => schedule.minPromptTokens === null)
  const usePerCall =
    tiered &&
    !scheduleResult.overridesUnknown &&
    !hasUnsupportedSelector &&
    input.perCallCoverageComplete &&
    callCoverageMatches(input.perCallUsage, categoryUsage, input.route) &&
    usageCoverage.retries.status === "complete"
  const missingRates = new Set<UsageCategory>()
  let valueUSD: number | null = null
  let rangeUSD: { minimum: number; maximum: number } | null = null
  let knownSubtotalUSD: { minimum: number; maximum: number } | null = null
  let tierAttribution: z.infer<typeof TierAttributionSchema>
  const categoriesComplete = isCompleteUsage(categoryUsage)
  const retryComplete = usageCoverage.retries.status === "complete"

  if (scheduleResult.overridesUnknown || hasUnsupportedSelector) {
    tierAttribution = {
      status: "unsupported",
      basis: "unavailable",
      callCount: 0,
      selectedTierIDs: [],
      promptThresholds,
      thresholdSemantics: null,
    }
  } else if (usePerCall) {
    const amounts: number[] = []
    const selectedTierIDs: string[] = []
    let valid = true
    for (const call of input.perCallUsage) {
      const selected = selectedSchedule(call, schedules)
      if (!selected) {
        valid = false
        break
      }
      const amount = amountForCall(call, selected)
      if (amount === null) {
        for (const category of applicableMissingRates(
          Object.fromEntries(
            CATEGORIES.map((category) => [
              category,
              { tokens: call.categories[category], status: "observed" },
            ]),
          ) as UsageCategories,
          selected,
        ))
          missingRates.add(category)
        valid = false
        break
      }
      amounts.push(amount)
      selectedTierIDs.push(selected.tierID)
    }
    if (valid) valueUSD = amounts.reduce((total, amount) => total + amount, 0)
    tierAttribution = {
      status: valid ? "resolved-per-call" : "unsupported",
      basis: "complete-per-call-prompt-usage",
      callCount: input.perCallUsage.length,
      selectedTierIDs: [...new Set(selectedTierIDs)],
      promptThresholds,
      thresholdSemantics:
        promptThresholds.length > 0
          ? "override applies when per-call prompt tokens are greater than minPromptTokens"
          : null,
    }
  } else if (tiered) {
    tierAttribution = {
      status: "unresolved",
      basis: "aggregate-tier-envelope",
      callCount: 0,
      selectedTierIDs: schedules.map(({ tierID }) => tierID),
      promptThresholds,
      thresholdSemantics:
        promptThresholds.length > 0
          ? "override applies when per-call prompt tokens are greater than minPromptTokens"
          : null,
    }
  } else {
    tierAttribution = {
      status: "not-required",
      basis: "single-published-rate-scenario",
      callCount: 0,
      selectedTierIDs: schedules.map(({ tierID }) => tierID),
      promptThresholds: [],
      thresholdSemantics: null,
    }
  }

  const fullAmounts = schedules.map((schedule) => amountForSet(categoryUsage, schedule))
  if (
    valueUSD === null &&
    categoriesComplete &&
    retryComplete &&
    tierAttribution.status !== "unsupported"
  ) {
    if (tierAttribution.status === "resolved-per-call") {
      // `valueUSD` above prices each attributable call against its own published tier.
    } else if (fullAmounts.every((amount): amount is number => amount !== null)) {
      const minimum = Math.min(...fullAmounts)
      const maximum = Math.max(...fullAmounts)
      if (tierAttribution.status === "unresolved") rangeUSD = { minimum, maximum }
      else valueUSD = minimum
    }
  }

  if (valueUSD === null && rangeUSD === null) {
    const pricedSubtotals = schedules.map((schedule) =>
      knownSubtotalForSet(categoryUsage, schedule),
    )
    if (pricedSubtotals.every((amount): amount is number => amount !== null))
      knownSubtotalUSD = {
        minimum: Math.min(...pricedSubtotals),
        maximum: Math.max(...pricedSubtotals),
      }
  }

  for (const schedule of schedules)
    for (const category of applicableMissingRates(categoryUsage, schedule))
      missingRates.add(category)

  const marketStatus: KnownUsageMarketScenario["status"] =
    valueUSD !== null ? "exact" : rangeUSD !== null ? "range" : "partial"
  const cacheWriteTokens = categoryUsage.cacheWrite
  const cacheWriteRateRequired =
    cacheWriteTokens.status !== "observed" ||
    cacheWriteTokens.tokens === null ||
    cacheWriteTokens.tokens > 0
  const docs = scheduleResult.documentation
  const cacheWriteRateExists = schedules.some(
    (schedule) => rateNumber(schedule.cacheWrite) !== null,
  )
  const cacheWriteEvidence = {
    basis: docs
      ? ("scoped-documentation" as const)
      : cacheWriteRateExists
        ? ("endpoint-rate" as const)
        : cacheWriteRateRequired
          ? ("missing" as const)
          : ("zero-usage-rate-not-required" as const),
    policyID: docs?.policyID ?? null,
    sourceURL: docs?.sourceURL ?? null,
    retrievedAt: docs?.retrievedAt ?? null,
  }
  const rateCoverage = schedules.flatMap((schedule) =>
    applicableMissingRates(categoryUsage, schedule),
  )
  const uniqueMissingRates = [...new Set(rateCoverage)].sort(
    (left, right) => CATEGORIES.indexOf(left) - CATEGORIES.indexOf(right),
  )
  const status: KnownUsageMarketScenario["status"] =
    marketStatus === "exact" && retryComplete
      ? "exact"
      : marketStatus === "range" && retryComplete
        ? "range"
        : "partial"

  return KnownUsageMarketScenarioSchema.parse({
    id: input.standard.id,
    label: input.standard.label,
    status,
    freshness: freshness(endpoint),
    valueUSD: status === "exact" ? valueUSD : null,
    rangeUSD: status === "range" ? rangeUSD : null,
    knownSubtotalUSD: status === "partial" ? knownSubtotalUSD : null,
    rateSets: schedules,
    missingRates: uniqueMissingRates,
    cacheWriteEvidence,
    tierAttribution,
    provenance: provenance(input.endpointPricing, input.standard, endpoint, recordIndex),
    coverage: usageCoverage,
    reason:
      status === "exact" || status === "range"
        ? null
        : !retryComplete
          ? "Retained retry usage or route attribution is incomplete; any amount is only a known-usage subtotal."
          : !categoriesComplete
            ? "One or more measured token categories are missing or partial; no total or finite bound is reported."
            : uniqueMissingRates.length
              ? "A required endpoint rate is missing for nonzero or unknown token usage."
              : tierAttribution.status === "unsupported"
                ? "The retained endpoint tier selector is not supported by attributable usage evidence."
                : "No complete compatible endpoint-scenario value or range is available.",
  })
}

/**
 * Price only known, exact-route retained usage. Session aggregates can support a
 * published tier envelope, but never select a per-call prompt tier.
 */
export function calculateKnownUsageMarket(input: {
  route: MarketRangeRoute
  identity: ModelIdentityResolution
  endpointPricing?: EndpointPricingRead
  sessions: readonly KnownUsageMarketSession[]
  perCallUsage?: readonly KnownUsagePerCall[]
  perCallCoverageComplete?: boolean
}): KnownUsageMarket {
  const parsedRoute = MarketRangeRouteSchema.parse(input.route)
  const identity = ModelIdentityResolutionSchema.parse(input.identity)
  const resolvedProductID =
    identity.status === "exact"
      ? EndpointPricingProductIDSchema.safeParse(identity.productID)
      : null
  const product = resolvedProductID?.success
    ? ENDPOINT_PRICING_PRODUCTS.find(({ productID }) => productID === resolvedProductID.data)
    : undefined
  if (!product)
    return KnownUsageMarketSchema.parse({
      schemaVersion: 1,
      scope: "known-retained-token-usage-only",
      route: parsedRoute,
      identity,
      status: identity.status === "source-unavailable" ? "unavailable" : "not-applicable",
      scenarios: [],
    })

  const standard = STANDARD_SCENARIOS.find(({ productID }) => productID === product.productID)
  if (!standard)
    return KnownUsageMarketSchema.parse({
      schemaVersion: 1,
      scope: "known-retained-token-usage-only",
      route: parsedRoute,
      identity,
      status: "unavailable",
      scenarios: [],
    })
  const scenario = calculateScenario({
    route: parsedRoute,
    endpointPricing: input.endpointPricing,
    standard,
    sessions: input.sessions,
    perCallUsage: input.perCallUsage ?? [],
    perCallCoverageComplete: input.perCallCoverageComplete ?? false,
  })
  const status = scenario.status
  return KnownUsageMarketSchema.parse({
    schemaVersion: 1,
    scope: "known-retained-token-usage-only",
    route: parsedRoute,
    identity,
    status,
    scenarios: [scenario],
  })
}
