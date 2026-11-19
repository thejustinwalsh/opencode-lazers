import { z } from "zod"
import { TaskValuationSchema } from "./valuation-schema.ts"
import { KnownUsageMarketCategorySchema } from "./market-range.ts"

const MarketEquivalentCostSchema = TaskValuationSchema.shape.marketEquivalentCost
const MarketSessionSchema = MarketEquivalentCostSchema.shape.sessions.element

const SelectedPriceSourceSchema = z.strictObject({
  source: z.enum(["native-catalog", "openrouter-models"]),
  snapshotID: z.uuid(),
  generation: z.number().int().positive(),
  retrievedAt: z.iso.datetime(),
  asOf: z.iso.datetime().nullable(),
  priceBasis: z.enum(["quote", "average"]),
  rateUnit: z.enum(["USD per token", "USD per million tokens"]),
})
export type SelectedPriceSource = z.infer<typeof SelectedPriceSourceSchema>

const EstimateRangeSchema = z
  .strictObject({
    minimum: z.number().finite().nonnegative(),
    maximum: z.number().finite().nonnegative(),
  })
  .refine((range) => range.minimum <= range.maximum)

const ObservedUsageEstimateSourceSchema = z.strictObject({
  source: z.enum(["native-catalog", "openrouter-models"]),
  snapshotID: z.uuid(),
  generation: z.number().int().positive(),
  currentGeneration: z.number().int().nonnegative(),
  retrievedAt: z.iso.datetime(),
  freshness: z.enum(["current", "stale"]),
  priceBasis: z.enum(["quote", "average"]),
  sourceURL: z.url().max(2048),
})

const EstimateRateSetSchema = z.strictObject({
  tierID: z.string().min(1).max(128),
  contextTierTokens: z.number().finite().nonnegative().nullable(),
  minPromptTokens: z.number().finite().nonnegative().nullable(),
  utcStart: z.number().finite().nonnegative().nullable(),
  utcEnd: z.number().finite().nonnegative().nullable(),
  prompt: z.string().max(512).nullable(),
  completion: z.string().max(512).nullable(),
  cacheRead: z.string().max(512).nullable(),
  cacheWrite: z.string().max(512).nullable(),
})

const EstimateTierAttributionSchema = z.strictObject({
  status: z.enum(["not-required", "resolved-per-call", "unresolved", "unsupported"]),
  basis: z.enum([
    "single-published-rate-scenario",
    "complete-per-call-prompt-usage",
    "aggregate-tier-envelope",
    "unavailable",
  ]),
  callCount: z.number().int().nonnegative(),
  selectedTierIDs: z.array(z.string().min(1).max(128)).max(100),
  promptThresholds: z.array(z.number().finite().nonnegative()).max(99),
  thresholdSemantics: z.string().max(256).nullable(),
})

export const ObservedUsageEstimateSchema = z.strictObject({
  label: z.literal("Current-market observed-usage estimate"),
  status: z.enum(["estimate", "range", "partial"]),
  valueUSD: z.number().finite().nonnegative().nullable(),
  rangeUSD: EstimateRangeSchema.nullable(),
  pricedPortionUSD: EstimateRangeSchema.nullable(),
  unit: z.literal("USD"),
  basis: z.literal("deduplicated-retained-token-usage-at-published-current-rates"),
  meaning: z.string().max(1_000),
  freshness: z.enum(["current", "stale"]),
  sources: z.array(ObservedUsageEstimateSourceSchema).min(1).max(100),
  rateSets: z.array(EstimateRateSetSchema).max(1_000),
  categories: z.strictObject({
    uncachedInput: KnownUsageMarketCategorySchema,
    output: KnownUsageMarketCategorySchema,
    reasoning: KnownUsageMarketCategorySchema,
    cacheRead: KnownUsageMarketCategorySchema,
    cacheWrite: KnownUsageMarketCategorySchema,
  }),
  tierAttribution: EstimateTierAttributionSchema,
  retainedCallCount: z.number().int().nonnegative(),
  recoveryGapCount: z.number().int().nonnegative(),
  assumptions: z.array(z.string().min(1).max(512)).max(12),
})
export type ObservedUsageEstimate = z.infer<typeof ObservedUsageEstimateSchema>

export const TrajectoryMarketEquivalentCostSchema = z.strictObject({
  valueUSD: MarketEquivalentCostSchema.shape.valueUSD,
  subtotalUSD: MarketEquivalentCostSchema.shape.subtotalUSD,
  unit: MarketEquivalentCostSchema.shape.unit,
  status: MarketEquivalentCostSchema.shape.status,
  basis: MarketEquivalentCostSchema.shape.basis,
  meaning: MarketEquivalentCostSchema.shape.meaning,
  currentIndex: z
    .strictObject({
      indexID: z.string().min(1).max(256),
      retrievedAt: z.iso.datetime(),
      freshness: z.enum(["current", "stale", "unknown", "unavailable"]),
      sources: z.array(SelectedPriceSourceSchema).max(4_000),
    })
    .nullable(),
  coverage: MarketEquivalentCostSchema.shape.coverage,
  observedUsageEstimate: ObservedUsageEstimateSchema.optional(),
  sessions: z
    .array(
      z.strictObject({
        sessionID: MarketSessionSchema.shape.sessionID,
        attemptIDs: MarketSessionSchema.shape.attemptIDs,
        routeAllocation: MarketSessionSchema.shape.routeAllocation.omit({ route: true }),
        pinStatus: MarketSessionSchema.shape.pinStatus,
        categories: MarketSessionSchema.shape.categories,
        valueUSD: MarketSessionSchema.shape.valueUSD,
        subtotalUSD: MarketSessionSchema.shape.subtotalUSD,
        status: MarketSessionSchema.shape.status,
        sources: z.array(SelectedPriceSourceSchema).max(100),
      }),
    )
    .max(100_000),
})
export type TrajectoryMarketEquivalentCost = z.infer<typeof TrajectoryMarketEquivalentCostSchema>
