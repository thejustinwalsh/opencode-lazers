import type { ConfigurationCost, CostRoute } from "./configuration-cost.ts"

const anyRoute: CostRoute = { providerID: "test", modelID: "model", variant: null }

/** A stored observed cost: a value, or a range when `high` differs. */
export function observedCostFixture(
  low: number,
  high = low,
  route: CostRoute = anyRoute,
): ConfigurationCost {
  return {
    kind: low === high ? "value" : "range",
    low,
    high,
    basis: "observed",
    status: low === high ? "exact" : "conditional",
    provenance: {
      source: "openrouter",
      retrievedAt: null,
      route,
      tokens: null,
      cacheAtInputRate: false,
    },
  }
}

/** A stored projected cost; `null` is a model no source prices. */
export function projectedCostFixture(usd: number | null, route: CostRoute = anyRoute) {
  return {
    kind: usd === null ? "none" : "value",
    low: usd,
    high: usd,
    basis: "projected",
    status: usd === null ? "unpriced" : "projected",
    provenance: {
      source: usd === null ? null : "openrouter",
      retrievedAt: null,
      route,
      tokens: null,
      cacheAtInputRate: false,
    },
  } satisfies ConfigurationCost as ConfigurationCost
}
