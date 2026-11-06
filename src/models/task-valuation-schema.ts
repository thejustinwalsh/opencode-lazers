import { z } from "zod"
import { TaskValuationSchema } from "./valuation-schema.ts"

const MarketEquivalentCostSchema = TaskValuationSchema.shape.marketEquivalentCost
const MarketSessionSchema = MarketEquivalentCostSchema.shape.sessions.element

export const SelectedPriceSourceSchema = z.strictObject({
  source: z.enum(["native-catalog", "openrouter-models"]),
  snapshotID: z.uuid(),
  generation: z.number().int().positive(),
  retrievedAt: z.iso.datetime(),
  asOf: z.iso.datetime().nullable(),
  priceBasis: z.enum(["quote", "average"]),
  rateUnit: z.enum(["USD per token", "USD per million tokens"]),
})
export type SelectedPriceSource = z.infer<typeof SelectedPriceSourceSchema>

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
