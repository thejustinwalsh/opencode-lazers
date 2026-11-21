import type { ModelComparisonPanelData } from "./comparison-state.ts"
import type { ModelDecisionContributor } from "./decision-contract.ts"
import type { ModelDecisionReferenceEstimate } from "./reference-estimate.ts"
import type { BenchmarkPrice, BenchmarkScores, BenchmarkRoute } from "./benchmark-baseline.ts"
import type { ModelSource } from "./comparison-presentation.ts"
import { compactCount, joinSegments, sourceTitle } from "./comparison-presentation.ts"
import { SMALL_SAMPLE_TERMINAL_TASKS } from "./chart-layout.ts"
import { formatNumber } from "./panel-shared.ts"

/**
 * Presentation of the selected-model pane (design/details-panes/spec.md): one headline figure,
 * translated enum values, omitted empties. Pure; the components in `model-pane.tsx` only draw it.
 */

type Inspection = Extract<
  NonNullable<ModelComparisonPanelData["decisionInspection"]>,
  { status: "found" }
>

// --- money -------------------------------------------------------------------------------

const headlineCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const tinyCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumSignificantDigits: 2,
})
const exactCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumSignificantDigits: 4,
})

/** The headline and run-row figure: two decimals; a cent or less keeps two significant digits. */
export function headlineMoney(value: number) {
  return value > 0 && value < 0.01 ? tinyCurrency.format(value) : headlineCurrency.format(value)
}

/** A figure inside a disclosure table: at most four significant digits. */
export function exactMoney(value: number) {
  return exactCurrency.format(value)
}

/** `$2.93`, or `$0.35 – 0.67` for a range of two different figures. */
export function headlineRange(range: { minimum: number; maximum: number }) {
  const low = headlineMoney(range.minimum)
  const high = headlineMoney(range.maximum)
  return low === high ? low : `${low} – ${high.replace(/^\$/, "")}`
}

/** USD per token as a price per 1M tokens (`$2`, `$0.20`), or nothing for a missing or odd rate. */
export function perMillionRate(perToken: string | null | undefined) {
  if (perToken === null || perToken === undefined) return undefined
  const value = Number(perToken)
  if (!Number.isFinite(value) || value < 0) return undefined
  return exactMoney(value * 1_000_000)
}

/** A short date and time, `Nov 19, 8:59 AM`; nothing for a missing or unparsable value. */
function readTime(value: string | null | undefined) {
  if (!value) return undefined
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return undefined
  return parsed.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

// --- translated enums --------------------------------------------------------------------

/** How a price was quoted. Every value the contract allows has a plain-language label or none. */
export const priceSemanticsLabels: Record<
  | "exact-route-quote"
  | "exact-published-route-quotes"
  | "exact-native-model-quote"
  | "exact-native-model-quotes"
  | "observed-endpoint-average"
  | "observed-endpoint-averages"
  | "mixed"
  | "unknown",
  string | undefined
> = {
  "exact-route-quote": "Exact route quote",
  "exact-published-route-quotes": "Exact route quotes",
  "exact-native-model-quote": "OpenCode model quote",
  "exact-native-model-quotes": "OpenCode model quotes",
  "observed-endpoint-average": "Endpoint average",
  "observed-endpoint-averages": "Endpoint averages",
  mixed: "Mixed quotes",
  unknown: undefined,
}

export function priceSemanticsText(semantics: keyof typeof priceSemanticsLabels) {
  return priceSemanticsLabels[semantics]
}

export const priceSourceLabels: Record<
  "openrouter" | "opencode" | "mixed" | "unavailable",
  string | undefined
> = {
  openrouter: "OpenRouter",
  opencode: "OpenCode",
  mixed: "OpenRouter and OpenCode",
  unavailable: undefined,
}

/** What a run contributed: the contract's `contribution`. */
export const outcomeLabels: Record<ModelDecisionContributor["contribution"], string> = {
  accepted: "Accepted",
  failed: "Failed",
  retry: "Retry",
}

const usageKindLabels = {
  uncachedInput: "Input",
  output: "Output",
  reasoning: "Reasoning",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
} as const
type UsageKind = keyof typeof usageKindLabels
const usageKinds = Object.keys(usageKindLabels) as UsageKind[]

export const rateCoverageLabels: Record<
  "complete" | "partial" | "missing" | "not-required" | "unknown",
  string | undefined
> = {
  complete: "Priced",
  partial: "Partly priced",
  missing: "No price",
  "not-required": undefined,
  unknown: undefined,
}

/** The pane's price-coverage placeholder slug (`gpt-5.5_unknown`) is not a model identity. */
export function realSlug(slug: string | null | undefined) {
  if (!slug) return undefined
  return /(^|[_-])unknown$/i.test(slug) ? undefined : slug
}

// --- Your runs ---------------------------------------------------------------------------

export type Headline = { value: string; unit: string; smallSample: boolean }
export type StatItem = { label: string; value?: string }
export type CoverageModel = { priced: number; unpriced: number; caption: string; note?: string }
export type RunRow = {
  task: string
  outcome: string
  tokens?: string
  cost?: string
  contributor: ModelDecisionContributor
}
export type TokenRow = { kind: string; tokens: string; coverage?: string; rate?: string }
export type SourceRow = { name: string; detail?: string; time?: string }
export type IdentifierItem = { label: string; value?: string | null }

export type SelectedFacts = {
  priceRange?: { minimum: number; maximum: number }
  accepted?: number
  terminal?: number
  tokens?: string
  time?: string
  attempts?: string
}

/** A small sample is fewer terminal tasks than the chart's threshold; it labels, never hides. */
function isSmallSample(terminal: number | undefined) {
  return terminal !== undefined && terminal < SMALL_SAMPLE_TERMINAL_TASKS
}

export function runsHeadline(facts: SelectedFacts | undefined): Headline | undefined {
  if (!facts?.priceRange) return undefined
  return {
    value: headlineRange(facts.priceRange),
    unit: "per accepted task",
    smallSample: isSmallSample(facts.terminal),
  }
}

export function runsStats(facts: SelectedFacts | undefined): StatItem[] {
  if (!facts) return []
  return [
    {
      label: "Accepted",
      value:
        facts.accepted !== undefined && facts.terminal !== undefined
          ? `${facts.accepted} of ${facts.terminal}`
          : undefined,
    },
    { label: "Tokens / task", value: facts.tokens },
    { label: "Time / task", value: facts.time },
    { label: "Attempts / task", value: facts.attempts },
  ]
}

const tokenValue = (usage: { tokens: number | null; status: string }) =>
  usage.tokens === null
    ? undefined
    : usage.status === "partial"
      ? `${formatNumber(usage.tokens)} (partial)`
      : formatNumber(usage.tokens)

/** Priced share of measured tokens, and one caption for what is not priced and why. */
export function runsCoverage(
  reference: ModelDecisionReferenceEstimate | undefined,
): CoverageModel | undefined {
  if (!reference) return undefined
  let priced = 0
  let unpriced = 0
  const missing: string[] = []
  const partial: string[] = []
  for (const kind of usageKinds) {
    const usage = reference.coverage.categories[kind]
    if (usage.tokens === null || usage.tokens === 0) continue
    if (usage.rateCoverage === "complete" || usage.rateCoverage === "not-required")
      priced += usage.tokens
    else {
      unpriced += usage.tokens
      const name = usageKindLabels[kind].toLowerCase()
      if (usage.rateCoverage === "partial") partial.push(name)
      else missing.push(name)
    }
  }
  const total = priced + unpriced
  if (total === 0) return undefined
  const share = Math.round((priced / total) * 100)
  const notes = [
    missing.length > 0 &&
      `${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} no published price`,
    partial.length > 0 &&
      `${partial.join(", ")} ${partial.length === 1 ? "is" : "are"} priced in part`,
  ].filter((note): note is string => Boolean(note))
  return {
    priced,
    unpriced,
    caption: `${share === 100 && unpriced > 0 ? "<100" : share}% of tokens priced · OpenRouter catalog`,
    note: notes.length ? notes.join("; ") : undefined,
  }
}

function runRows(contributors: readonly ModelDecisionContributor[]): RunRow[] {
  return contributors.map((contributor) => ({
    task: contributor.taskReference,
    outcome: outcomeLabels[contributor.contribution],
    tokens: contributor.tokens === null ? undefined : compactCount(contributor.tokens),
    cost:
      contributor.currentMarketUSD === null
        ? undefined
        : headlineMoney(contributor.currentMarketUSD),
    contributor,
  }))
}

type UsageSource = {
  coverage: {
    categories: Record<UsageKind, { tokens: number | null; status: string; rateCoverage?: string }>
  }
}

/** The five usage kinds, rate coverage and, with one rate set, the published price per 1M tokens. */
export function tokenRows(
  usage: UsageSource | undefined,
  rates?: ReadonlyArray<{
    prompt: string | null
    completion: string | null
    cacheRead: string | null
    cacheWrite: string | null
  }>,
): TokenRow[] {
  if (!usage) return []
  const rate = rates?.length === 1 ? rates[0] : undefined
  const rateFor: Record<UsageKind, string | null | undefined> = {
    uncachedInput: rate?.prompt,
    output: rate?.completion,
    reasoning: rate?.completion,
    cacheRead: rate?.cacheRead,
    cacheWrite: rate?.cacheWrite,
  }
  return usageKinds.flatMap((kind) => {
    const category = usage.coverage.categories[kind]
    const tokens = category.tokens === 0 ? undefined : tokenValue(category)
    if (tokens === undefined) return []
    const coverage = category.rateCoverage
      ? rateCoverageLabels[category.rateCoverage as keyof typeof rateCoverageLabels]
      : undefined
    return [
      {
        kind: usageKindLabels[kind],
        tokens,
        coverage,
        rate: perMillionRate(rateFor[kind]),
      },
    ]
  })
}

function sourceDetail(source: ModelSource) {
  if (source.snapshot) {
    const failed =
      source.refresh?.state === "failed"
        ? "refresh failed"
        : source.refresh?.state === "refreshing"
          ? "refreshing"
          : undefined
    return joinSegments([`${formatNumber(source.snapshot.recordCount)} records`, failed])
  }
  return source.refresh?.state === "failed" ? "refresh failed" : "no snapshot"
}

/** Snapshot sources as rows: name, record count, read time. */
function snapshotSourceRows(sources: readonly ModelSource[]): SourceRow[] {
  return sources.map((source) => ({
    name: sourceTitle(source.source),
    detail: sourceDetail(source),
    time: readTime(source.snapshot?.retrievedAt),
  }))
}

/** The price pins the estimate was valued with: which source, how it was quoted, when read. */
function priceSourceRows(inspection: Inspection): SourceRow[] {
  return inspection.context.priceIndex.pins.map((pin) => ({
    name: `${priceSourceLabels[pin.source]} prices`,
    detail: joinSegments([
      priceSemanticsText(pin.semantics),
      pin.freshness === "stale" ? "out of date" : undefined,
    ]),
    time: readTime(pin.retrievedAt),
  }))
}

/** At most three short lines that replace the repeated disclaimers. */
function runsCaveats(inspection: Inspection): string[] {
  const lines: string[] = []
  if (inspection.cohort.acceptedTaskCount > 0)
    lines.push("Cost includes failed and retried attempts, divided by accepted tasks.")
  if (
    inspection.nativeReportedCost.totalUSD !== null ||
    inspection.nativeReportedCost.status === "unmetered"
  )
    lines.push("Charges reported by OpenCode are not market prices.")
  const reference = inspection.referenceEstimate
  if (reference?.coverage.attribution.status === "partial")
    lines.push("Some sessions could not be matched to this route.")
  else if (reference && reference.coverage.retries.status !== "complete")
    lines.push("Retry history is incomplete.")
  else if (inspection.context.freshness === "stale") lines.push("Prices are out of date.")
  return lines.slice(0, 3)
}

/** Raw ids, hashes and snapshot ids; the only place they appear. */
function runsIdentifiers(
  inspection: Inspection,
  runs: readonly ModelDecisionContributor[],
): IdentifierItem[] {
  const route = inspection.configuration.route
  const reference = inspection.referenceEstimate
  const price = inspection.configuration.currentPrice
  return [
    { label: "Route", value: `${route.providerID}/${route.modelID}` },
    { label: "Effort", value: route.variant },
    { label: "Configuration", value: inspection.configuration.configurationID },
    { label: "Decision snapshot", value: inspection.context.snapshotID },
    {
      label: "Price policy revision",
      value: String(inspection.context.priceSourcePolicy.revision),
    },
    ...inspection.context.priceIndex.pins.map((pin) => ({
      label: `${priceSourceLabels[pin.source]} price snapshot`,
      value: pin.snapshotID,
    })),
    { label: "Price record", value: price.sourceRecordID },
    { label: "Catalog snapshot", value: reference?.provenance.snapshotID },
    {
      label: "Catalog generation",
      value:
        reference?.provenance.generation === null || reference?.provenance.generation === undefined
          ? undefined
          : String(reference.provenance.generation),
    },
    { label: "Catalog record", value: reference?.provenance.recordID },
    {
      label: "Catalog index",
      value:
        reference?.provenance.recordIndex === null ||
        reference?.provenance.recordIndex === undefined
          ? undefined
          : String(reference.provenance.recordIndex),
    },
    ...runs.flatMap((run) => [
      { label: `${run.taskReference} attempt`, value: run.attemptID },
      { label: `${run.taskReference} session`, value: run.sessionID },
    ]),
  ]
}

// --- Benchmark ---------------------------------------------------------------------------

export function benchmarkHeadline(scores: BenchmarkScores): Headline | undefined {
  if (scores.codingIndex === null) return undefined
  return {
    value: String(scores.codingIndex),
    unit: scores.scoreName ?? "Coding index",
    smallSample: false,
  }
}

export function benchmarkStats(price: BenchmarkPrice | null): StatItem[] {
  if (!price) return []
  const per = (value: number | null) => (value === null ? undefined : exactMoney(value))
  return [
    { label: "Input / 1M", value: per(price.input) },
    { label: "Output / 1M", value: per(price.output) },
    { label: "Cached / 1M", value: per(price.cacheRead) },
  ]
}

/** Secondary indices, present only when the source reports them. */
function benchmarkScoreRows(scores: BenchmarkScores): SourceRow[] {
  return [
    ["Agentic", scores.agenticIndex],
    ["Intelligence", scores.intelligenceIndex],
  ].flatMap(([name, value]) =>
    value === null || value === undefined ? [] : [{ name: String(name), detail: String(value) }],
  )
}

export function benchmarkCaveats(input: {
  price: BenchmarkPrice | null
  mix: { input: number; output: number }
}): string[] {
  return [
    "The score does not state its effort; it describes the model.",
    "A list price is not a task cost; Your runs shows measured cost.",
    input.price
      ? `The chart blends ${input.mix.input} input to ${input.mix.output} output tokens, no cache.`
      : undefined,
  ].filter((line): line is string => Boolean(line))
}

function benchmarkSourceRows(input: {
  citation: string | undefined
  scoreRetrievedAt: string | null | undefined
  price: BenchmarkPrice | null
  priceSourceName: string | undefined
  order: string
  sources: readonly ModelSource[]
}): SourceRow[] {
  return [
    input.citation
      ? { name: input.citation, detail: "score", time: readTime(input.scoreRetrievedAt) }
      : undefined,
    input.price && input.priceSourceName
      ? {
          name: `${input.priceSourceName} list price`,
          detail: undefined,
          time: readTime(input.price.retrievedAt),
        }
      : undefined,
    input.order ? { name: "Price order", detail: input.order } : undefined,
    ...snapshotSourceRows(input.sources),
  ].filter((row): row is SourceRow => row !== undefined)
}

// --- whole-pane models -------------------------------------------------------------------

export type ObservedPaneModel = {
  headline?: Headline
  stats: StatItem[]
  coverage?: CoverageModel
  runs: RunRow[]
  runTotal: number
  hasMoreRuns: boolean
  tokens: TokenRow[]
  sources: SourceRow[]
  sourceWarnings: string[]
  caveats: string[]
  identifiers: IdentifierItem[]
}

export type BenchmarkPaneModel = {
  headline?: Headline
  stats: StatItem[]
  /** Secondary indices, when the source reports them. */
  scores: SourceRow[]
  sources: SourceRow[]
  sourceWarnings: string[]
  caveats: string[]
  identifiers: IdentifierItem[]
}

export function observedPaneModel(input: {
  inspection: Inspection
  facts: SelectedFacts | undefined
  sources: readonly ModelSource[]
  warnings: readonly string[]
}): ObservedPaneModel {
  const { inspection } = input
  const contributors = inspection.contributorPage.contributors
  const scenario = inspection.knownUsageMarket?.scenarios[0]
  const usage: UsageSource | undefined = inspection.referenceEstimate ?? scenario
  return {
    headline: runsHeadline(input.facts),
    stats: runsStats(input.facts),
    coverage: runsCoverage(inspection.referenceEstimate),
    runs: runRows(contributors),
    runTotal: inspection.contributorPage.totalCount,
    hasMoreRuns: Boolean(inspection.contributorPage.nextCursor),
    tokens: tokenRows(usage, scenario?.rateSets),
    sources: [...priceSourceRows(inspection), ...snapshotSourceRows(input.sources)],
    sourceWarnings: [...input.warnings],
    caveats: runsCaveats(inspection),
    identifiers: runsIdentifiers(inspection, contributors),
  }
}

export function benchmarkPaneModel(input: {
  route: BenchmarkRoute
  scores: BenchmarkScores
  price: BenchmarkPrice | null
  citation: string | undefined
  snapshot: { snapshotID: string; retrievedAt: string } | undefined
  priceSourceName: string | undefined
  order: string
  mix: { input: number; output: number }
  sources: readonly ModelSource[]
  warnings: readonly string[]
}): BenchmarkPaneModel {
  return {
    headline: benchmarkHeadline(input.scores),
    stats: benchmarkStats(input.price),
    scores: benchmarkScoreRows(input.scores),
    sources: benchmarkSourceRows({
      citation: input.citation,
      scoreRetrievedAt: input.snapshot?.retrievedAt,
      price: input.price,
      priceSourceName: input.priceSourceName,
      order: input.order,
      sources: input.sources,
    }),
    sourceWarnings: [...input.warnings],
    caveats: benchmarkCaveats({ price: input.price, mix: input.mix }),
    identifiers: [
      { label: "Route", value: `${input.route.providerID}/${input.route.modelID}` },
      { label: "Catalog slug", value: realSlug(input.scores.modelPermaslug) },
      { label: "Score snapshot", value: input.snapshot?.snapshotID },
    ],
  }
}
