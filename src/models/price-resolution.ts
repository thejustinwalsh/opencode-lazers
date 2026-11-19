import type { BenchmarkPrice, BenchmarkSourceDates } from "./benchmark-baseline.ts"
import type { PublicCatalogItem } from "./comparison-schema.ts"
import type { ModelCandidate } from "./comparison-state.ts"
import type { ModelPriceSource } from "./price-source-settings.ts"

/**
 * The one price walk. Wherever the Models panel prices a model (reference estimates aside, which
 * reprice observed usage elsewhere), it gathers what each source quotes for that model identity
 * and calls `resolvePrice`: the FIRST source in the configured order that quotes it supplies the
 * price, and the quote carries its source and snapshot time as provenance. A source that has no
 * quote is skipped, never a reason to drop the model; a model is unpriced only when no
 * configured source quotes it.
 *
 * What counts as a source's quote (the guards) is decided where the quotes are gathered: never
 * another tier's or major version's price (name identity), and a reseller's copy only when it is
 * that source's only listing (`public-join.ts`).
 */
/**
 * One chart axis needs one price: an explicit 3 input : 1 output token mix (the benchmark
 * publisher's convention). Input and output rates stay separate in detail.
 */
export const BENCHMARK_PRICE_MIX = { input: 3, output: 1 } as const

export type PriceQuote = {
  source: ModelPriceSource
  /** USD per 1M tokens. */
  input: number
  output: number
  cacheRead: number | null
  cacheWrite: number | null
  /** Context or prompt size above which this base rate no longer applies. */
  appliesBelowTokens?: number | null
}

const finiteDecimal = (value: string | null) => {
  if (value === null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function blend(input: number, output: number) {
  const { input: inputShare, output: outputShare } = BENCHMARK_PRICE_MIX
  return (input * inputShare + output * outputShare) / (inputShare + outputShare)
}

const dateFor = (source: ModelPriceSource, dates: BenchmarkSourceDates) =>
  (source === "openrouter"
    ? dates.openrouter
    : source === "opencode"
      ? dates.opencode
      : dates.modelsDev) ?? null

/** First configured source that quotes the model; its provenance rides with the price. */
export function resolvePrice(
  quotes: readonly PriceQuote[],
  order: readonly ModelPriceSource[],
  dates: BenchmarkSourceDates,
): BenchmarkPrice | null {
  for (const source of order) {
    const quote = quotes.find((candidate) => candidate.source === source)
    if (!quote) continue
    return {
      source,
      input: quote.input,
      output: quote.output,
      cacheRead: quote.cacheRead,
      cacheWrite: quote.cacheWrite,
      blended: blend(quote.input, quote.output),
      appliesBelowTokens: quote.appliesBelowTokens ?? null,
      retrievedAt: dateFor(source, dates),
    }
  }
  return null
}

/** What each source quotes for a native route: its own catalog, OpenRouter's and models.dev's. */
export function candidateQuotes(candidate: ModelCandidate): PriceQuote[] {
  const quotes: PriceQuote[] = []
  // OpenRouter: the exact catalog match when the route has one, else the identity join.
  const tiers = candidate.externalModel?.prices?.tiers ?? []
  const base =
    candidate.correspondence.status === "exact"
      ? tiers.find(
          (tier) =>
            tier.minPromptTokens === null &&
            (tier.utcStart ?? null) === null &&
            (tier.utcEnd ?? null) === null,
        )
      : undefined
  const prompt = finiteDecimal(base?.prompt ?? null)
  const completion = finiteDecimal(base?.completion ?? null)
  if (base && prompt !== null && completion !== null) {
    const thresholds = tiers.flatMap((tier) => (tier.minPromptTokens ? [tier.minPromptTokens] : []))
    const perMillion = (value: number | null) => (value === null ? null : value * 1_000_000)
    quotes.push({
      source: "openrouter",
      input: prompt * 1_000_000,
      output: completion * 1_000_000,
      cacheRead: perMillion(finiteDecimal(base.inputCacheRead)),
      cacheWrite: perMillion(finiteDecimal(base.inputCacheWrite)),
      appliesBelowTokens: thresholds.length ? Math.min(...thresholds) : null,
    })
  }
  // OpenCode's own catalog: the tier with no context threshold.
  const native = candidate.native.prices?.tiers ?? []
  const nativeBase = native.find((tier) => tier.contextTierTokens === null)
  if (nativeBase && nativeBase.input !== null && nativeBase.output !== null) {
    const thresholds = native.flatMap((tier) =>
      tier.contextTierTokens ? [tier.contextTierTokens] : [],
    )
    quotes.push({
      source: "opencode",
      input: nativeBase.input,
      output: nativeBase.output,
      cacheRead: nativeBase.cacheRead,
      cacheWrite: nativeBase.cacheWrite,
      appliesBelowTokens: thresholds.length ? Math.min(...thresholds) : null,
    })
  }
  // models.dev, then whatever the server joined by name identity (a source that lists the
  // model under another spelling or provider).
  const dev = candidate.publicModel?.prices
  if (dev && dev.input !== null && dev.output !== null)
    quotes.push({
      source: "models-dev",
      input: dev.input,
      output: dev.output,
      cacheRead: dev.cacheRead,
      cacheWrite: dev.cacheWrite,
    })
  for (const quote of candidate.publicQuotes ?? [])
    if (!quotes.some((existing) => existing.source === quote.source)) quotes.push(quote)
  return quotes
}

/** The quotes of a public-catalog model: every source that lists it, then its own listing. */
export function externalQuotes(item: PublicCatalogItem): PriceQuote[] {
  const quotes: PriceQuote[] = [...(item.quotes ?? [])]
  if (item.prices && !quotes.some((quote) => quote.source === item.source))
    quotes.push({ source: item.source, ...item.prices })
  return quotes
}

/** A native route's price by the ordered sources. */
export const priceCandidate = (
  candidate: ModelCandidate,
  order: readonly ModelPriceSource[],
  dates: BenchmarkSourceDates,
) => resolvePrice(candidateQuotes(candidate), order, dates)

/** A public-catalog model's price by the ordered sources. */
export const priceExternal = (
  item: PublicCatalogItem,
  order: readonly ModelPriceSource[],
  dates: BenchmarkSourceDates,
) => resolvePrice(externalQuotes(item), order, dates)
