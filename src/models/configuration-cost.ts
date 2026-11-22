import type { BenchmarkPrice } from "./benchmark-baseline.ts"
import {
  formatMarketAmount,
  formatMarketRange,
  modelEffortLabel,
} from "./comparison-presentation.ts"
import type { ModelDecisionGraphPoint } from "./decision-contract.ts"
import type { ModelPriceSource } from "./price-source-settings.ts"
import type { ModelDecisionReferenceEstimate } from "./reference-estimate.ts"

/**
 * The one cost the panel shows for a configuration. Every view (catalog table, "Your runs" chart,
 * Projected ranking and scatter, Benchmark tooltip, pane) renders this object and computes
 * nothing; the decision worker builds it once per configuration and the store keeps it.
 *
 * ```
 *   observed   graph point ─┐
 *              reference ───┼─► configurationCost ─► { kind, low, high, basis, status, provenance }
 *   projected  list price ──┤
 *              median tokens┘
 *
 *   kind   value  low = high      "$0.44"      (status partial: a lower bound, "≥$0.44")
 *          range  low < high      "$0.57–$1.09"  drawn as a whisker, mark at the midpoint
 *          none   no source prices it: no price UI at all, never "unknown", never $0
 * ```
 */
export type CostBasis = "observed" | "projected"

/** The wording of each basis, the same in every view. */
export const COST_BASIS_LABEL: Record<CostBasis, string> = {
  observed: "Observed in your runs",
  projected: "Projected from list prices × your median tokens",
}

/**
 * `exact` a whole price; `conditional` a range over conditional rates; `partial` only some token
 * categories are priced (a lower bound on the total); `projected` list price × median tokens;
 * `unpriced` no configured source prices it.
 */
export type CostStatus = "exact" | "conditional" | "partial" | "projected" | "unpriced"

export type CostRoute = { providerID: string; modelID: string; variant: string | null }

/** Measured tokens behind the cost: per accepted task by category, and the denominator. */
export type CostTokens = {
  perAcceptedTask: number | null
  uncachedInput: number | null
  cacheRead: number | null
  cacheWrite: number | null
  output: number | null
  reasoning: number | null
  acceptedTasks: number
}

export type ConfigurationCost = {
  kind: "value" | "range" | "none"
  /** USD per accepted task; both null for `none`, equal for `value`. */
  low: number | null
  high: number | null
  basis: CostBasis
  status: CostStatus
  provenance: {
    /** The chosen price source; `mixed` when several priced one observed configuration. */
    source: ModelPriceSource | "mixed" | null
    retrievedAt: string | null
    /** The exact execution provider, model and effort (null effort: the model's list price). */
    route: CostRoute
    tokens: CostTokens | null
    /** A cache rate was missing and priced at the input rate. */
    cacheAtInputRate: boolean
  }
}

/** The market the observed points were priced in (the decision context's price index). */
export type ObservedMarket = {
  source: ModelPriceSource | "mixed" | null
  retrievedAt: string | null
}

/** Median tokens per accepted task by category (`tokenProfile`). */
type Profile = {
  uncachedInput: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
  acceptedTasks: number
}

export type ConfigurationCostInput =
  | {
      basis: "observed"
      route: CostRoute
      point: ModelDecisionGraphPoint | null
      reference: ModelDecisionReferenceEstimate | null
      /** Token coordinate of a reference-only configuration. */
      tokensPerAcceptedTask: number | null
      market: ObservedMarket
    }
  | { basis: "projected"; route: CostRoute; price: BenchmarkPrice | null; profile: Profile | null }

const finite = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0

function observedCost(input: Extract<ConfigurationCostInput, { basis: "observed" }>) {
  const { point, reference } = input
  const estimateSource = reference?.provenance.source ? ("openrouter" as const) : null
  const fromReference = {
    source: estimateSource,
    retrievedAt: reference?.provenance.retrievedAt ?? null,
  }
  const categories = reference?.coverage.categories as
    Partial<NonNullable<typeof reference>["coverage"]["categories"]> | undefined
  const tokens: CostTokens | null =
    point || reference
      ? {
          perAcceptedTask: point?.tokensPerAcceptedTask ?? input.tokensPerAcceptedTask,
          uncachedInput: categories?.uncachedInput?.tokens ?? null,
          cacheRead: categories?.cacheRead?.tokens ?? null,
          cacheWrite: categories?.cacheWrite?.tokens ?? null,
          output: categories?.output?.tokens ?? null,
          reasoning: categories?.reasoning?.tokens ?? null,
          acceptedTasks: point?.acceptedTaskCount ?? reference?.acceptedTaskCount ?? 0,
        }
      : null
  const made = (
    kind: ConfigurationCost["kind"],
    low: number | null,
    high: number | null,
    status: CostStatus,
    from: ObservedMarket,
  ): ConfigurationCost => ({
    kind,
    low,
    high,
    basis: "observed",
    status,
    provenance: { ...from, route: input.route, tokens, cacheAtInputRate: false },
  })
  // A range is the honest statement and wins; a point's market value comes next.
  const range =
    reference?.status === "conditional"
      ? reference.rangeUSDPerAcceptedTask
      : reference?.status === "partial" && reference.knownSubtotalUSDPerAcceptedTask === null
        ? reference.knownSubtotalRangeUSDPerAcceptedTask
        : null
  if (range && finite(range.minimum) && finite(range.maximum))
    return range.minimum === range.maximum
      ? made("value", range.minimum, range.minimum, reference!.status as CostStatus, fromReference)
      : made("range", range.minimum, range.maximum, reference!.status as CostStatus, fromReference)
  if (point && finite(point.currentMarketUSDPerAcceptedTask))
    return made(
      "value",
      point.currentMarketUSDPerAcceptedTask,
      point.currentMarketUSDPerAcceptedTask,
      "exact",
      input.market,
    )
  if (reference?.status === "exact" && finite(reference.valueUSDPerAcceptedTask))
    return made(
      "value",
      reference.valueUSDPerAcceptedTask,
      reference.valueUSDPerAcceptedTask,
      "exact",
      fromReference,
    )
  if (reference?.status === "partial" && finite(reference.knownSubtotalUSDPerAcceptedTask))
    return made(
      "value",
      reference.knownSubtotalUSDPerAcceptedTask,
      reference.knownSubtotalUSDPerAcceptedTask,
      "partial",
      fromReference,
    )
  return made("none", null, null, "unpriced", { source: null, retrievedAt: null })
}

/** List prices (USD per 1M tokens) times the median tokens. Reasoning tokens bill as output. */
function projectedCost(input: Extract<ConfigurationCostInput, { basis: "projected" }>) {
  const { price, profile } = input
  if (!price || !profile)
    return {
      kind: "none",
      low: null,
      high: null,
      basis: "projected",
      status: "unpriced",
      provenance: {
        source: null,
        retrievedAt: null,
        route: input.route,
        tokens: null,
        cacheAtInputRate: false,
      },
    } satisfies ConfigurationCost
  const cacheReadRate = price.cacheRead ?? price.input
  const cacheWriteRate = price.cacheWrite ?? price.input
  const usd =
    (profile.uncachedInput * price.input +
      profile.cacheRead * cacheReadRate +
      profile.cacheWrite * cacheWriteRate +
      (profile.output + profile.reasoning) * price.output) /
    1_000_000
  return {
    kind: "value",
    low: usd,
    high: usd,
    basis: "projected",
    status: "projected",
    provenance: {
      source: price.source,
      retrievedAt: price.retrievedAt,
      route: input.route,
      tokens: {
        perAcceptedTask:
          profile.uncachedInput +
          profile.cacheRead +
          profile.cacheWrite +
          profile.output +
          profile.reasoning,
        uncachedInput: profile.uncachedInput,
        cacheRead: profile.cacheRead,
        cacheWrite: profile.cacheWrite,
        output: profile.output,
        reasoning: profile.reasoning,
        acceptedTasks: profile.acceptedTasks,
      },
      cacheAtInputRate:
        (price.cacheRead === null && profile.cacheRead > 0) ||
        (price.cacheWrite === null && profile.cacheWrite > 0),
    },
  } satisfies ConfigurationCost
}

/** The cost of one exact configuration on one basis. No other code computes a displayed cost. */
export function configurationCost(input: ConfigurationCostInput): ConfigurationCost {
  return input.basis === "observed" ? observedCost(input) : projectedCost(input)
}

/** Where a mark sits: the value, or a range's midpoint. Null for `none`. */
export function costPosition(cost: ConfigurationCost | null | undefined) {
  if (!cost || cost.kind === "none") return null
  return cost.kind === "range" ? cost.low! / 2 + cost.high! / 2 : cost.low
}

/** "$0.44", "≥$0.44" (a partial value: a lower bound) or "$0.57–$1.09"; "" for `none`. */
export function costText(cost: ConfigurationCost | null | undefined) {
  if (!cost || cost.kind === "none") return ""
  if (cost.kind === "range") return formatMarketRange({ minimum: cost.low!, maximum: cost.high! })
  return `${cost.status === "partial" ? "≥" : ""}${formatMarketAmount(cost.low!)}`
}

/** The model name with the effort the cost was measured at: "GPT-6 Luna · max". */
export function costConfigurationLabel(label: string, cost: ConfigurationCost) {
  return modelEffortLabel(label, cost.provenance.route)
}

/** "Observed in your runs: $0.57–$1.09"; "" for `none`. */
export function costLine(cost: ConfigurationCost | null | undefined) {
  const text = costText(cost)
  return text ? `${COST_BASIS_LABEL[cost!.basis]}: ${text}` : ""
}

/** The low and high a chart draws as a whisker, when the cost is a range. */
export function costRange(cost: ConfigurationCost | null | undefined) {
  return cost?.kind === "range" ? { low: cost.low!, high: cost.high! } : undefined
}
