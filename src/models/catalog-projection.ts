import { BENCHMARK_PRICE_MIX, benchmarkPrice, routeKey } from "./benchmark-baseline.ts"
import type { PublicCatalogItem } from "./comparison-schema.ts"
import type { BenchmarkPrice, BenchmarkRoute, BenchmarkSourceDates } from "./benchmark-baseline.ts"
import { paretoFrontier } from "./chart-layout.ts"
import type { ModelCandidate } from "./comparison-state.ts"
import type { ModelPriceSource } from "./price-source-settings.ts"
import { createModelIndex, parseModelName, vendorSlug } from "./name-identity.ts"
import { chooseScoreBasis, scoreOn } from "./public-score.ts"
import type { ScoreBasis } from "./public-score.ts"

/**
 * The model set behind "Projected" and the ranked table: a best-effort union, each entry tagged
 * with where it came from.
 *
 *   Observed  recorded runs of ours: measured cost, tokens and acceptance.
 *   Routed    named by the model router: a persona or layer route.
 *   Catalog   the configured price sources: the top `CATALOG_TOP` by public coding index, plus
 *             the current Anthropic and OpenAI lineups (BYOK).
 *
 * Nothing here is a hard-coded model list or price. A source that is unavailable contributes
 * nothing and is named, not guessed. Unobserved models are projected: their list prices times
 * the token profile of our accepted tasks.
 */
export const CATALOG_TOP = 30
/** Without public scores, how many priced models are taken in the source's own order. */
export const CATALOG_SOURCE_TOP = 40
/** BYOK providers whose lineups are always included, newest by coding index first. */
export const BYOK_PROVIDERS = ["anthropic", "openai"] as const
export const BYOK_PER_PROVIDER = 12

export type SourceTag = "observed" | "routed" | "catalog"
export const sourceTagLabel: Record<SourceTag, string> = {
  observed: "Observed",
  routed: "Routed",
  catalog: "Catalog",
}

/** Median tokens per accepted task, by pricing category. */
export type TokenProfile = {
  uncachedInput: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
  /** Observed configurations the medians come from. */
  configurations: number
  /** Accepted tasks across them. */
  acceptedTasks: number
}

type CategoryTokens = Record<
  "uncachedInput" | "cacheRead" | "cacheWrite" | "output" | "reasoning",
  number | null
>

const categories = ["uncachedInput", "cacheRead", "cacheWrite", "output", "reasoning"] as const

function median(values: readonly number[]) {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/**
 * The token profile of our accepted tasks: for each observed configuration, its recorded tokens
 * per category divided by its accepted tasks; then the median across configurations, per
 * category. Configurations with no accepted task or no recorded tokens do not count.
 */
export function tokenProfile(
  observed: ReadonlyArray<{ accepted: number; tokens: CategoryTokens }>,
): TokenProfile | undefined {
  const usable = observed.filter((entry) => entry.accepted > 0)
  const perCategory = Object.fromEntries(
    categories.map((category) => [
      category,
      usable.flatMap((entry) => {
        const tokens = entry.tokens[category]
        return tokens === null ? [] : [tokens / entry.accepted]
      }),
    ]),
  ) as Record<(typeof categories)[number], number[]>
  if (!categories.some((category) => perCategory[category].length)) return undefined
  const pick = (category: (typeof categories)[number]) =>
    perCategory[category].length ? median(perCategory[category]) : 0
  return {
    uncachedInput: pick("uncachedInput"),
    cacheRead: pick("cacheRead"),
    cacheWrite: pick("cacheWrite"),
    output: pick("output"),
    reasoning: pick("reasoning"),
    configurations: usable.length,
    acceptedTasks: usable.reduce((sum, entry) => sum + entry.accepted, 0),
  }
}

export type Projection = {
  /** USD per accepted task. */
  usd: number
  /** A cache rate was missing and priced at the input rate; shown in the basis. */
  cacheAtInputRate: boolean
}

/** List prices (USD per 1M tokens) times the token profile. Reasoning tokens bill as output. */
export function projectCost(profile: TokenProfile, price: BenchmarkPrice): Projection {
  const perMillion = 1_000_000
  const cacheReadRate = price.cacheRead ?? price.input
  const cacheWriteRate = price.cacheWrite ?? price.input
  const cacheAtInputRate =
    (price.cacheRead === null && profile.cacheRead > 0) ||
    (price.cacheWrite === null && profile.cacheWrite > 0)
  const usd =
    (profile.uncachedInput * price.input +
      profile.cacheRead * cacheReadRate +
      profile.cacheWrite * cacheWriteRate +
      (profile.output + profile.reasoning) * price.output) /
    perMillion
  return { usd, cacheAtInputRate }
}

export type ObservedFacts = {
  /** The configuration these facts belong to; a table row selects it. */
  configurationID: string
  /** USD per accepted task: a range when the estimate is one. */
  usd: number
  range?: { minimum: number; maximum: number }
  /** Null for a model with a price but no token measurement: listed, not plotted. */
  tokens: number | null
  accepted: number
  terminal: number | null
}

export type CatalogEntry = {
  /** Selection handle: the representative candidate id, else the route key. */
  id: string
  route: BenchmarkRoute
  label: string
  tags: SourceTag[]
  price: BenchmarkPrice | null
  /** Projected from list prices; absent without a price or a token profile. */
  projection: Projection | null
  /** The public score on the set's basis, when a benchmark row matches. */
  score: number | null
  /** For a public-catalog model no route runs: the source that listed it (not the price source). */
  listedBy?: ModelPriceSource
  /** Providers that offer this model, when more than one does; the entry stands for all. */
  providers?: string[]
  /** What `score` is called (the Coding index, or an Epoch benchmark in percent). */
  scoreName?: string
  /** Context window in tokens, when the catalog lists one. */
  contextTokens: number | null
  observed: ObservedFacts | null
  /** On the projected best trade-off: cost lower, score higher. */
  frontier: boolean
}

export type CatalogInput = {
  candidates: readonly ModelCandidate[]
  priceSources: readonly ModelPriceSource[]
  sourceDates: BenchmarkSourceDates
  profile: TokenProfile | undefined
  /** Observed facts by route key (provider and model, any effort). */
  observed: ReadonlyMap<string, ObservedFacts>
  /** Routes named by the model router. */
  routed: ReadonlyArray<BenchmarkRoute>
  /** The score basis the user picked (`aa` or an Epoch benchmark id), when any. */
  preferredBasis?: string | null
  /** Public-catalog models no route of this install runs: listed and priced, not routable. */
  external?: ReadonlyArray<PublicCatalogItem>
  label: (route: BenchmarkRoute, candidate: ModelCandidate | undefined) => string
}

/** The BYOK provider a route belongs to, from the native provider or the OpenRouter slug. */
const byokProvider = (route: BenchmarkRoute, candidate: ModelCandidate) => {
  const slug = candidate.externalModel?.id ?? route.modelID
  return BYOK_PROVIDERS.find(
    (provider) => route.providerID === provider || slug.startsWith(`${provider}/`),
  )
}

/**
 * Union by route (provider and model; efforts are one entry), dedup, tagging and ranking.
 * Tags accumulate: a model can be Observed, Routed and Catalog at once. The price is the first
 * available in the configured source order, with its source and date kept.
 */
export function buildCatalogSet(input: CatalogInput): CatalogEntry[] {
  return buildCatalog(input).entries
}

/** How the set was chosen, for the "Estimate basis and prices" disclosure. */
export type CatalogSummary = {
  /** Models taken by the primary ordering. */
  primary: number
  /** What the primary ordering was: the public coding index, or a source's own listing order. */
  ordering: string
  anthropic: number
  openai: number
  routed: number
  /** Models of the public catalogs beyond this install's routes (Anthropic, OpenAI, newest). */
  external: number
  /** Where the ordering came from, when it was a source's listing. */
  orderSource: ModelPriceSource | null
  /** The public score that ranks the set, and how many loaded models it reaches. */
  scoreBasis: ScoreBasis
  scored: number
}

/** Text and tools: a model is excluded only when its source says it lacks one of them. */
function textAndTools(candidate: ModelCandidate) {
  const external = candidate.externalModel
  const native = candidate.native.capabilities
  const tools = external?.supportedParameters
    ? external.supportedParameters.includes("tools")
    : (native?.tools ?? null)
  const outputs = external?.architecture?.outputModalities ?? native?.output ?? null
  const inputs = external?.architecture?.inputModalities ?? native?.input ?? null
  return (
    tools !== false &&
    (!outputs || outputs.includes("text")) &&
    (!inputs || inputs.includes("text"))
  )
}

/** Room between one source's positions and the next, so a source rank always dominates. */
const SOURCE_STRIDE = 1e15

/**
 * Where the first configured source that lists the model puts it; later is larger. A source
 * earlier in the order always sorts before a later one. models.dev has no list order of its
 * own, so it orders by release date, newest first.
 */
function listingOrder(candidate: ModelCandidate, sources: readonly ModelPriceSource[]) {
  for (const [rank, source] of sources.entries()) {
    if (source === "models-dev") {
      const released = Date.parse(candidate.publicModel?.releaseDate ?? "")
      if (Number.isFinite(released)) return rank * SOURCE_STRIDE + (4e12 - released)
      continue
    }
    const references =
      source === "openrouter"
        ? candidate.externalModelEvidence.records
        : candidate.native.evidence.records
    const wanted = source === "openrouter" ? "openrouter-models" : "native-catalog"
    const found = references.find((reference) => reference.source === wanted)
    if (found) return rank * SOURCE_STRIDE + found.recordIndex
  }
  return Number.POSITIVE_INFINITY
}

export function buildCatalog(input: CatalogInput): {
  entries: CatalogEntry[]
  summary: CatalogSummary
} {
  const routeGroups = new Map<string, ModelCandidate[]>()
  for (const candidate of input.candidates) {
    const key = routeKey(candidate.identity)
    routeGroups.set(key, [...(routeGroups.get(key) ?? []), candidate])
  }
  // One model is one entry, whoever offers it and under whatever alias: a dated snapshot and
  // its `latest` alias (`claude-opus-4-5-20251101`, `claude-opus-4-5`), and the same model through
  // several providers (`anthropic`, `github-copilot`). The vendor's own provider speaks for it,
  // then the undated alias, then the newest; the others are listed as the providers offering it.
  const sameModel = new Map<string, Array<{ key: string; id: string; provider: string }>>()
  for (const [key, group] of routeGroups) {
    const { providerID, modelID } = group[0]!.identity
    const identity = parseModelName(modelID, {
      vendor: vendorSlug(providerID) ? providerID : null,
    })
    sameModel.set(identity.key, [
      ...(sameModel.get(identity.key) ?? []),
      { key, id: modelID, provider: providerID },
    ])
  }
  const aliasOf = new Map<string, string>()
  const groups = new Map<string, ModelCandidate[]>()
  const providersOf = new Map<string, string[]>()
  for (const members of sameModel.values()) {
    const chosen = members.toSorted((a, b) => {
      const firstParty = (member: { provider: string }) =>
        vendorSlug(member.provider) === member.provider ? 0 : 1
      const left = parseModelName(a.id).date
      const right = parseModelName(b.id).date
      return (
        firstParty(a) - firstParty(b) ||
        Number(left !== null) - Number(right !== null) ||
        (right ?? "").localeCompare(left ?? "") ||
        a.id.length - b.id.length ||
        a.key.localeCompare(b.key)
      )
    })[0]!
    groups.set(chosen.key, routeGroups.get(chosen.key)!)
    providersOf.set(chosen.key, [...new Set(members.map((member) => member.provider))].sort())
    for (const member of members) aliasOf.set(member.key, chosen.key)
  }
  type Base = {
    key: string
    route: BenchmarkRoute
    representative: ModelCandidate | undefined
    price: BenchmarkPrice | null
    score: number | null
    order: number
  }
  const bases = new Map<string, Base>()
  const choice = chooseScoreBasis(input.candidates, input.preferredBasis)
  for (const [key, group] of groups) {
    const representative = group.find((entry) => entry.identity.variant === null) ?? group[0]!
    const exactScore = scoreOn(representative, choice.basis)?.value ?? null
    bases.set(key, {
      key,
      route: {
        providerID: representative.identity.providerID,
        modelID: representative.identity.modelID,
      },
      representative,
      price: benchmarkPrice(representative, input.priceSources, input.sourceDates),
      score: exactScore,
      order: listingOrder(representative, input.priceSources),
    })
  }
  const priced = [...bases.values()].filter(
    (base) => base.price && textAndTools(base.representative!),
  )
  // Primary: the top models by public coding index; when scores cover fewer than that (a
  // install without benchmark access has none), the first priced models in the configured
  // source's own listing order, up to CATALOG_SOURCE_TOP.
  const scored = priced
    .filter((base) => base.score !== null)
    .toSorted((a, b) => b.score! - a.score!)
  const primary = new Set<string>()
  let ordering = "public score"
  let orderSource: ModelPriceSource | null = null
  if (scored.length >= CATALOG_TOP)
    for (const base of scored.slice(0, CATALOG_TOP)) primary.add(base.key)
  else {
    for (const base of scored) primary.add(base.key)
    // The first source that actually lists a priced model gives the order.
    orderSource =
      input.priceSources.find((source) =>
        priced.some((base) => {
          const order = base.order
          return (
            Number.isFinite(order) &&
            Math.floor(order / SOURCE_STRIDE) === input.priceSources.indexOf(source)
          )
        }),
      ) ??
      input.priceSources[0] ??
      null
    const orderText = orderSource === "models-dev" ? "release date, newest first" : "listing order"
    ordering = scored.length
      ? `public score, then ${orderText}`
      : `${orderSource ? sourceKeyLabel[orderSource] : "source"} ${orderText}`
    for (const base of priced
      .filter((entry) => !primary.has(entry.key))
      .toSorted((a, b) => a.order - b.order)
      .slice(0, Math.max(0, CATALOG_SOURCE_TOP - primary.size)))
      primary.add(base.key)
  }
  const catalogKeys = new Set(primary)
  const byok = { anthropic: 0, openai: 0 }
  for (const provider of BYOK_PROVIDERS)
    for (const base of priced
      .filter((entry) => byokProvider(entry.route, entry.representative!) === provider)
      .toSorted((a, b) => (b.score ?? -1) - (a.score ?? -1))
      .slice(0, BYOK_PER_PROVIDER)) {
      if (!catalogKeys.has(base.key)) byok[provider]++
      catalogKeys.add(base.key)
    }

  // Our own runs and routes name models in their own spelling (`opencode-go/kimi-k3.1-pro`);
  // they join the catalog's entry for the same model, by name identity, rather than sitting alone.
  const catalogIndex = createModelIndex(
    [...bases.values()].map((base) => {
      const candidate = base.representative
      return {
        id: base.route.modelID,
        names: [
          candidate?.native.name,
          candidate?.externalModel?.id,
          candidate?.externalModel?.canonicalSlug,
          candidate?.externalModel?.name,
          candidate?.publicModel?.name,
        ].filter((name): name is string => Boolean(name)),
        vendor: vendorSlug(base.route.providerID) ? base.route.providerID : null,
        value: base.key,
      }
    }),
  )
  const joinedKey = (route: BenchmarkRoute) => {
    const own = routeKey(route)
    const key = aliasOf.get(own) ?? own
    if (bases.has(key)) return key
    const result = catalogIndex.resolve(route.modelID, {
      vendor: vendorSlug(route.providerID) ? route.providerID : null,
    })
    if (result.status !== "matched") return key
    const keys = new Set(result.items.map((item) => item.value))
    return keys.size === 1 ? [...keys][0]! : key
  }
  const observedFacts = new Map<string, ObservedFacts>()
  for (const [key, facts] of input.observed) {
    const [providerID, modelID] = key.split("\u0000") as [string, string]
    const target = joinedKey({ providerID, modelID })
    // Efforts and provider copies are one model here; the best-sampled one speaks for it.
    if ((observedFacts.get(target)?.accepted ?? -1) < facts.accepted)
      observedFacts.set(target, facts)
  }
  // The public catalogs' models that no route runs join the set, priced by the source that
  // listed them (when that source is among the configured ones) and scored on the same basis.
  const externals = new Map<
    string,
    { item: PublicCatalogItem; price: BenchmarkPrice; score: number | null }
  >()
  for (const item of input.external ?? []) {
    // Price by the ordered setting, whichever source listed the model: the first configured
    // source that quotes this identity. The listing source's own price is the fallback quote.
    const own = item.prices ? [{ source: item.source, ...item.prices }] : []
    const quotes = [...(item.quotes ?? []), ...own]
    let quote: (typeof quotes)[number] | undefined
    for (const source of input.priceSources) {
      quote = quotes.find((candidate) => candidate.source === source)
      if (quote) break
    }
    if (!quote) continue
    const source = quote.source as ModelPriceSource
    const key = routeKey({ providerID: item.providerID, modelID: item.modelID })
    if (bases.has(key) || externals.has(key)) continue
    const { input: inShare, output: outShare } = BENCHMARK_PRICE_MIX
    const price: BenchmarkPrice = {
      source,
      input: quote.input,
      output: quote.output,
      cacheRead: quote.cacheRead,
      cacheWrite: quote.cacheWrite,
      blended: (quote.input * inShare + quote.output * outShare) / (inShare + outShare),
      appliesBelowTokens: null,
      retrievedAt:
        (source === "models-dev"
          ? input.sourceDates.modelsDev
          : source === "openrouter"
            ? input.sourceDates.openrouter
            : input.sourceDates.opencode) ?? null,
    }
    const rows =
      choice.basis.source === "epoch"
        ? item.benchmarks.filter((row) => row.benchmarkID === choice.basis.benchmarkID)
        : []
    const best = rows.reduce<number | null>(
      (top, row) => (top === null || row.score > top ? row.score : top),
      null,
    )
    externals.set(key, { item, price, score: best === null ? null : Math.round(best * 1000) / 10 })
    catalogKeys.add(key)
  }

  const tags = new Map<string, Set<SourceTag>>()
  const add = (key: string, tag: SourceTag) => tags.set(key, (tags.get(key) ?? new Set()).add(tag))
  for (const key of observedFacts.keys()) add(key, "observed")
  for (const route of input.routed) add(joinedKey(route), "routed")
  for (const key of catalogKeys) add(key, "catalog")

  const entries: CatalogEntry[] = [...tags.entries()].map(([key, set]) => {
    const base = bases.get(key)
    const [providerID, modelID] = key.split("\u0000") as [string, string]
    const route = base?.route ?? { providerID, modelID }
    const observed = observedFacts.get(key) ?? null
    const representative = base?.representative
    const outside = base ? undefined : externals.get(key)
    const price = base?.price ?? outside?.price ?? null
    return {
      id: representative?.candidateID ?? key,
      route,
      label: outside ? (outside.item.name ?? modelID) : input.label(route, representative),
      tags: (["observed", "routed", "catalog"] as const).filter((tag) => set.has(tag)),
      price,
      projection: price && input.profile ? projectCost(input.profile, price) : null,
      score: base?.score ?? outside?.score ?? null,
      scoreName: choice.basis.label,
      ...(outside ? { listedBy: outside.item.source as ModelPriceSource } : {}),
      ...((providersOf.get(key)?.length ?? 0) > 1 ? { providers: providersOf.get(key)! } : {}),
      contextTokens:
        representative?.native.contextTokens ??
        representative?.externalModel?.contextLength ??
        outside?.item.contextTokens ??
        null,
      observed,
      frontier: false,
    }
  })
  const withScores = entries.filter((entry) => entry.projection && entry.score !== null)
  for (const entry of paretoFrontier(withScores, [
    (item) => item.projection!.usd,
    (item) => -item.score!,
  ]))
    entry.frontier = true
  return {
    entries: rankCatalog(entries),
    summary: {
      primary: primary.size,
      ordering,
      anthropic: byok.anthropic,
      openai: byok.openai,
      routed: entries.filter((entry) => entry.tags.includes("routed")).length,
      external: externals.size,
      orderSource,
      scoreBasis: choice.basis,
      scored: scored.length,
    },
  }
}

/** One line for the basis disclosure, e.g. "40 from OpenRouter by listing order · 12 Anthropic…". */
export function catalogSummaryText(summary: CatalogSummary) {
  return [
    `${summary.primary} by ${summary.ordering}`,
    summary.anthropic ? `${summary.anthropic} Anthropic` : "",
    summary.openai ? `${summary.openai} OpenAI` : "",
    summary.routed ? `${summary.routed} routed` : "",
    summary.external ? `${summary.external} more from public catalogs` : "",
  ]
    .filter(Boolean)
    .join(" · ")
}

/** The cost shown for an entry: measured when observed, otherwise projected. */
export const entryCost = (entry: CatalogEntry) =>
  entry.observed?.usd ?? entry.projection?.usd ?? null

/**
 * Ranking for the table: best trade-off first, then by cost per task ascending (measured cost
 * for observed models, projected otherwise). Models with no cost at all come last, by name.
 */
export function rankCatalog(entries: readonly CatalogEntry[]): CatalogEntry[] {
  return entries.toSorted((a, b) => {
    if (a.frontier !== b.frontier) return a.frontier ? -1 : 1
    const left = entryCost(a)
    const right = entryCost(b)
    if (left !== right) {
      if (left === null) return 1
      if (right === null) return -1
      return left - right
    }
    return a.label.localeCompare(b.label)
  })
}

export const sourceKeyLabel: Record<ModelPriceSource, string> = {
  openrouter: "OpenRouter",
  opencode: "OpenCode",
  "models-dev": "models.dev",
}

/**
 * "Catalog · listed by models.dev · priced by OpenRouter · 18 Nov": the tags, which source
 * listed a model no route runs, and the source and time of the price that was taken.
 */
export function entryProvenanceText(entry: CatalogEntry) {
  const when = entry.price?.retrievedAt ? Date.parse(entry.price.retrievedAt) : Number.NaN
  return [
    entry.tags.map((tag) => sourceTagLabel[tag]).join(" · "),
    entry.listedBy ? `listed by ${sourceKeyLabel[entry.listedBy]}` : "",
    entry.price ? `priced by ${sourceKeyLabel[entry.price.source]}` : "",
    Number.isFinite(when)
      ? new Date(when).toLocaleDateString([], { day: "numeric", month: "short" })
      : "",
  ]
    .filter(Boolean)
    .join(" · ")
}
