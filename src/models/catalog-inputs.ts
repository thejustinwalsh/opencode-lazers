import type { BenchmarkRoute, BenchmarkSourceDates } from "./benchmark-baseline.ts"
import { routeKey } from "./benchmark-baseline.ts"
import { buildCatalog, tokenProfile } from "./catalog-projection.ts"
import type { ObservedFacts } from "./catalog-projection.ts"
import { comparisonChartMarks, referenceAmount } from "./chart-data.ts"
import type { ComparisonChartPoint, ComparisonChartReference } from "./chart-data.ts"
import type { PublicCatalogItem } from "./comparison-schema.ts"
import { modelDisplayLabel, modelDisplayName, routeLabel } from "./comparison-presentation.ts"
import type { ModelCandidate } from "./comparison-presentation.ts"
import type { ModelDecisionOverview } from "./decision-contract.ts"
import type { ModelPriceSource } from "./price-source-settings.ts"

/**
 * The inputs of the ranked catalog, as pure functions of the decision overview, the comparison
 * candidates, the native catalog names and the router's routes. The decision worker
 * (`decision-view.ts`) builds each stored view through these, the panel's own computation moved
 * off the GUI; the view tests compare it with the inputs the GUI used to hold.
 */
type Graph = ModelDecisionOverview["graph"]
/** The native catalog's names: the live `model.list`, or the native evidence snapshot's records. */
export type CatalogNames = ReadonlyArray<{ providerID: string; id: string; name: string }>

/** The overview's reference estimates with their producer labels and effort coordinates. */
export function chartReferences(
  graph: Graph,
  candidates: readonly ModelCandidate[],
  catalog: CatalogNames,
): ComparisonChartReference[] {
  const points = new Map(graph.points.map((point) => [point.configurationID, point] as const))
  const routes = (graph.referenceEstimates ?? []).map((item) => item.estimate.route)
  return (graph.referenceEstimates ?? []).map((item) => {
    const point = points.get(item.configurationID)
    return {
      configurationID: item.configurationID,
      estimate: item.estimate,
      // An explicit null is authoritative: never replace unknown global data
      // with a number or label discovered on a loaded page or inspection.
      tokensPerAcceptedTask: Object.hasOwn(item, "tokensPerAcceptedTask")
        ? (item.tokensPerAcceptedTask ?? null)
        : (point?.tokensPerAcceptedTask ?? null),
      label: modelDisplayLabel(item.estimate.route, routes, candidates, catalog),
    }
  })
}

/** The overview's graph points with their route, display label and market source. */
export function chartPoints(
  overview: ModelDecisionOverview,
  references: readonly ComparisonChartReference[],
  candidates: readonly ModelCandidate[],
  catalog: CatalogNames,
): ComparisonChartPoint[] {
  const marketSource = overview.context.priceIndex.source
  const routeByConfiguration = new Map(
    references.map((reference) => [reference.configurationID, reference.estimate.route] as const),
  )
  const routes = references.map((reference) => reference.estimate.route)
  return overview.graph.points.map((point) => {
    const route = routeByConfiguration.get(point.configurationID)
    return {
      ...point,
      ...(route
        ? {
            label: modelDisplayLabel(route, routes, candidates, catalog),
            route,
          }
        : {}),
      marketSource,
    }
  })
}

/** Observed facts by route (provider and model, any effort), from the chart's marks. */
function observedFactsByRoute(
  points: readonly ComparisonChartPoint[],
  references: readonly ComparisonChartReference[],
): Map<string, ObservedFacts> {
  const facts = new Map<string, ObservedFacts>()
  for (const mark of comparisonChartMarks({ points, references, frontierConfigurationIDs: [] })) {
    if (!mark.route) continue
    const key = routeKey({ providerID: mark.route.providerID, modelID: mark.route.modelID })
    // Efforts are one model here; the best-sampled effort speaks for it.
    if ((facts.get(key)?.accepted ?? -1) >= (mark.accepted ?? 0)) continue
    facts.set(key, {
      configurationID: mark.configurationID,
      usd: mark.amount,
      ...(mark.range ? { range: mark.range } : {}),
      tokens: mark.tokens,
      accepted: mark.accepted ?? 0,
      terminal: mark.terminal ?? null,
    })
  }
  // A model with a price but no token measurement is listed in the table, not plotted.
  for (const reference of references) {
    const amount = referenceAmount(reference.estimate)
    const route = reference.estimate.route
    const key = routeKey({ providerID: route.providerID, modelID: route.modelID })
    if (!amount || facts.has(key)) continue
    facts.set(key, {
      configurationID: reference.configurationID,
      usd: amount.kind === "scalar" || amount.kind === "subtotal" ? amount.value : amount.minimum,
      ...(amount.kind === "range" || amount.kind === "subtotal-range"
        ? { range: { minimum: amount.minimum, maximum: amount.maximum } }
        : {}),
      tokens: null,
      accepted: reference.estimate.acceptedTaskCount,
      terminal: null,
    })
  }
  return facts
}

/** Median tokens per accepted task by category across our observed configurations. */
export function referenceTokenProfile(graph: Graph | undefined) {
  return tokenProfile(
    (graph?.referenceEstimates ?? []).map((item) => {
      const categories = item.estimate.coverage.categories
      return {
        accepted: item.estimate.acceptedTaskCount,
        tokens: {
          uncachedInput: categories.uncachedInput.tokens,
          cacheRead: categories.cacheRead.tokens,
          cacheWrite: categories.cacheWrite.tokens,
          output: categories.output.tokens,
          reasoning: categories.reasoning.tokens,
        },
      }
    }),
  )
}

type RouteRef = { providerID: string; id: string }
/** The parts of the saved settings that name routes (`ModelSettingsOutput`). */
export type RoutedSettings = {
  agents?: ReadonlyArray<{ model: RouteRef | null }>
  personas?: ReadonlyArray<{
    resolution: { route?: RouteRef | null | undefined }
    layers: {
      task?: { route?: RouteRef | null | undefined } | null | undefined
      project?: { route?: RouteRef | null | undefined } | null | undefined
      shared?: { route?: RouteRef | null | undefined } | null | undefined
    }
  }>
}

/** Routes named by the model router: each agent's model, every persona's resolved and layer route. */
export function routedModels(settings: RoutedSettings | undefined): BenchmarkRoute[] {
  return [
    ...(settings?.agents ?? []).flatMap((agent) =>
      agent.model ? [{ providerID: agent.model.providerID, modelID: agent.model.id }] : [],
    ),
    ...(settings?.personas ?? []).flatMap((persona) =>
      [
        persona.resolution.route,
        persona.layers.task?.route,
        persona.layers.project?.route,
        persona.layers.shared?.route,
      ].flatMap((route) => (route ? [{ providerID: route.providerID, modelID: route.id }] : [])),
    ),
  ]
}

export type CatalogSetInput = {
  candidates: readonly ModelCandidate[]
  catalog: CatalogNames
  overview: ModelDecisionOverview | undefined
  priceSources: readonly ModelPriceSource[]
  sourceDates: BenchmarkSourceDates
  routed: readonly BenchmarkRoute[]
  preferredBasis: string | null
  external: readonly PublicCatalogItem[]
}

type DisplayRoute = { providerID: string; modelID: string; variant?: string | null }

/**
 * `modelDisplayLabel` over one fixed route list, with the names computed once per model. The plain
 * call recomputes every route's name against every candidate for each label (cubic in the
 * catalog: 5.9 s for 368 labels over 1,466 candidates, measured 2026-11-21); this gives the same
 * label (the name, plus the route when another listed route shares the name) in linear time.
 */
export function modelDisplayLabeler(
  routes: readonly DisplayRoute[],
  candidates: readonly ModelCandidate[],
  catalog: CatalogNames,
) {
  const names = new Map<string, string>()
  const nameOf = (route: DisplayRoute) => {
    const key = `${route.providerID}\u0000${route.modelID}`
    let name = names.get(key)
    if (name === undefined) {
      name = modelDisplayName(route, candidates, catalog)
      names.set(key, name)
    }
    return name
  }
  const routesByName = new Map<string, Set<string>>()
  for (const route of routes) {
    const name = nameOf(route)
    const set = routesByName.get(name) ?? new Set<string>()
    set.add(`${route.providerID}\u0000${route.modelID}\u0000${route.variant ?? ""}`)
    routesByName.set(name, set)
  }
  return (route: DisplayRoute) => {
    const name = nameOf(route)
    return (routesByName.get(name)?.size ?? 0) < 2 ? name : `${name} · ${routeLabel(route)}`
  }
}

/** The ranked catalog of the panel's "All models" table and projected chart. */
export function catalogFor(input: CatalogSetInput) {
  const references = input.overview
    ? chartReferences(input.overview.graph, input.candidates, input.catalog)
    : []
  const points = input.overview
    ? chartPoints(input.overview, references, input.candidates, input.catalog)
    : []
  const label = modelDisplayLabeler(
    input.candidates.map((candidate) => ({ ...candidate.identity, variant: null })),
    input.candidates,
    input.catalog,
  )
  return buildCatalog({
    candidates: input.candidates,
    priceSources: input.priceSources,
    sourceDates: input.sourceDates,
    profile: referenceTokenProfile(input.overview?.graph),
    observed: observedFactsByRoute(points, references),
    routed: input.routed,
    preferredBasis: input.preferredBasis,
    external: input.external,
    label: (route) => label({ ...route, variant: null }),
  })
}
