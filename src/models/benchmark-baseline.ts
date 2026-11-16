import type { ModelCandidate } from "./comparison-state.ts"
import type { ModelPriceSource } from "./price-source-settings.ts"

/**
 * Public benchmark baseline: one point per native route whose OpenRouter catalog
 * entry matches exactly one Artificial Analysis benchmark row. Units differ from
 * observed cost per task, so this never shares a chart or frontier with it.
 *
 * Price is a per-token list price, never a task cost. The single chart axis uses
 * an explicit 3 input : 1 output token mix (the benchmark publisher's convention);
 * input and output rates stay separate in detail.
 */
export const BENCHMARK_PRICE_MIX = { input: 3, output: 1 } as const

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
}

export type BenchmarkSourceDates = {
  openrouter: string | null
  opencode: string | null
}

export function routeKey(route: BenchmarkRoute) {
  return `${route.providerID}\u0000${route.modelID}`
}

function finiteDecimal(value: string | null) {
  if (value === null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function blend(input: number, output: number) {
  const { input: inputShare, output: outputShare } = BENCHMARK_PRICE_MIX
  return (input * inputShare + output * outputShare) / (inputShare + outputShare)
}

/** Unconditional OpenRouter rate: no prompt threshold and no time-of-day schedule. */
function openRouterPrice(candidate: ModelCandidate, retrievedAt: string | null) {
  if (candidate.correspondence.status !== "exact") return null
  const tiers = candidate.externalModel?.prices?.tiers ?? []
  const base = tiers.find(
    (tier) =>
      tier.minPromptTokens === null &&
      (tier.utcStart ?? null) === null &&
      (tier.utcEnd ?? null) === null,
  )
  const input = finiteDecimal(base?.prompt ?? null)
  const output = finiteDecimal(base?.completion ?? null)
  if (!base || input === null || output === null) return null
  const thresholds = tiers.flatMap((tier) => (tier.minPromptTokens ? [tier.minPromptTokens] : []))
  const perMillion = (value: number | null) => (value === null ? null : value * 1_000_000)
  return {
    source: "openrouter" as const,
    input: input * 1_000_000,
    output: output * 1_000_000,
    cacheRead: perMillion(finiteDecimal(base.inputCacheRead)),
    cacheWrite: perMillion(finiteDecimal(base.inputCacheWrite)),
    blended: blend(input, output) * 1_000_000,
    appliesBelowTokens: thresholds.length ? Math.min(...thresholds) : null,
    retrievedAt,
  }
}

/** Unconditional OpenCode catalog rate: the tier with no context threshold. */
function openCodePrice(candidate: ModelCandidate, retrievedAt: string | null) {
  const tiers = candidate.native.prices?.tiers ?? []
  const base = tiers.find((tier) => tier.contextTierTokens === null)
  if (!base || base.input === null || base.output === null) return null
  const thresholds = tiers.flatMap((tier) =>
    tier.contextTierTokens ? [tier.contextTierTokens] : [],
  )
  return {
    source: "opencode" as const,
    input: base.input,
    output: base.output,
    cacheRead: base.cacheRead,
    cacheWrite: base.cacheWrite,
    blended: blend(base.input, base.output),
    appliesBelowTokens: thresholds.length ? Math.min(...thresholds) : null,
    retrievedAt,
  }
}

/** First applicable price in the configured order; unavailable sources are skipped. */
export function benchmarkPrice(
  candidate: ModelCandidate,
  order: readonly ModelPriceSource[],
  dates: BenchmarkSourceDates,
): BenchmarkPrice | null {
  for (const source of order) {
    const price =
      source === "openrouter"
        ? openRouterPrice(candidate, dates.openrouter)
        : openCodePrice(candidate, dates.opencode)
    if (price) return price
  }
  return null
}

export function benchmarkBaseline(input: {
  candidates: readonly ModelCandidate[]
  priceSources: readonly ModelPriceSource[]
  sourceDates: BenchmarkSourceDates
  observedRoutes: ReadonlySet<string>
  label: (route: BenchmarkRoute, candidate: ModelCandidate) => string
}): BenchmarkBaseline {
  const routes = new Map<string, ModelCandidate[]>()
  for (const candidate of input.candidates) {
    const key = routeKey(candidate.identity)
    routes.set(key, [...(routes.get(key) ?? []), candidate])
  }
  const points: BenchmarkBaselinePoint[] = []
  const gaps: BenchmarkBaselineGap[] = []
  let unmatchedRoutes = 0
  let ambiguousRoutes = 0
  for (const [key, group] of routes) {
    // The benchmark and catalog price describe the model, so every effort of a
    // route shares them; prefer the effort-less configuration as the handle.
    const representative =
      group.find((candidate) => candidate.identity.variant === null) ?? group[0]!
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
    const price = benchmarkPrice(representative, input.priceSources, input.sourceDates)
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
  }
}
