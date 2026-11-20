import { canonical } from "../identity.ts"
import {
  MANAGED_USAGE_CATEGORIES,
  ManagedUsageAssociationSchema,
  ManagedUsageCategoriesSchema,
  ManagedUsageRouteSchema,
} from "../managed-usage/contract.ts"
import type { ManagedUsageCategory, ManagedUsageRoute } from "../managed-usage/contract.ts"
import type { ManagedUsageGeneration } from "../managed-usage/projection.ts"
import {
  addDecimal,
  currentPricePinBlockers,
  decimal,
  decimalNumber,
  multiplyDecimal,
} from "./valuation.ts"
import type { Decimal } from "./valuation.ts"
import type { CurrentPriceApplicability } from "./current-price-index.ts"
import type { ModelPriceSourceSettings } from "./price-source-settings.ts"
import { CurrentPriceIndexSchema } from "./valuation-schema.ts"
import type { CurrentPriceIndex, CurrentPricePin } from "./valuation-schema.ts"
import { z } from "zod"

const FiniteNonnegative = z.number().finite().nonnegative()
const MarketCategorySchema = z.strictObject({
  tokens: FiniteNonnegative.nullable(),
  rateUSDPerToken: FiniteNonnegative.nullable(),
  valueUSD: FiniteNonnegative.nullable(),
  subtotalUSD: FiniteNonnegative.nullable(),
  status: z.enum(["valued", "zero-usage", "unknown", "unavailable"]),
  reason: z.string().max(512).nullable(),
})
const RouteSchema = ManagedUsageRouteSchema.nullable()
const QuoteCategoriesSchema = z.strictObject({
  uncachedInput: MarketCategorySchema,
  output: MarketCategorySchema,
  reasoning: MarketCategorySchema,
  cacheRead: MarketCategorySchema,
  cacheWrite: MarketCategorySchema,
})

export const ManagedUsageCallValuationSchema = z.strictObject({
  sessionID: z.string().min(1).max(256),
  assistantMessageID: z.string().min(1).max(256),
  startSequence: FiniteNonnegative.nullable(),
  terminalSequence: FiniteNonnegative.nullable(),
  startEventIDs: z.array(z.string().max(512)).max(20),
  terminalEventIDs: z.array(z.string().max(512)).max(20),
  eventFactCount: z.number().int().nonnegative().max(100_000),
  provenanceTruncated: z.boolean(),
  route: RouteSchema,
  routeStatus: z.enum(["observed", "missing", "invalid", "conflicting"]),
  categories: ManagedUsageCategoriesSchema,
  outcome: z.enum(["succeeded", "failed", "pending", "conflicting"]),
  status: z.enum(["observed", "partial", "missing", "unavailable"]),
  association: ManagedUsageAssociationSchema,
  associationRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  associationBoundarySequence: FiniteNonnegative.nullable(),
  associationReason: z.string().max(512).nullable(),
  quote: z.strictObject({
    valueUSD: FiniteNonnegative.nullable(),
    subtotalUSD: FiniteNonnegative.nullable(),
    status: z.enum(["observed", "partial", "missing", "unavailable"]),
    pinStatus: z.enum(["resolved", "unresolved", "ambiguous", "missing", "unavailable"]),
    categories: QuoteCategoriesSchema,
  }),
})
export type ManagedUsageCallValuation = z.infer<typeof ManagedUsageCallValuationSchema>

export const ManagedUsageTotalsSchema = z.strictObject({
  generationCount: z.number().int().nonnegative().max(100_000),
  categories: z.strictObject({
    uncachedInput: z.strictObject({
      tokens: FiniteNonnegative.nullable(),
      status: z.enum(["observed", "partial", "missing", "unavailable"]),
    }),
    output: z.strictObject({
      tokens: FiniteNonnegative.nullable(),
      status: z.enum(["observed", "partial", "missing", "unavailable"]),
    }),
    reasoning: z.strictObject({
      tokens: FiniteNonnegative.nullable(),
      status: z.enum(["observed", "partial", "missing", "unavailable"]),
    }),
    cacheRead: z.strictObject({
      tokens: FiniteNonnegative.nullable(),
      status: z.enum(["observed", "partial", "missing", "unavailable"]),
    }),
    cacheWrite: z.strictObject({
      tokens: FiniteNonnegative.nullable(),
      status: z.enum(["observed", "partial", "missing", "unavailable"]),
    }),
  }),
  marketCategories: z.strictObject({
    uncachedInput: z.strictObject({
      valueUSD: FiniteNonnegative.nullable(),
      subtotalUSD: FiniteNonnegative.nullable(),
      status: z.enum(["observed", "partial", "missing", "unavailable"]),
    }),
    output: z.strictObject({
      valueUSD: FiniteNonnegative.nullable(),
      subtotalUSD: FiniteNonnegative.nullable(),
      status: z.enum(["observed", "partial", "missing", "unavailable"]),
    }),
    reasoning: z.strictObject({
      valueUSD: FiniteNonnegative.nullable(),
      subtotalUSD: FiniteNonnegative.nullable(),
      status: z.enum(["observed", "partial", "missing", "unavailable"]),
    }),
    cacheRead: z.strictObject({
      valueUSD: FiniteNonnegative.nullable(),
      subtotalUSD: FiniteNonnegative.nullable(),
      status: z.enum(["observed", "partial", "missing", "unavailable"]),
    }),
    cacheWrite: z.strictObject({
      valueUSD: FiniteNonnegative.nullable(),
      subtotalUSD: FiniteNonnegative.nullable(),
      status: z.enum(["observed", "partial", "missing", "unavailable"]),
    }),
  }),
  valueUSD: FiniteNonnegative.nullable(),
  subtotalUSD: FiniteNonnegative.nullable(),
  status: z.enum(["observed", "partial", "missing", "unavailable"]),
})
export type ManagedUsageTotals = z.infer<typeof ManagedUsageTotalsSchema>
type ManagedUsageSummaryCategories = ManagedUsageTotals["categories"]
type ManagedUsageCategoryQuote =
  ManagedUsageCallValuation["quote"]["categories"][ManagedUsageCategory]

export const ManagedUsageCurrentPriceSchema = z.strictObject({
  indexID: z.string().min(1).max(256),
  retrievedAt: z.iso.datetime(),
  freshness: z.enum(["current", "stale", "unknown", "unavailable"]),
  policy: z
    .strictObject({
      revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      sources: z.array(z.enum(["openrouter", "opencode", "models-dev"])).max(3),
      fallback: z.literal("whole-model"),
    })
    .nullable(),
  access: z
    .strictObject({
      openrouter: z.enum(["configured", "not-configured", "reauthentication-required", "unknown"]),
      opencode: z.enum(["configured", "unknown"]),
      "models-dev": z.enum(["configured", "unknown"]),
    })
    .nullable(),
  pins: z.array(CurrentPriceIndexSchema.shape.pins.element).max(4_000),
})
type ManagedUsageCurrentPrice = z.infer<typeof ManagedUsageCurrentPriceSchema>

export const ManagedUsageValuationSchema = z.strictObject({
  calls: z.array(ManagedUsageCallValuationSchema).max(100_000),
  currentPrice: ManagedUsageCurrentPriceSchema.nullable(),
})
export type ManagedUsageValuation = z.infer<typeof ManagedUsageValuationSchema>

export type ManagedUsagePriceState = {
  index: CurrentPriceIndex
  freshness: "current" | "stale" | "unknown"
  settings?: ModelPriceSourceSettings
}
export type ManagedUsageIndexReader = (
  routes: readonly CurrentPriceApplicability[],
  signal: AbortSignal,
) => Promise<ManagedUsagePriceState>
export type ManagedUsagePriceProvider = (
  calls: readonly ManagedUsageGeneration[],
  signal: AbortSignal,
) => Promise<ManagedUsageValuation>

const CATEGORY_RATE: Record<ManagedUsageCategory, keyof CurrentPricePin["rates"]> = {
  uncachedInput: "uncachedInput",
  output: "completion",
  reasoning: "completion",
  cacheRead: "cacheRead",
  cacheWrite: "cacheWrite",
}

function routeIdentity(route: ManagedUsageRoute) {
  return JSON.stringify([route.providerID, route.modelID, route.variant])
}

function exactRoute(pin: CurrentPricePin, route: ManagedUsageRoute) {
  return Boolean(
    pin.route &&
    pin.route.providerID === route.providerID &&
    pin.route.modelID === route.modelID &&
    pin.route.variant === route.variant,
  )
}

function perTokenRate(pin: CurrentPricePin, category: ManagedUsageCategory): Decimal | null {
  const raw = pin.rates[CATEGORY_RATE[category]]
  if (raw === null) return null
  const parsed = decimal(raw)
  if (!parsed) return null
  return pin.rates.unit === "USD per million tokens"
    ? { coefficient: parsed.coefficient, scale: parsed.scale + 6 }
    : parsed
}

function zeroValue(tokens: number, categoryStatus: string) {
  return {
    tokens,
    rateUSDPerToken: null,
    valueUSD: 0,
    subtotalUSD: 0,
    status: categoryStatus === "observed" ? ("zero-usage" as const) : ("unknown" as const),
    reason:
      categoryStatus === "observed"
        ? null
        : "The observed zero is only a partial usage subtotal, not complete zero usage.",
  }
}

function unknownCategory(
  tokens: number | null,
  reason: string,
  status: "unknown" | "unavailable" = "unknown",
) {
  return { tokens, rateUSDPerToken: null, valueUSD: null, subtotalUSD: null, status, reason }
}

type CategoryPriceInput = {
  category: ManagedUsageCategory
  route: ManagedUsageRoute | null
  routeStatus: string
  candidates: readonly CurrentPricePin[]
  priceUnavailable: boolean
}

type CategoryPriceBlocker = { reason: string; status: "unknown" | "unavailable" }

function unknownPrice(reason: string): CategoryPriceBlocker {
  return { reason, status: "unknown" }
}

function categoryPriceBlocker(input: CategoryPriceInput) {
  if (input.priceUnavailable)
    return {
      reason: "The Models current price source could not be read.",
      status: "unavailable" as const,
    }
  if (input.routeStatus !== "observed" || !input.route)
    return unknownPrice("Positive native usage has no single exact observed route.")
  if (input.candidates.length > 1)
    return unknownPrice("More than one current price pin matches the exact route.")
  const pin = input.candidates[0]
  if (!pin) return unknownPrice("No supplied current price pin matches the exact route.")
  const blockers = currentPricePinBlockers(pin)
  if (blockers.length)
    return unknownPrice(`The current product/price pin is unresolved: ${blockers.join(", ")}.`)
  const rate = perTokenRate(pin, input.category)
  if (!rate)
    return unknownPrice(
      `The current price pin has no applicable ${CATEGORY_RATE[input.category]} rate.`,
    )
  return { pin, rate }
}

function priceCategory(input: {
  category: ManagedUsageCategory
  tokens: number | null
  usageStatus: string
  route: ManagedUsageRoute | null
  routeStatus: string
  candidates: readonly CurrentPricePin[]
  priceUnavailable: boolean
  freshness: "current" | "stale" | "unknown" | "unavailable"
}) {
  if (input.usageStatus === "unavailable")
    return unknownCategory(input.tokens, "Native token category is unavailable.", "unavailable")
  if (input.tokens === null)
    return unknownCategory(input.tokens, "Native token category is missing; missing is not zero.")
  if (input.tokens === 0) return zeroValue(input.tokens, input.usageStatus)
  const pricing = categoryPriceBlocker({
    category: input.category,
    route: input.route,
    routeStatus: input.routeStatus,
    candidates: input.candidates,
    priceUnavailable: input.priceUnavailable,
  })
  if ("reason" in pricing) return unknownCategory(input.tokens, pricing.reason, pricing.status)
  const { rate } = pricing
  const rateUSDPerToken = decimalNumber(rate)
  const amount = decimal(input.tokens)
  const value = amount ? multiplyDecimal(amount, rate) : null
  const valueUSD = value ? decimalNumber(value) : null
  if (rateUSDPerToken === null || valueUSD === null)
    return unknownCategory(
      input.tokens,
      "Usage-times-rate overflowed the finite USD output range.",
      "unavailable",
    )
  const stale = input.freshness !== "current"
  return {
    tokens: input.tokens,
    rateUSDPerToken,
    valueUSD: stale ? null : valueUSD,
    subtotalUSD: valueUSD,
    status: stale ? ("unknown" as const) : ("valued" as const),
    reason: stale
      ? "Cached price evidence is not current; the market subtotal is diagnostic only."
      : input.usageStatus === "observed"
        ? null
        : "Priced observed native-token subtotal; category coverage is partial.",
  }
}

function decimalSum(values: readonly (number | null)[]): number | null {
  const parsed = values.flatMap((value) => (value === null ? [] : [decimal(value)]))
  if (parsed.some((value) => value === null)) return null
  if (!parsed.length) return null
  let sum: Decimal = { coefficient: 0n, scale: 0 }
  for (const value of parsed) sum = addDecimal(sum, value!)
  return decimalNumber(sum)
}

function pinCandidates(
  call: ManagedUsageGeneration,
  index: CurrentPriceIndex | null,
): CurrentPricePin[] {
  if (!index || !call.route || call.routeStatus !== "observed") return []
  return index.pins.filter((pin) => exactRoute(pin, call.route!))
}

function quoteCategories(
  call: ManagedUsageGeneration,
  candidates: readonly CurrentPricePin[],
  priceUnavailable: boolean,
  freshness: "current" | "stale" | "unknown" | "unavailable",
) {
  return Object.fromEntries(
    MANAGED_USAGE_CATEGORIES.map((category) => {
      const measure = call.categories[category]
      return [
        category,
        priceCategory({
          category,
          tokens: measure.tokens,
          usageStatus: measure.status,
          route: call.route,
          routeStatus: call.routeStatus,
          candidates,
          priceUnavailable,
          freshness,
        }),
      ]
    }),
  ) as Record<ManagedUsageCategory, ReturnType<typeof priceCategory>>
}

function quoteStatus(
  values: readonly ReturnType<typeof priceCategory>[],
  subtotalUSD: number | null,
): ManagedUsageCallValuation["quote"]["status"] {
  if (values.some((value) => value.status === "unavailable")) return "unavailable"
  if (values.every((value) => value.status === "valued" || value.status === "zero-usage"))
    return subtotalUSD === null ? "unavailable" : "observed"
  if (values.some((value) => value.subtotalUSD !== null)) return "partial"
  if (values.every((value) => value.status === "unknown")) return "missing"
  return "partial"
}

function quotePinStatus(
  call: ManagedUsageGeneration,
  candidates: readonly CurrentPricePin[],
  priceUnavailable: boolean,
): ManagedUsageCallValuation["quote"]["pinStatus"] {
  if (priceUnavailable) return "unavailable"
  if (!call.route || call.routeStatus !== "observed") return "missing"
  if (candidates.length > 1) return "ambiguous"
  const pin = candidates[0]
  if (!pin) return "missing"
  return currentPricePinBlockers(pin).length ? "unresolved" : "resolved"
}

function quoteForCall(
  call: ManagedUsageGeneration,
  index: CurrentPriceIndex | null,
  priceUnavailable: boolean,
  freshness: "current" | "stale" | "unknown" | "unavailable",
) {
  const candidates = pinCandidates(call, index)
  const categories = quoteCategories(call, candidates, priceUnavailable, freshness)
  const values = MANAGED_USAGE_CATEGORIES.map((category) => categories[category])
  const known = values.filter((value) => value.subtotalUSD !== null)
  const subtotalUSD = decimalSum(known.map((value) => value.subtotalUSD))
  const status = quoteStatus(values, subtotalUSD)
  return {
    valueUSD: status === "observed" ? subtotalUSD : null,
    subtotalUSD,
    status,
    pinStatus: quotePinStatus(call, candidates, priceUnavailable),
    categories,
  }
}

function routeApplicabilities(
  calls: readonly ManagedUsageGeneration[],
): CurrentPriceApplicability[] {
  const byRoute = new Map<string, ManagedUsageGeneration[]>()
  for (const call of calls) {
    if (!call.route || call.routeStatus !== "observed") continue
    const id = routeIdentity(call.route)
    const entries = byRoute.get(id) ?? []
    entries.push(call)
    byRoute.set(id, entries)
  }
  return [...byRoute.values()].map((entries) => {
    const route = entries[0]!.route!
    const usage = Object.fromEntries(
      MANAGED_USAGE_CATEGORIES.map((category) => {
        const measures = entries.map((entry) => entry.categories[category])
        const statuses = new Set(measures.map((measure) => measure.status))
        const complete = statuses.size === 1 && statuses.has("observed")
        const tokens = complete ? decimalSum(measures.map((measure) => measure.tokens)) : null
        return [
          category,
          {
            value: tokens,
            status: complete
              ? tokens === null
                ? "unavailable"
                : "observed"
              : statuses.has("unavailable")
                ? "unavailable"
                : statuses.has("observed")
                  ? "partial"
                  : "missing",
          },
        ]
      }),
    ) as NonNullable<CurrentPriceApplicability["usage"]>
    return { route, usage }
  })
}

function currentPriceOutput(
  state: ManagedUsagePriceState,
  usedPins: readonly CurrentPricePin[],
): ManagedUsageCurrentPrice {
  const settings = state.settings
  return ManagedUsageCurrentPriceSchema.parse({
    indexID: state.index.indexID,
    retrievedAt: state.index.retrievedAt,
    freshness: state.freshness,
    policy: settings
      ? {
          revision: settings.policy.revision,
          sources: settings.policy.sources,
          fallback: settings.policy.fallback,
        }
      : null,
    access: settings
      ? {
          openrouter: settings.access.openrouter,
          opencode: settings.access.opencode,
          "models-dev": settings.access["models-dev"] ?? "configured",
        }
      : null,
    pins: [...new Map(usedPins.map((pin) => [canonical(pin), pin])).values()],
  })
}

export function projectManagedUsageValuation(input: {
  calls: readonly ManagedUsageGeneration[]
  index: CurrentPriceIndex | null
  freshness: "current" | "stale" | "unknown" | "unavailable"
  settings?: ModelPriceSourceSettings
}) {
  const index = input.index ? CurrentPriceIndexSchema.parse(input.index) : null
  const calls = input.calls.map((call) => ({
    ...call,
    quote: quoteForCall(call, index, input.freshness === "unavailable", input.freshness),
  }))
  const usedPins = index
    ? calls.flatMap((call) =>
        call.route && call.routeStatus === "observed"
          ? index.pins.filter((pin) => exactRoute(pin, call.route!))
          : [],
      )
    : []
  const currentPrice = index
    ? currentPriceOutput(
        {
          index,
          freshness: input.freshness === "unavailable" ? "unknown" : input.freshness,
          ...(input.settings ? { settings: input.settings } : {}),
        },
        usedPins,
      )
    : null
  return ManagedUsageValuationSchema.parse({ calls, currentPrice })
}

function usageCategoryTotal(
  calls: readonly ManagedUsageCallValuation[],
  category: ManagedUsageCategory,
) {
  const values = calls.map((call) => call.categories[category])
  const known = values.filter((value) => value.tokens !== null)
  const tokens = decimalSum(known.map((value) => value.tokens))
  const status =
    values.length === 0 || values.every((value) => value.status === "missing")
      ? "missing"
      : values.every((value) => value.status === "observed")
        ? tokens === null
          ? "unavailable"
          : "observed"
        : values.some((value) => value.status === "unavailable") && known.length === 0
          ? "unavailable"
          : "partial"
  return { tokens, status }
}

function marketCategoryStatus(
  values: readonly ManagedUsageCategoryQuote[],
  callCount: number,
  knownCount: number,
  subtotalUSD: number | null,
): ManagedUsageTotals["marketCategories"][ManagedUsageCategory]["status"] {
  if (callCount === 0) return "missing"
  const allKnown = values.every(
    (value) => value.status === "valued" || value.status === "zero-usage",
  )
  if (allKnown) return subtotalUSD === null ? "unavailable" : "observed"
  const hasUnavailable = values.some((value) => value.status === "unavailable")
  if (hasUnavailable && knownCount === 0) return "unavailable"
  if (knownCount > 0) return "partial"
  if (values.every((value) => value.status === "unknown")) return "missing"
  return "partial"
}

function marketCategoryTotal(
  calls: readonly ManagedUsageCallValuation[],
  category: ManagedUsageCategory,
) {
  const values = calls.map((call) => call.quote.categories[category])
  const known = values.filter((value) => value.subtotalUSD !== null)
  const subtotalUSD = decimalSum(known.map((value) => value.subtotalUSD))
  const status = marketCategoryStatus(values, calls.length, known.length, subtotalUSD)
  return {
    valueUSD: status === "observed" ? subtotalUSD : null,
    subtotalUSD,
    status,
  }
}

function overallQuoteStatus(
  calls: readonly ManagedUsageCallValuation[],
  subtotalUSD: number | null,
): ManagedUsageTotals["status"] {
  if (calls.length === 0) return "missing"
  if (calls.every((call) => call.quote.status === "observed"))
    return subtotalUSD === null ? "unavailable" : "observed"
  const known = calls.filter((call) => call.quote.subtotalUSD !== null)
  if (calls.some((call) => call.quote.status === "unavailable") && known.length === 0)
    return "unavailable"
  if (known.length > 0) return "partial"
  if (calls.every((call) => call.quote.status === "missing")) return "missing"
  return "partial"
}

export function managedUsageTotals(
  calls: readonly ManagedUsageCallValuation[],
): ManagedUsageTotals {
  const categories = Object.fromEntries(
    MANAGED_USAGE_CATEGORIES.map((category) => [category, usageCategoryTotal(calls, category)]),
  ) as ManagedUsageSummaryCategories
  const marketCategories = Object.fromEntries(
    MANAGED_USAGE_CATEGORIES.map((category) => [category, marketCategoryTotal(calls, category)]),
  )
  const subtotalUSD = decimalSum(calls.map((call) => call.quote.subtotalUSD))
  const status = overallQuoteStatus(calls, subtotalUSD)
  return ManagedUsageTotalsSchema.parse({
    generationCount: calls.length,
    categories,
    marketCategories,
    valueUSD: status === "observed" ? subtotalUSD : null,
    subtotalUSD,
    status,
  })
}

export function createManagedUsagePriceProvider(
  readIndex: ManagedUsageIndexReader,
): ManagedUsagePriceProvider {
  return async (calls, signal) => {
    signal.throwIfAborted()
    const routes = routeApplicabilities(calls)
    if (!routes.length)
      return projectManagedUsageValuation({
        calls,
        index: null,
        freshness: "unknown",
      })
    try {
      const state = await readIndex(routes, signal)
      signal.throwIfAborted()
      return projectManagedUsageValuation({
        calls,
        index: state.index,
        freshness: state.freshness,
        ...(state.settings ? { settings: state.settings } : {}),
      })
    } catch {
      signal.throwIfAborted()
      return projectManagedUsageValuation({
        calls,
        index: null,
        freshness: "unavailable",
      })
    }
  }
}
