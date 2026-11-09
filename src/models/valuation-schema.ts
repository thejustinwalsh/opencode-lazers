import { z } from "zod"

const FiniteNonnegative = z.number().finite().nonnegative()
const NullableText = z.string().max(512).nullable()
const DecimalPrice = z
  .string()
  .max(64)
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/)
  .refine((value) => Number.isFinite(Number(value)), "Price must be finite")
const PriceRate = z.union([FiniteNonnegative, DecimalPrice]).nullable()

export const ValuationRouteSchema = z.strictObject({
  providerID: z.string().min(1).max(512),
  modelID: z.string().min(1).max(512),
  variant: z.string().max(512).nullable(),
})

export const ValuationPriceProvenanceSchema = z.strictObject({
  source: z.enum(["native-catalog", "openrouter-models"]),
  snapshotID: z.uuid(),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  retrievedAt: z.iso.datetime(),
  asOf: z.iso.datetime().nullable(),
  sourceURL: z.string().url().max(2048),
  recordIndex: z.number().int().nonnegative().max(1_999),
  recordID: z.string().min(1).max(512),
})

/** A caller-resolved current product/tier pin; unresolved selectors are never guessed here. */
export const CurrentPricePinSchema = z.strictObject({
  route: ValuationRouteSchema.nullable(),
  productID: NullableText,
  configurationID: NullableText,
  semantics: z.enum(["quote", "average"]),
  resolution: z.strictObject({
    route: z.enum(["resolved", "unresolved"]),
    sku: z.enum(["resolved", "unresolved"]),
    configuration: z.enum(["resolved", "unresolved", "not-applicable"]),
    tier: z.enum(["resolved", "unresolved", "not-applicable"]),
    schedule: z.enum(["resolved", "unresolved", "not-applicable"]),
  }),
  tier: z.strictObject({
    id: NullableText,
    contextTierTokens: FiniteNonnegative.nullable(),
    minPromptTokens: FiniteNonnegative.nullable(),
    utcStart: FiniteNonnegative.nullable(),
    utcEnd: FiniteNonnegative.nullable(),
  }),
  rates: z.strictObject({
    unit: z.enum(["USD per token", "USD per million tokens"]),
    uncachedInput: PriceRate,
    completion: PriceRate,
    cacheRead: PriceRate,
    cacheWrite: PriceRate,
  }),
  provenance: ValuationPriceProvenanceSchema,
})
export type CurrentPricePin = z.infer<typeof CurrentPricePinSchema>

export const CurrentPriceIndexSchema = z.strictObject({
  indexID: z.string().min(1).max(256),
  retrievedAt: z.iso.datetime(),
  pins: z.array(CurrentPricePinSchema).max(4_000),
})
export type CurrentPriceIndex = z.infer<typeof CurrentPriceIndexSchema>

const UsageStatus = z.enum(["observed", "partial", "missing", "unavailable"])
const UsageValueScope = z.enum([
  "sum-of-selected-session-snapshots",
  "observed-subtotal",
  "selected-cumulative-snapshot",
  "retained-additive-subtotal",
  "unknown",
])

const UsageCategorySummarySchema = z.strictObject({
  value: FiniteNonnegative.nullable(),
  unit: z.literal("tokens"),
  status: UsageStatus,
  meaning: z.string().max(512),
  valueScope: UsageValueScope,
  sources: z.array(z.string().max(256)).max(100),
  sourceTypes: z.array(z.string().max(256)).max(100),
  missingSessionIDs: z.array(z.string().max(256)).max(100_000),
})

const SessionUsageCategorySchema = z.strictObject({
  value: FiniteNonnegative.nullable(),
  unit: z.literal("tokens"),
  status: UsageStatus,
  basis: z.enum([
    "native-session-cumulative-snapshot",
    "retained-progress-cumulative-snapshot",
    "retained-progress-additive-steps",
    "unavailable",
  ]),
  valueScope: UsageValueScope,
  source: z.string().max(256).nullable(),
  sourceTypes: z.array(z.string().max(256)).max(100),
})

const UsageCategoriesSchema = z.strictObject({
  uncachedInput: UsageCategorySummarySchema,
  output: UsageCategorySummarySchema,
  reasoning: UsageCategorySummarySchema,
  cacheRead: UsageCategorySummarySchema,
  cacheWrite: UsageCategorySummarySchema,
})

const SessionUsageCategoriesSchema = z.strictObject({
  uncachedInput: SessionUsageCategorySchema,
  output: SessionUsageCategorySchema,
  reasoning: SessionUsageCategorySchema,
  cacheRead: SessionUsageCategorySchema,
  cacheWrite: SessionUsageCategorySchema,
})

const UsageCoverageSchema = z.strictObject({
  totalUniqueSessions: z.number().int().nonnegative().max(100_000),
  nativeCumulativeSnapshots: z.number().int().nonnegative().max(100_000),
  retainedCumulativeSnapshots: z.number().int().nonnegative().max(100_000),
  additiveStepSubtotals: z.number().int().nonnegative().max(100_000),
  missingSessions: z.array(z.string().max(256)).max(100_000),
  unavailableSessions: z.array(z.string().max(256)).max(100_000),
  progressTruncated: z.boolean(),
})

const RouteEvidenceCoverageSchema = z.strictObject({
  observedSessionRouteCount: z.number().int().nonnegative().max(100_000),
  observedStepRouteCount: z.number().int().nonnegative().max(100_000),
  sessionsWithoutCurrentRoute: z.array(z.string().max(256)).max(100_000),
  stepContextsByStatus: z.strictObject({
    available: z.number().int().nonnegative().max(100_000),
    notRead: z.number().int().nonnegative().max(100_000),
    unavailable: z.number().int().nonnegative().max(100_000),
  }),
  progressTruncated: z.boolean(),
  truncatedContextSessionIDs: z.array(z.string().max(256)).max(100_000),
})

const UsageSessionSchema = z.strictObject({
  sessionID: z.string().min(1).max(256),
  attemptIDs: z.array(z.string().max(256)).max(100_000),
  attemptStates: z.array(z.string().max(128)).max(100_000),
  sessionStatus: z.enum(["available", "missing", "unavailable"]),
  selectedBasis: z.enum([
    "native-session-cumulative-snapshot",
    "retained-progress-cumulative-snapshot",
    "retained-progress-additive-steps",
    "unavailable",
  ]),
  additiveStepCount: z.number().int().nonnegative().max(100_000),
  categories: SessionUsageCategoriesSchema,
})

const UsageSchema = z.strictObject({
  unit: z.literal("tokens"),
  categories: UsageCategoriesSchema,
  sessions: z.array(UsageSessionSchema).max(100_000),
  coverage: UsageCoverageSchema,
  routeCoverage: RouteEvidenceCoverageSchema,
})

const CostContributionSchema = z.strictObject({
  sessionID: z.string().min(1).max(256),
  attemptIDs: z.array(z.string().max(256)).max(100_000),
  basis: z.enum([
    "cumulative-session-snapshot",
    "attempt-session-cumulative-snapshot",
    "retained-additive-step-subtotal",
    "unavailable",
  ]),
  valueUSD: FiniteNonnegative.nullable(),
  status: z.enum(["observed", "partial", "missing", "unavailable", "unmetered"]),
  source: z.string().max(256).nullable(),
  measurementCount: z.number().int().nonnegative().max(100_000),
  missingMeasurements: z.number().int().nonnegative().max(100_000),
  ignoredAdditiveStepCount: z.number().int().nonnegative().max(100_000),
})

const ReportedWorkerCostSchema = z.strictObject({
  valueUSD: FiniteNonnegative.nullable(),
  subtotalUSD: FiniteNonnegative.nullable(),
  unit: z.literal("USD"),
  status: z.enum(["observed", "partial", "missing", "unavailable", "unmetered"]),
  meaning: z.string().max(1_000),
  selection: z.string().max(1_000),
  totalUniqueSessions: z.number().int().nonnegative().max(100_000),
  cumulativeSessions: z.number().int().nonnegative().max(100_000),
  additiveSubtotalSessions: z.number().int().nonnegative().max(100_000),
  missingSessionIDs: z.array(z.string().max(256)).max(100_000),
  contributions: z.array(CostContributionSchema).max(100_000),
})

const MarketCostCategorySchema = z.strictObject({
  tokens: FiniteNonnegative.nullable(),
  rateUSDPerToken: FiniteNonnegative.nullable(),
  valueUSD: FiniteNonnegative.nullable(),
  status: z.enum(["valued", "zero-usage", "unknown", "unavailable"]),
  reason: z.string().max(512).nullable(),
})

const MarketCostCategoriesSchema = z.strictObject({
  uncachedInput: MarketCostCategorySchema,
  output: MarketCostCategorySchema,
  reasoning: MarketCostCategorySchema,
  cacheRead: MarketCostCategorySchema,
  cacheWrite: MarketCostCategorySchema,
})

const RouteAllocationSchema = z.strictObject({
  status: z.enum([
    "single-observed-route",
    "mixed-observed-routes",
    "unavailable",
    "identity-unavailable",
  ]),
  route: ValuationRouteSchema.nullable(),
  observedRouteCount: z.number().int().nonnegative().max(100_000),
  meaning: z.string().max(512),
})

const MarketSessionSchema = z.strictObject({
  sessionID: z.string().min(1).max(256),
  attemptIDs: z.array(z.string().max(256)).max(100_000),
  routeAllocation: RouteAllocationSchema,
  pinStatus: z.enum(["resolved", "unresolved", "ambiguous", "missing"]),
  pinCandidates: z.array(CurrentPricePinSchema).max(100),
  categories: MarketCostCategoriesSchema,
  valueUSD: FiniteNonnegative.nullable(),
  subtotalUSD: FiniteNonnegative.nullable(),
  status: z.enum(["observed", "partial", "missing", "unavailable"]),
})

const MarketEquivalentCostSchema = z.strictObject({
  valueUSD: FiniteNonnegative.nullable(),
  subtotalUSD: FiniteNonnegative.nullable(),
  unit: z.literal("USD"),
  status: z.enum(["observed", "partial", "missing", "unavailable"]),
  basis: z.literal("supplied-current-price-index"),
  meaning: z.string().max(1_000),
  currentIndex: z.strictObject({
    indexID: z.string().min(1).max(256),
    retrievedAt: z.iso.datetime(),
  }),
  coverage: z.strictObject({
    totalUniqueSessions: z.number().int().nonnegative().max(100_000),
    pricedSessions: z.number().int().nonnegative().max(100_000),
    partialSessions: z.number().int().nonnegative().max(100_000),
    unpricedSessionIDs: z.array(z.string().max(256)).max(100_000),
    progressTruncated: z.boolean(),
    routeEvidence: RouteEvidenceCoverageSchema,
    routeHistory: z.literal(
      "observed-session-and-retained-step-routes; full-call-coverage-not-guaranteed",
    ),
  }),
  sessions: z.array(MarketSessionSchema).max(100_000),
})

export const TaskValuationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  usage: UsageSchema,
  reportedWorkerCost: ReportedWorkerCostSchema,
  marketEquivalentCost: MarketEquivalentCostSchema,
  architectReviewIntegrationOverheadUSD: z.strictObject({
    valueUSD: z.null(),
    status: z.literal("unallocated"),
    components: z.array(z.enum(["Architect", "review", "integration"])).length(3),
  }),
})
export type TaskValuation = z.infer<typeof TaskValuationSchema>
