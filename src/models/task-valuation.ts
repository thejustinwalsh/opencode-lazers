import type { CurrentPriceApplicability } from "./current-price-index.ts"
import type { ModelEvidenceComparisonSourceRead } from "./source-store.ts"
import type { CurrentPriceIndex, CurrentPricePin, TaskValuation } from "./valuation-schema.ts"
import { calculateConfiguredKnownUsageMarket } from "./market-range.ts"
import type {
  KnownUsageMarketScenario,
  KnownUsageMarketSession,
  MarketRangeRoute,
} from "./market-range.ts"
import type { ModelPriceSourceSettings } from "./price-source-settings.ts"
import { TrajectoryMarketEquivalentCostSchema } from "./task-valuation-schema.ts"
import type {
  ObservedUsageEstimate,
  SelectedPriceSource,
  TrajectoryMarketEquivalentCost,
} from "./task-valuation-schema.ts"
import { ObservedUsageEstimateSchema } from "./task-valuation-schema.ts"
import { projectTaskValuation, taskValuationApplicabilities } from "./valuation.ts"
import { taskValuationPerCallUsage } from "./valuation.ts"
import type { ProjectTaskValuationRequest } from "./valuation.ts"

export type TaskValuationFreshness = "current" | "stale" | "unknown" | "unavailable"

type MarketCost = TaskValuation["marketEquivalentCost"]
type MarketSession = MarketCost["sessions"][number]

export type TaskValuationIndexRead = {
  index: CurrentPriceIndex
  freshness: Exclude<TaskValuationFreshness, "unavailable">
  settings?: ModelPriceSourceSettings
  sources?: readonly ModelEvidenceComparisonSourceRead[]
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
  observedUsageEstimate?: ObservedUsageEstimate | null,
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
    ...(observedUsageEstimate ? { observedUsageEstimate } : {}),
    sessions,
  })
}

function estimateSessions(
  valuation: TaskValuation,
  input: ProjectTaskValuationRequest,
): KnownUsageMarketSession[] {
  const marketBySession = new Map(
    valuation.marketEquivalentCost.sessions.map((session) => [session.sessionID, session]),
  )
  const attemptsBySession = new Map<string, typeof input.attempts>()
  for (const attempt of input.attempts) {
    const values = attemptsBySession.get(attempt.sessionID) ?? []
    values.push(attempt)
    attemptsBySession.set(attempt.sessionID, values)
  }
  return valuation.usage.sessions.map((usage) => {
    const market = marketBySession.get(usage.sessionID)
    const attempts = attemptsBySession.get(usage.sessionID) ?? []
    return {
      sessionID: usage.sessionID,
      route: market?.routeAllocation.route ?? null,
      routeStatus: market?.routeAllocation.status ?? "unavailable",
      shared: false,
      categories: Object.fromEntries(
        Object.entries(usage.categories).map(([category, measure]) => [
          category,
          { tokens: measure.value, status: measure.status },
        ]),
      ) as KnownUsageMarketSession["categories"],
      attempts: attempts.map((attempt, index) => ({
        id: attempt.id,
        state: attempt.state,
        retry: index > 0,
      })),
    }
  })
}

function routeKey(route: MarketRangeRoute) {
  return JSON.stringify([route.providerID, route.modelID, route.variant])
}

function marketRangeForScenario(scenario: KnownUsageMarketScenario) {
  if (scenario.valueUSD !== null) return { minimum: scenario.valueUSD, maximum: scenario.valueUSD }
  return scenario.rangeUSD
}

function pricedRangeForScenario(scenario: KnownUsageMarketScenario) {
  return marketRangeForScenario(scenario) ?? scenario.knownSubtotalUSD
}

function sumRange(values: readonly { minimum: number; maximum: number }[]) {
  if (!values.length) return null
  const minimum = values.reduce((sum, value) => sum + value.minimum, 0)
  const maximum = values.reduce((sum, value) => sum + value.maximum, 0)
  return Number.isFinite(minimum) && Number.isFinite(maximum) ? { minimum, maximum } : null
}

function observedUsageEstimate(input: {
  valuation: TaskValuation
  request: ProjectTaskValuationRequest
  settings: ModelPriceSourceSettings
  sources: readonly ModelEvidenceComparisonSourceRead[]
}): ObservedUsageEstimate | null {
  const sessions = estimateSessions(input.valuation, input.request)
  const byRoute = new Map<string, MarketRangeRoute>()
  for (const session of sessions) {
    if (session.routeStatus !== "single-observed-route" || !session.route || session.shared)
      continue
    const route = {
      providerID: session.route.providerID,
      modelID: session.route.modelID,
      variant: session.route.variant,
    }
    byRoute.set(routeKey(route), route)
  }
  const routeResults = [...byRoute.values()].map((route) => {
    const perCall = taskValuationPerCallUsage(input.request, route)
    const market = calculateConfiguredKnownUsageMarket({
      route,
      settings: input.settings,
      sources: input.sources,
      sessions,
      perCallUsage: perCall.calls,
      perCallCoverageComplete: perCall.complete,
    })
    return {
      calls: perCall.calls,
      scenario: market.scenarios[0],
      market,
    }
  })
  const priced = routeResults.flatMap((result) =>
    result.scenario && pricedRangeForScenario(result.scenario)
      ? [{ ...result, amount: pricedRangeForScenario(result.scenario)! }]
      : [],
  )
  if (!priced.length) return null

  const routeCoverageComplete =
    sessions.length > 0 &&
    sessions.every(
      (session) =>
        !session.shared &&
        session.routeStatus === "single-observed-route" &&
        session.route !== null,
    ) &&
    routeResults.length === byRoute.size &&
    routeResults.every(
      ({ scenario }) => scenario && (scenario.status === "exact" || scenario.status === "range"),
    )
  const isExact =
    routeCoverageComplete &&
    routeResults.every(({ scenario }) => scenario?.status === "exact" && scenario.valueUSD !== null)
  const isRange =
    routeCoverageComplete &&
    routeResults.every(
      ({ scenario }) => scenario?.status === "exact" || scenario?.status === "range",
    )
  const fullRange = isRange
    ? sumRange(
        routeResults.flatMap(({ scenario }) => {
          if (!scenario) return []
          const amount = marketRangeForScenario(scenario)
          return amount ? [amount] : []
        }),
      )
    : null
  const pricedPortion = sumRange(priced.map(({ amount }) => amount))
  if (!pricedPortion) return null

  const scenarios = routeResults.flatMap(({ scenario }) => (scenario ? [scenario] : []))
  const sourceValues = new Map<string, ObservedUsageEstimate["sources"][number]>()
  for (const scenario of scenarios) {
    if (scenario.freshness === "unavailable") continue
    const provenance = scenario.provenance
    if (
      (provenance.source !== "openrouter-models" && provenance.source !== "native-catalog") ||
      !provenance.snapshotID ||
      !provenance.snapshotGeneration ||
      !provenance.retrievedAt
    )
      continue
    const source = {
      source: provenance.source,
      snapshotID: provenance.snapshotID,
      generation: provenance.snapshotGeneration,
      currentGeneration: provenance.currentGeneration ?? provenance.snapshotGeneration,
      retrievedAt: provenance.retrievedAt,
      freshness: scenario.freshness,
      priceBasis: provenance.priceBasis,
      sourceURL: provenance.sourceURL,
    } as const
    sourceValues.set(
      JSON.stringify([source.source, source.snapshotID, source.generation, source.priceBasis]),
      source,
    )
  }
  if (!sourceValues.size) return null

  const categoryNames = ["uncachedInput", "output", "reasoning", "cacheRead", "cacheWrite"] as const
  const categories = Object.fromEntries(
    categoryNames.map((name) => {
      const measures = scenarios.map((scenario) => scenario.coverage.categories[name])
      const known = measures.filter((measure) => measure.tokens !== null)
      const tokens = known.length ? known.reduce((sum, measure) => sum + measure.tokens!, 0) : null
      const status = measures.every((measure) => measure.status === "observed")
        ? "observed"
        : known.length
          ? "partial"
          : measures.some((measure) => measure.status === "unavailable")
            ? "unavailable"
            : measures.some((measure) => measure.status === "partial")
              ? "partial"
              : "missing"
      return [name, { tokens, status }]
    }),
  ) as ObservedUsageEstimate["categories"]

  const tierStatuses = scenarios.map((scenario) => scenario.tierAttribution.status)
  const tierAttribution = {
    status: tierStatuses.every((status) => status === "resolved-per-call")
      ? ("resolved-per-call" as const)
      : tierStatuses.every((status) => status === "not-required")
        ? ("not-required" as const)
        : tierStatuses.some((status) => status === "unsupported")
          ? ("unsupported" as const)
          : ("unresolved" as const),
    basis: tierStatuses.every((status) => status === "resolved-per-call")
      ? ("complete-per-call-prompt-usage" as const)
      : tierStatuses.every((status) => status === "not-required")
        ? ("single-published-rate-scenario" as const)
        : ("aggregate-tier-envelope" as const),
    callCount: new Set(routeResults.flatMap(({ calls }) => calls.map(({ callID }) => callID))).size,
    selectedTierIDs: [
      ...new Set(scenarios.flatMap((scenario) => scenario.tierAttribution.selectedTierIDs)),
    ].slice(0, 100),
    promptThresholds: [
      ...new Set(scenarios.flatMap((scenario) => scenario.tierAttribution.promptThresholds)),
    ].sort((left, right) => left - right),
    thresholdSemantics:
      scenarios.find((scenario) => scenario.tierAttribution.thresholdSemantics !== null)
        ?.tierAttribution.thresholdSemantics ?? null,
  }
  const rateSets = [
    ...new Map(
      scenarios.flatMap((scenario) =>
        scenario.rateSets.map((rateSet) => [JSON.stringify(rateSet), rateSet] as const),
      ),
    ).values(),
  ].slice(0, 1_000)
  const recoveryGapCount = input.request.progressFacts.filter((fact) => {
    const value =
      typeof fact === "object" && fact !== null ? (fact as Record<string, unknown>) : null
    const kind = typeof value?.kind === "string" ? value.kind : ""
    return kind === "worker-gap" || kind === "gap"
  }).length
  const assumptions = [
    `Priced ${tierAttribution.callCount} deduplicated retained call measurements against the selected published schedule; cumulative session snapshots are not added to their component steps.`,
    ...(tierAttribution.promptThresholds.length
      ? [
          "Prompt-tier selectors use uncached input + cache read + cache write per call; the published override applies only above the listed threshold.",
        ]
      : []),
    ...(recoveryGapCount
      ? [
          `${recoveryGapCount} retained recovery-gap records remain; the estimate covers observed retained usage and does not guarantee full historical call coverage.`,
        ]
      : []),
    "This is a current-market observed-usage estimate, not a historical invoice or guaranteed bill.",
  ]
  const sources = [...sourceValues.values()]
  const freshness = sources.some((source) => source.freshness === "stale") ? "stale" : "current"
  const status = isExact ? "estimate" : isRange ? "range" : "partial"
  const valueUSD = isExact
    ? (sumRange(
        routeResults.flatMap(({ scenario }) =>
          scenario?.valueUSD === null || scenario?.valueUSD === undefined
            ? []
            : [{ minimum: scenario.valueUSD, maximum: scenario.valueUSD }],
        ),
      )?.minimum ?? null)
    : null

  return ObservedUsageEstimateSchema.parse({
    label: "Current-market observed-usage estimate",
    status,
    valueUSD,
    rangeUSD: isRange && !isExact ? fullRange : null,
    pricedPortionUSD: status === "partial" ? pricedPortion : null,
    unit: "USD",
    basis: "deduplicated-retained-token-usage-at-published-current-rates",
    meaning:
      "Current published-market pricing applied to deduplicated retained worker usage only. Exact prices are exact for the retained measurements, not proof of a complete historical bill; Architect, review, integration, and unrecovered usage are not attributed.",
    freshness,
    sources,
    rateSets,
    categories,
    tierAttribution,
    retainedCallCount: new Set(
      routeResults.flatMap(({ calls }) => calls.map(({ callID }) => callID)),
    ).size,
    recoveryGapCount,
    assumptions,
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
      const estimate =
        state.settings && state.sources
          ? observedUsageEstimate({
              valuation,
              request: input,
              settings: state.settings,
              sources: state.sources,
            })
          : null
      return safeProjection(valuation.marketEquivalentCost, state.index, state.freshness, estimate)
    } catch {
      signal.throwIfAborted()
      return unavailableTaskValuation(input)
    }
  }
}
