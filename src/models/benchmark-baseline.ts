import type { ModelCandidate } from "./comparison-state.ts"
import type { ModelPriceSource } from "./price-source-settings.ts"
import { mergeRoutesByIdentity, representativeOf, routeIdentityKey } from "./model-groups.ts"
import type { PublicCatalogItem } from "./comparison-schema.ts"
import { priceCandidate, priceExternal } from "./price-resolution.ts"
import { AA_BASIS, chooseScoreBasis, scoreOn } from "./public-score.ts"
import type { ScoreBasis } from "./public-score.ts"

/**
 * Public benchmark baseline: one point per native route whose OpenRouter catalog
 * entry matches exactly one Artificial Analysis benchmark row. Units differ from
 * observed cost per task, so this never shares a chart or frontier with it.
 *
 * Price is a per-token list price, never a task cost. The single chart axis uses
 * an explicit 3 input : 1 output token mix (the benchmark publisher's convention);
 * input and output rates stay separate in detail.
 */
export { BENCHMARK_PRICE_MIX } from "./price-resolution.ts"

export type BenchmarkRoute = { providerID: string; modelID: string }

export type BenchmarkPrice = {
  source: ModelPriceSource
  /** USD per 1M tokens. */
  input: number
  output: number
  cacheRead: number | null
  cacheWrite: number | null
  /** USD per 1M tokens at BENCHMARK_PRICE_MIX. */
  blended: number
  /** Context or prompt size above which this base rate no longer applies. */
  appliesBelowTokens: number | null
  retrievedAt: string | null
}

export type BenchmarkScores = {
  /** What the score is called; the Coding Index unless an Epoch benchmark ranks the set. */
  scoreName?: string
  /** Where the score is from, with attribution; the Artificial Analysis line when absent. */
  scoreCaption?: string
  displayName: string | null
  modelPermaslug: string
  codingIndex: number | null
  agenticIndex: number | null
  intelligenceIndex: number | null
}

export type BenchmarkBaselinePoint = {
  /** Representative candidateID used for selection; one point per route. */
  id: string
  route: BenchmarkRoute
  label: string
  benchmark: BenchmarkScores & { codingIndex: number }
  price: BenchmarkPrice
  /** The route has observed task outcomes under the current filters. */
  observed: boolean
}

export type BenchmarkBaselineGap = {
  id: string
  route: BenchmarkRoute
  label: string
  benchmark: BenchmarkScores
  price: BenchmarkPrice | null
  reason: "no-price" | "no-coding-index"
}

export type BenchmarkBaseline = {
  points: BenchmarkBaselinePoint[]
  /** Routes with a matched benchmark that cannot be plotted, with the reason. */
  gaps: BenchmarkBaselineGap[]
  /** Loaded catalog routes with no single matched benchmark row. */
  unmatchedRoutes: number
  /** Loaded catalog routes whose benchmark match is ambiguous (several rows). */
  ambiguousRoutes: number
  priceSources: ModelPriceSource[]
  /** Which public score the points carry: the Coding Index, or one Epoch benchmark. */
  scoreBasis: ScoreBasis
}

export type BenchmarkSourceDates = {
  openrouter: string | null
  opencode: string | null
  modelsDev?: string | null
}

export function routeKey(route: BenchmarkRoute) {
  return `${route.providerID}\u0000${route.modelID}`
}

/** A native route's price by the ordered sources: the one walk in `price-resolution.ts`. */
export function benchmarkPrice(
  candidate: ModelCandidate,
  order: readonly ModelPriceSource[],
  dates: BenchmarkSourceDates,
): BenchmarkPrice | null {
  return priceCandidate(candidate, order, dates)
}

export function benchmarkBaseline(input: {
  candidates: readonly ModelCandidate[]
  priceSources: readonly ModelPriceSource[]
  sourceDates: BenchmarkSourceDates
  observedRoutes: ReadonlySet<string>
  /** The score basis the user picked, when any. */
  preferredBasis?: string | null
  /** Public-catalog models no route runs: plotted when scored and priced, like any route. */
  external?: readonly PublicCatalogItem[]
  label: (route: BenchmarkRoute, candidate: ModelCandidate) => string
}): BenchmarkBaseline {
  // One model is one point, whatever providers offer it.
  const { groups: routes, siblings } = mergeRoutesByIdentity(input.candidates)
  const points: BenchmarkBaselinePoint[] = []
  const gaps: BenchmarkBaselineGap[] = []
  let unmatchedRoutes = 0
  let ambiguousRoutes = 0
  const { basis } = chooseScoreBasis(input.candidates, input.preferredBasis, input.external)
  for (const [key, group] of routes) {
    // The benchmark and catalog price describe the model, so every effort of a
    // route shares them; prefer the effort-less configuration as the handle.
    const chosen = representativeOf(group)
    const reps = [chosen, ...(siblings.get(key) ?? []).map(representativeOf)]
    // The chosen provider speaks for the model; a sibling's score or quote stands in when it has
    // none, so a model is left out only when no route and no source carries it.
    const representative = reps.find((rep) => scoreOn(rep, basis) !== null) ?? chosen
    const resolved = () =>
      reps
        .map((rep) => benchmarkPrice(rep, input.priceSources, input.sourceDates))
        .find((price) => price !== null) ?? null
    if (basis.source === "epoch") {
      const score = scoreOn(representative, basis)
      const price = resolved()
      if (!score) {
        unmatchedRoutes++
        continue
      }
      const route = {
        providerID: representative.identity.providerID,
        modelID: representative.identity.modelID,
      }
      const scores: BenchmarkScores = {
        scoreName: basis.label,
        scoreCaption: basis.caption,
        displayName: score.displayName,
        modelPermaslug: score.permaslug,
        codingIndex: score.value,
        agenticIndex: null,
        intelligenceIndex: null,
      }
      const label = input.label(route, representative)
      if (!price) {
        gaps.push({
          id: representative.candidateID,
          route,
          label,
          benchmark: scores,
          price,
          reason: "no-price",
        })
        continue
      }
      points.push({
        id: representative.candidateID,
        route,
        label,
        benchmark: { ...scores, codingIndex: score.value },
        price,
        observed: input.observedRoutes.has(key),
      })
      continue
    }
    const benchmark = representative.externalBenchmark
    if (representative.benchmarkCorrespondence.status === "ambiguous") ambiguousRoutes++
    if (representative.benchmarkCorrespondence.status !== "exact" || !benchmark) {
      unmatchedRoutes++
      continue
    }
    const route = {
      providerID: representative.identity.providerID,
      modelID: representative.identity.modelID,
    }
    const scores: BenchmarkScores = {
      displayName: benchmark.displayName,
      modelPermaslug: benchmark.modelPermaslug,
      codingIndex: benchmark.codingIndex,
      agenticIndex: benchmark.agenticIndex,
      intelligenceIndex: benchmark.intelligenceIndex,
    }
    const price = resolved()
    const label = input.label(route, representative)
    if (scores.codingIndex === null || !price) {
      gaps.push({
        id: representative.candidateID,
        route,
        label,
        benchmark: scores,
        price,
        reason: scores.codingIndex === null ? "no-coding-index" : "no-price",
      })
      continue
    }
    points.push({
      id: representative.candidateID,
      route,
      label,
      benchmark: { ...scores, codingIndex: scores.codingIndex },
      price,
      observed: input.observedRoutes.has(key),
    })
  }
  // Public-catalog models: scored on the basis and priced by the one walk.
  const seen = new Set([...routes.keys()])
  const loadedModels = new Set(
    [...routes.values()].map((group) => routeIdentityKey(group[0]!.identity)),
  )
  for (const item of input.external ?? []) {
    if (basis.source !== "epoch") break
    const route = { providerID: item.providerID, modelID: item.modelID }
    const key = routeKey(route)
    if (seen.has(key) || loadedModels.has(routeIdentityKey(route))) continue
    const rows = item.benchmarks.filter((row) => row.benchmarkID === basis.benchmarkID)
    if (!rows.length) continue
    seen.add(key)
    const best = rows.reduce((top, row) => (row.score > top.score ? row : top))
    const scores: BenchmarkScores = {
      scoreName: basis.label,
      scoreCaption: basis.caption,
      displayName: best.modelVersion,
      modelPermaslug: best.modelVersion,
      codingIndex: Math.round(best.score * 1000) / 10,
      agenticIndex: null,
      intelligenceIndex: null,
    }
    const price = priceExternal(item, input.priceSources, input.sourceDates)
    const label = item.name ?? item.modelID
    if (!price) {
      gaps.push({ id: key, route, label, benchmark: scores, price: null, reason: "no-price" })
      continue
    }
    points.push({
      id: key,
      route,
      label,
      benchmark: { ...scores, codingIndex: scores.codingIndex! },
      price,
      observed: input.observedRoutes.has(key),
    })
  }
  return {
    points: points.toSorted(
      (left, right) =>
        left.price.blended - right.price.blended ||
        right.benchmark.codingIndex - left.benchmark.codingIndex,
    ),
    gaps,
    unmatchedRoutes,
    ambiguousRoutes,
    priceSources: [...input.priceSources],
    scoreBasis: basis,
  }
}
