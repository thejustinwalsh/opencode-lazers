import type { CurrentPriceApplicability } from "./current-price-index.ts"
import type { ModelEvidenceComparisonSourceRead } from "./source-store.ts"
import type { CurrentPriceIndex, CurrentPricePin, TaskValuation } from "./valuation-schema.ts"
import { TrajectoryMarketEquivalentCostSchema } from "./task-valuation-schema.ts"
import type {
  SelectedPriceSource,
  TrajectoryMarketEquivalentCost,
} from "./task-valuation-schema.ts"
import { projectTaskValuation, taskValuationApplicabilities } from "./valuation.ts"
import type { ProjectTaskValuationRequest } from "./valuation.ts"

export type TaskValuationFreshness = "current" | "stale" | "unknown" | "unavailable"

type MarketCost = TaskValuation["marketEquivalentCost"]
type MarketSession = MarketCost["sessions"][number]

export type TaskValuationIndexRead = {
  index: CurrentPriceIndex
  freshness: Exclude<TaskValuationFreshness, "unavailable">
}

export type TaskValuationIndexReader = (
  routes: readonly CurrentPriceApplicability[],
  signal: AbortSignal,
) => Promise<TaskValuationIndexRead>

export type TaskValuationProvider = (
  input: ProjectTaskValuationRequest,
  signal: AbortSignal,
) => Promise<TrajectoryMarketEquivalentCost>

function sourceFromPin(pin: CurrentPricePin): SelectedPriceSource {
  return {
    source: pin.provenance.source,
    snapshotID: pin.provenance.snapshotID,
    generation: pin.provenance.generation,
    retrievedAt: pin.provenance.retrievedAt,
    asOf: pin.provenance.asOf,
    priceBasis: pin.semantics,
    rateUnit: pin.rates.unit,
  }
}

function sourceKey(source: SelectedPriceSource) {
  return JSON.stringify([
    source.source,
    source.snapshotID,
    source.generation,
    source.priceBasis,
    source.rateUnit,
  ])
}

function uniqueSources(sources: readonly SelectedPriceSource[]): SelectedPriceSource[] {
  const byIdentity = new Map<string, SelectedPriceSource>()
  for (const source of sources) {
    byIdentity.set(sourceKey(source), source)
  }
  return [...byIdentity.values()].sort((left, right) =>
    sourceKey(left).localeCompare(sourceKey(right)),
  )
}

function selectedSources(pins: readonly CurrentPricePin[]): SelectedPriceSource[] {
  return uniqueSources(pins.map(sourceFromPin))
}

function safeProjection(
  market: MarketCost,
  index: CurrentPriceIndex | null,
  freshness: TaskValuationFreshness,
): TrajectoryMarketEquivalentCost {
  const sessions = market.sessions.map((session) => ({
    sessionID: session.sessionID,
    attemptIDs: [...session.attemptIDs],
    routeAllocation: {
      status: session.routeAllocation.status,
      observedRouteCount: session.routeAllocation.observedRouteCount,
      meaning: session.routeAllocation.meaning,
    },
    pinStatus: session.pinStatus,
    categories: session.categories,
    valueUSD: session.valueUSD,
    subtotalUSD: session.subtotalUSD,
    status: session.status,
    sources: session.pinStatus === "resolved" ? selectedSources(session.pinCandidates) : [],
  }))
  const sources = uniqueSources(sessions.flatMap((session) => session.sources))
  return TrajectoryMarketEquivalentCostSchema.parse({
    valueUSD: market.valueUSD,
    subtotalUSD: market.subtotalUSD,
    unit: market.unit,
    status: market.status,
    basis: market.basis,
    meaning: market.meaning,
    currentIndex: index
      ? {
          indexID: index.indexID,
          retrievedAt: index.retrievedAt,
          freshness,
          sources,
        }
      : null,
    coverage: market.coverage,
    sessions,
  })
}

/** Same staleness rule as the Models decision index: only selected cached pins determine freshness. */
export function currentPriceIndexFreshness(
  index: CurrentPriceIndex,
  sources: readonly ModelEvidenceComparisonSourceRead[],
): Exclude<TaskValuationFreshness, "unavailable"> {
  const stale = index.pins.some((pin) => {
    const source = sources.find(
      (candidate) => candidate.snapshot?.snapshotID === pin.provenance.snapshotID,
    )
    return Boolean(
      source?.refresh &&
      (source.refresh.state === "failed" ||
        source.refresh.state === "cancelled" ||
        source.refresh.state === "refreshing"),
    )
  })
  return index.pins.length ? (stale ? "stale" : "current") : "unknown"
}

export function unavailableTaskValuation(
  input: ProjectTaskValuationRequest,
): TrajectoryMarketEquivalentCost {
  // The empty index is used only to reuse LZ-102's usage/coverage projection. It is never published.
  const valuation = projectTaskValuation({
    ...input,
    currentIndex: {
      indexID: "unavailable-internal-index",
      retrievedAt: "1970-01-01T00:00:00.000Z",
      pins: [],
    },
  })
  const baseline = valuation.marketEquivalentCost
  const sessions = baseline.sessions.map((session) => {
    const allZero = Object.values(session.categories).every(
      (category) => category.status === "zero-usage",
    )
    const categories = Object.fromEntries(
      Object.entries(session.categories).map(([name, category]) => [
        name,
        category.tokens !== null && category.tokens > 0
          ? {
              ...category,
              rateUSDPerToken: null,
              valueUSD: null,
              status: "unavailable" as const,
              reason: "The current Models price source could not be read.",
            }
          : category,
      ]),
    ) as MarketSession["categories"]
    return {
      ...session,
      pinCandidates: [],
      categories,
      valueUSD: allZero ? 0 : null,
      subtotalUSD: allZero ? 0 : null,
      status: allZero ? ("observed" as const) : ("unavailable" as const),
    }
  })
  const allZero = sessions.length > 0 && sessions.every((session) => session.status === "observed")
  const market = {
    ...baseline,
    valueUSD: allZero ? 0 : null,
    subtotalUSD: allZero ? 0 : null,
    status: allZero
      ? ("observed" as const)
      : sessions.length
        ? ("unavailable" as const)
        : ("missing" as const),
    sessions,
  }
  return safeProjection(market, null, "unavailable")
}

/** Models-owned composition of the existing valuation and cached current-price selection path. */
export function createTaskValuationReader(
  readIndex: TaskValuationIndexReader,
): TaskValuationProvider {
  return async (input, signal) => {
    signal.throwIfAborted()
    try {
      const routes = taskValuationApplicabilities(input)
      const state = await readIndex(routes, signal)
      signal.throwIfAborted()
      const valuation = projectTaskValuation({ ...input, currentIndex: state.index })
      return safeProjection(valuation.marketEquivalentCost, state.index, state.freshness)
    } catch {
      signal.throwIfAborted()
      return unavailableTaskValuation(input)
    }
  }
}
