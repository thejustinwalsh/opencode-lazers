import { BENCHMARK_PRICE_MIX } from "./benchmark-baseline.ts"
import type { ModelChartPoint, RankingChartRow } from "./model-chart.tsx"
import type { CatalogEntry } from "./catalog-projection.ts"
import { SMALL_SAMPLE_TERMINAL_TASKS, paretoFrontier } from "./chart-layout.ts"
import type { BenchmarkBaselineGap, BenchmarkBaselinePoint } from "./benchmark-baseline.ts"
import type { ModelDecisionGraphPoint } from "./decision-contract.ts"
import type { ModelDecisionReferenceEstimate } from "./reference-estimate.ts"
import {
  boundedModelEffortLabel,
  boundedModelLabel,
  formatMarketAmount,
  formatMarketRange,
  modelEffortLabel,
  routeLabel,
} from "./comparison-presentation.ts"

export type ComparisonChartPoint = ModelDecisionGraphPoint & {
  route?: { providerID: string; modelID: string; variant: string | null }
  marketSource?: "openrouter" | "opencode" | "mixed" | "unavailable"
}

export type ComparisonChartReference = {
  configurationID: string
  label: string
  tokensPerAcceptedTask: number | null
  estimate: ModelDecisionReferenceEstimate
}

export interface ComparisonChartData {
  points: readonly ComparisonChartPoint[]
  references?: readonly ComparisonChartReference[]
  frontierConfigurationIDs: readonly string[]
  selectedConfigurationID?: string | null
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumSignificantDigits: 12,
})
const tokens = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 })
const tokenAxis = new Intl.NumberFormat("en-US", {
  notation: "compact",
  compactDisplay: "short",
  maximumFractionDigits: 1,
})

const noPointDescription =
  "No plottable observations. Unknown prices, zero-accepted configurations, and missing actual token coordinates remain unplotted."

/** Visible explanation for a chart with nothing to plot; names what is missing. */
export function comparisonChartEmptyText(
  points: readonly ComparisonChartPoint[],
  references: readonly ComparisonChartReference[] = [],
) {
  const models = new Set([
    ...points.map((point) => point.configurationID),
    ...references.map((reference) => reference.configurationID),
  ]).size
  if (!models)
    return "No accepted tasks match these filters yet. Models appear here once a task is accepted and a price source covers the model."
  const unpriced = references.filter(
    (reference) =>
      reference.estimate.acceptedTaskCount > 0 && referenceAmount(reference.estimate) === undefined,
  ).length
  const unmeasured = references.filter(
    (reference) =>
      referenceAmount(reference.estimate) !== undefined && reference.tokensPerAcceptedTask === null,
  ).length
  const noAccepted = references.filter(
    (reference) => reference.estimate.acceptedTaskCount < 1,
  ).length
  const plural = (count: number, singular: string, many: string) =>
    `${count} ${count === 1 ? singular : many}`
  const reasons = [
    ...(unpriced
      ? [`${plural(unpriced, "model has", "models have")} no price from any source`]
      : []),
    ...(unmeasured
      ? [`${plural(unmeasured, "model has", "models have")} no token measurements`]
      : []),
    ...(noAccepted ? [`${plural(noAccepted, "model has", "models have")} no accepted tasks`] : []),
  ]
  return `Nothing to plot yet: ${reasons.length ? reasons.join("; ") : `${plural(models, "model is", "models are")} missing a price or token measurement`}. Chart data lists each model.`
}

/** Short visible Chart data row: model · cost · tokens, or what keeps it off the plot. */
export function comparisonChartChoiceSummary(choice: {
  point?: ComparisonChartPoint
  reference?: ComparisonChartReference
}) {
  if (choice.point && plottable(choice.point))
    return `${comparisonChartPointTooltip(choice.point)} · ${compactTokenAxisValue(choice.point.tokensPerAcceptedTask)} tokens`
  const reference = choice.reference
  if (reference) {
    const cost = comparisonChartReferenceTooltip(reference)
    if (cost && reference.tokensPerAcceptedTask !== null)
      return `${cost} · ${compactTokenAxisValue(reference.tokensPerAcceptedTask)} tokens`
    const name = boundedModelEffortLabel(
      modelEffortLabel(reference.label, reference.estimate.route),
    )
    if (cost) return `${cost} · not plotted, no token measurement`
    return reference.estimate.acceptedTaskCount < 1
      ? `${name} · not plotted, no accepted tasks`
      : `${name} · not plotted, no price`
  }
  const point = choice.point!
  return `${boundedModelEffortLabel(modelEffortLabel(point.label, point.route))} · not plotted`
}

type KeyboardChoice = { configurationID: string; label: string; tokens: number; amount: number }

/** Plotted marks in left-to-right order for arrow-key travel; one stop per model. */
export function comparisonChartKeyboardOrder(
  points: readonly ComparisonChartPoint[],
  references: readonly ComparisonChartReference[] = [],
) {
  const choices = new Map<string, KeyboardChoice>()
  for (const reference of references) {
    const amount = referenceAmount(reference.estimate)
    if (!amount || !referenceIsPlottable(reference) || reference.tokensPerAcceptedTask === null)
      continue
    choices.set(reference.configurationID, {
      configurationID: reference.configurationID,
      label: comparisonChartReferenceTooltip(reference),
      tokens: reference.tokensPerAcceptedTask,
      amount: "value" in amount ? amount.value : amount.minimum,
    })
  }
  for (const point of points) {
    if (!plottable(point)) continue
    choices.set(point.configurationID, {
      configurationID: point.configurationID,
      label: comparisonChartPointTooltip(point),
      tokens: point.tokensPerAcceptedTask,
      amount: point.currentMarketUSDPerAcceptedTask,
    })
  }
  return [...choices.values()].toSorted(
    (left, right) => left.tokens - right.tokens || left.amount - right.amount,
  )
}

export function compactTokenAxisValue(value: number) {
  return tokenAxis.format(value)
}

export function comparisonChartPointText(point: ComparisonChartPoint) {
  const identity = point.route
    ? `exact route ${routeLabel(point.route)}`
    : `producer label ${point.label}; exact route metadata not present`
  const source =
    point.marketSource === "openrouter"
      ? "OpenRouter model catalog"
      : point.marketSource === "opencode"
        ? "OpenCode model catalog"
        : point.marketSource === "mixed"
          ? "configured price sources"
          : point.marketSource === "unavailable"
            ? "configured source not recorded"
            : "configured price source not supplied"
  const partial = point.partial ? "; partial cohort coverage" : ""
  return `${point.label} · ${identity}; ${tokens.format(point.tokensPerAcceptedTask)} actual tokens per accepted task; canonical current-market value ${money.format(point.currentMarketUSDPerAcceptedTask)} per accepted task (short display ${formatMarketAmount(point.currentMarketUSDPerAcceptedTask)}); ordered whole-model price-source valuation from ${source}; ${point.observationCount} observation${point.observationCount === 1 ? "" : "s"}; denominator ${point.acceptedTaskCount} accepted task${point.acceptedTaskCount === 1 ? "" : "s"}${partial}.`
}

/** Terse model · cost text shared by the pointer tooltip and keyboard announcement. */
export function comparisonChartPointTooltip(point: ComparisonChartPoint) {
  const label = boundedModelEffortLabel(modelEffortLabel(point.label, point.route))
  return `${label} · ≈${formatMarketAmount(point.currentMarketUSDPerAcceptedTask)} / task`
}

type ReferenceAmount =
  | { kind: "scalar"; value: number }
  | { kind: "range"; minimum: number; maximum: number }
  | { kind: "subtotal"; value: number }
  | { kind: "subtotal-range"; minimum: number; maximum: number }

export function referenceAmount(
  estimate: ModelDecisionReferenceEstimate,
): ReferenceAmount | undefined {
  if (estimate.status === "exact" && estimate.valueUSDPerAcceptedTask !== null)
    return { kind: "scalar", value: estimate.valueUSDPerAcceptedTask }
  if (estimate.status === "conditional" && estimate.rangeUSDPerAcceptedTask !== null)
    return { kind: "range", ...estimate.rangeUSDPerAcceptedTask }
  if (estimate.status === "partial" && estimate.knownSubtotalUSDPerAcceptedTask !== null)
    return { kind: "subtotal", value: estimate.knownSubtotalUSDPerAcceptedTask }
  if (estimate.status === "partial" && estimate.knownSubtotalRangeUSDPerAcceptedTask !== null)
    return { kind: "subtotal-range", ...estimate.knownSubtotalRangeUSDPerAcceptedTask }
  return undefined
}

export function comparisonChartReferenceText(reference: ComparisonChartReference) {
  const estimate = reference.estimate
  const amount = referenceAmount(estimate)
  const amountLabel = amount
    ? amount.kind === "scalar"
      ? `OpenRouter model catalog scalar reference ${money.format(amount.value)} per accepted task`
      : amount.kind === "range"
        ? `OpenRouter model catalog conditional range ${money.format(amount.minimum)}–${money.format(amount.maximum)} per accepted task`
        : amount.kind === "subtotal"
          ? `OpenRouter model catalog priced subtotal only ${money.format(amount.value)} per accepted task; total and remainder unknown`
          : `OpenRouter model catalog priced subtotal range only ${money.format(amount.minimum)}–${money.format(amount.maximum)} per accepted task; total and remainder unknown`
    : estimate.status === "zero-accepted"
      ? "no accepted-task denominator"
      : "no numeric per-task amount"
  const coordinate =
    reference.tokensPerAcceptedTask === null
      ? "Actual cohort token coordinate unknown"
      : `${tokens.format(reference.tokensPerAcceptedTask)} actual cohort tokens per accepted task`
  return `${modelEffortLabel(reference.label, estimate.route)} · exact route ${routeLabel(estimate.route)}: ${coordinate}; ${amountLabel}; basis OpenRouter model catalog reference cost per accepted task; denominator ${estimate.acceptedTaskCount} accepted task${estimate.acceptedTaskCount === 1 ? "" : "s"}; OpenRouter model catalog source ${estimate.provenance.freshness}; actual route-specific task mix (not a common workload).`
}

/** Terse model · cost text; a known subtotal is a lower bound, never a total. */
export function comparisonChartReferenceTooltip(reference: ComparisonChartReference) {
  const amount = referenceAmount(reference.estimate)
  if (!amount) return ""
  const label = boundedModelEffortLabel(modelEffortLabel(reference.label, reference.estimate.route))
  const value =
    amount.kind === "scalar"
      ? `≈${formatMarketAmount(amount.value)}`
      : amount.kind === "range"
        ? `≈${formatMarketRange({ minimum: amount.minimum, maximum: amount.maximum })}`
        : `≥${formatMarketAmount(amount.kind === "subtotal" ? amount.value : amount.minimum)}`
  return `${label} · ${value} / task`
}

function tooltipText(value: string) {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }
  return value.replace(/[&<>"']/g, (character) => entities[character]!)
}

function plottable(point: ComparisonChartPoint) {
  return (
    Number.isFinite(point.tokensPerAcceptedTask) &&
    point.tokensPerAcceptedTask >= 0 &&
    Number.isFinite(point.currentMarketUSDPerAcceptedTask) &&
    point.currentMarketUSDPerAcceptedTask >= 0
  )
}

function referenceIsPlottable(reference: ComparisonChartReference) {
  const amount = referenceAmount(reference.estimate)
  return (
    reference.tokensPerAcceptedTask !== null &&
    Number.isFinite(reference.tokensPerAcceptedTask) &&
    reference.tokensPerAcceptedTask >= 0 &&
    amount !== undefined
  )
}

export function comparisonChartHasPlottablePoints(
  points: readonly ComparisonChartPoint[],
  references: readonly ComparisonChartReference[] = [],
) {
  return points.some(plottable) || references.some(referenceIsPlottable)
}

function comparisonChartDescription(
  points: readonly ComparisonChartPoint[],
  references: readonly ComparisonChartReference[],
) {
  const unplottedPoints = points.filter((point) => !plottable(point))
  const unplottedReferences = references.filter((reference) => !referenceIsPlottable(reference))
  return (
    [
      ...points.map((point) =>
        plottable(point)
          ? comparisonChartPointText(point)
          : `${comparisonChartPointText(point)} Not plotted because a numeric actual token coordinate or market value is missing.`,
      ),
      ...references.map(comparisonChartReferenceText),
      ...(unplottedPoints.length
        ? [
            `${unplottedPoints.length} canonical point${unplottedPoints.length === 1 ? " is" : "s are"} not plotted because a numeric coordinate is missing.`,
          ]
        : []),
      ...(unplottedReferences.length
        ? [
            `${unplottedReferences.length} OpenRouter model catalog reference estimate${unplottedReferences.length === 1 ? "" : "s"} are not plotted because a numeric actual cohort token coordinate or per-task amount is missing.`,
          ]
        : []),
    ].join(" ") || noPointDescription
  )
}

/** One plotted model: an observed point, or a catalog reference estimate at its midpoint. */
export type ChartMark = {
  configurationID: string
  groupID?: string
  label: string
  route?: { providerID: string; modelID: string; variant?: string | null }
  tokens: number
  /** USD per accepted task; the midpoint for a range, the lower bound for a priced subtotal. */
  amount: number
  /** The range behind `amount`, when the cost is a range. */
  range?: { minimum: number; maximum: number }
  accepted?: number
  terminal?: number
  frontier: boolean
  kind: "canonical" | "reference"
  /** The full accessible description: exact route, coordinates, denominator and basis. */
  aria: string
}

/**
 * Every plotted mark, one per model configuration. An observed point wins over a catalog
 * reference for the same configuration. Ranges plot at their midpoint; the range itself is in
 * the tooltip and the selection summary, never drawn as whiskers.
 *
 * The best trade-off (`frontier`) is the Pareto set over cost per accepted task (lower),
 * tokens per accepted task (lower) and acceptance rate (higher), among observed points with at
 * least one accepted task (a partial cohort or a sample under
 * `SMALL_SAMPLE_TERMINAL_TASKS` is flagged "small sample", not excluded). Catalog references
 * are a different measure and never join it. The server's own frontier list is not used.
 */
export function comparisonChartMarks(data: ComparisonChartData): ChartMark[] {
  const marks = new Map<string, ChartMark>()
  for (const reference of data.references ?? []) {
    const amount = referenceAmount(reference.estimate)
    if (!amount || !referenceIsPlottable(reference) || reference.tokensPerAcceptedTask === null)
      continue
    const range =
      amount.kind === "range" || amount.kind === "subtotal-range"
        ? { minimum: amount.minimum, maximum: amount.maximum }
        : undefined
    marks.set(reference.configurationID, {
      configurationID: reference.configurationID,
      label: reference.label,
      route: reference.estimate.route,
      tokens: reference.tokensPerAcceptedTask,
      amount:
        amount.kind === "scalar" || amount.kind === "subtotal"
          ? amount.value
          : amount.kind === "range"
            ? amount.minimum / 2 + amount.maximum / 2
            : amount.minimum,
      ...(range ? { range } : {}),
      accepted: reference.estimate.acceptedTaskCount,
      frontier: false,
      kind: "reference",
      aria: comparisonChartReferenceText(reference),
    })
  }
  const eligible: ChartMark[] = []
  for (const point of data.points) {
    if (!plottable(point)) continue
    const previous = marks.get(point.configurationID)
    const mark: ChartMark = {
      configurationID: point.configurationID,
      groupID: point.groupID,
      label: point.label,
      ...(point.route ? { route: point.route } : {}),
      tokens: point.tokensPerAcceptedTask,
      amount: point.currentMarketUSDPerAcceptedTask,
      ...(previous?.range ? { range: previous.range } : {}),
      accepted: point.acceptedTaskCount,
      ...(point.terminalTaskCount === undefined ? {} : { terminal: point.terminalTaskCount }),
      frontier: false,
      kind: "canonical",
      aria: comparisonChartPointText(point),
    }
    marks.set(point.configurationID, mark)
    // Any point with an accepted task counts. A small sample is flagged, and a partial cohort
    // or missing acceptance data is compared on the measures that exist, not excluded.
    if (point.acceptedTaskCount > 0) eligible.push(mark)
  }
  const rate = (mark: ChartMark) =>
    mark.terminal && mark.accepted !== undefined ? mark.accepted / mark.terminal : null
  for (const mark of paretoFrontier(eligible, [
    (item) => item.amount,
    (item) => item.tokens,
    (item) => {
      const value = rate(item)
      return value === null ? null : -value
    },
  ]))
    mark.frontier = true
  return [...marks.values()]
}

export function chartMarkLabel(
  label: string,
  route: { providerID: string; modelID: string; variant?: string | null } | undefined,
  limit: number,
) {
  const full = modelEffortLabel(label, route)
  const split = full.lastIndexOf(" · ")
  if (!route?.variant || split < 0 || Array.from(full).length <= limit)
    return boundedModelEffortLabel(full, limit)
  const effort = boundedModelLabel(full.slice(split + 3), 10)
  const model = boundedModelLabel(
    full.slice(0, split),
    Math.max(6, limit - 3 - Array.from(effort).length),
  )
  return `${model} · ${effort}`
}

const index = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })
const tokenCount = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })
const mix = `${BENCHMARK_PRICE_MIX.input} input : ${BENCHMARK_PRICE_MIX.output} output tokens`

export const benchmarkSourceName = {
  openrouter: "OpenRouter",
  opencode: "OpenCode",
  "models-dev": "models.dev",
} as const

/** Terse model · score · price shared by tooltip, keyboard announcement and Chart data. */
export function benchmarkPointTooltip(point: BenchmarkBaselinePoint) {
  return `${boundedModelLabel(point.label)} · ${point.benchmark.scoreName ?? "Coding"} ${index.format(point.benchmark.codingIndex)} · ${formatMarketAmount(point.price.blended)} / 1M tokens`
}

/** Complete accessible description; names sources, units and the token mix. */
export function benchmarkPointText(point: BenchmarkBaselinePoint) {
  const price = point.price
  const tier = price.appliesBelowTokens
    ? `; base rate for prompts under ${tokenCount.format(price.appliesBelowTokens)} tokens`
    : ""
  return `${point.label} · exact route ${routeLabel(point.route)}: ${point.benchmark.scoreCaption ?? "Artificial Analysis Coding Index"} ${index.format(point.benchmark.codingIndex)} for ${point.benchmark.displayName ?? point.benchmark.modelPermaslug}; ${benchmarkSourceName[price.source]} list price ${formatMarketAmount(price.input)} input and ${formatMarketAmount(price.output)} output per 1M tokens, ${formatMarketAmount(price.blended)} per 1M at ${mix}${tier}; ${point.observed ? "has observed task outcomes for these filters" : "no observed task outcomes for these filters"}.`
}

export function benchmarkGapText(gap: BenchmarkBaselineGap) {
  return gap.reason === "no-price"
    ? `${boundedModelLabel(gap.label)} · not plotted, no price`
    : `${boundedModelLabel(gap.label)} · not plotted, no ${gap.benchmark.scoreName ?? "Coding Index"}`
}

/**
 * Non-dominated plotted points: no other point is at most as expensive with at
 * least as high a Coding Index (and strictly better on one). Sorted by price
 * ascending, then Coding Index descending, then id. Real coordinates only.
 */
export function benchmarkFrontier(
  points: readonly BenchmarkBaselinePoint[],
): BenchmarkBaselinePoint[] {
  const x = (point: BenchmarkBaselinePoint) => point.price.blended
  const y = (point: BenchmarkBaselinePoint) => point.benchmark.codingIndex
  const sorted = points
    .filter((point) => Number.isFinite(x(point)) && Number.isFinite(y(point)))
    .toSorted(
      (left, right) =>
        x(left) - x(right) ||
        y(right) - y(left) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    )
  const frontier: BenchmarkBaselinePoint[] = []
  let best = -Infinity
  for (const point of sorted) {
    // Sorted by x asc, y desc: a point survives only if it beats every cheaper-or-equal one,
    // or exactly ties the current best at the same coordinates.
    const last = frontier.at(-1)
    const duplicate = last !== undefined && x(last) === x(point) && y(last) === y(point)
    if (y(point) > best || duplicate) {
      frontier.push(point)
      best = Math.max(best, y(point))
    }
  }
  return frontier
}

function benchmarkFrontierText(frontier: readonly BenchmarkBaselinePoint[]) {
  return frontier.length === 0
    ? ""
    : ` Benchmark frontier, lowest list price for each higher Coding Index: ${frontier.map((point) => boundedModelLabel(point.label)).join(", ")}.`
}

function benchmarkDescription(points: readonly BenchmarkBaselinePoint[]) {
  return (
    points.map(benchmarkPointText).join(" ") + benchmarkFrontierText(benchmarkFrontier(points)) ||
    "No benchmarked models with a price."
  )
}

// -- Points for the SVG chart ---------------------------------------------------------------------

const pointLabelLimit = 26

/** Observed points and catalog references as chart points, frontier computed here. */
export function observedChartPoints(
  data: ComparisonChartData,
  priceSource: string | undefined,
): ModelChartPoint[] {
  return comparisonChartMarks(data).map((mark) => {
    const name = modelEffortLabel(mark.label, mark.route)
    const cost = mark.range
      ? `${formatMarketRange(mark.range)} per accepted task`
      : `≈${formatMarketAmount(mark.amount)} per accepted task`
    const lines = [
      name,
      cost,
      `${compactTokenAxisValue(mark.tokens)} tokens per accepted task`,
      ...(mark.accepted === undefined
        ? []
        : [
            mark.terminal
              ? `${mark.accepted} of ${mark.terminal} accepted`
              : `${mark.accepted} accepted`,
          ]),
      ...(mark.terminal !== undefined && mark.terminal < SMALL_SAMPLE_TERMINAL_TASKS
        ? [`small sample · ${mark.accepted} of ${mark.terminal}`]
        : []),
      ...(priceSource ? [`${priceSource} prices`] : []),
    ]
    return {
      id: mark.configurationID,
      x: mark.tokens,
      y: mark.amount,
      label: chartMarkLabel(mark.label, mark.route, pointLabelLimit),
      frontier: mark.frontier,
      tooltip: lines,
      description: mark.aria,
    }
  })
}

/** Tooltip lines of a projected model: name, projected cost, score, measured facts, source. */
function projectedLines(entry: CatalogEntry) {
  const measured = entry.observed
  return [
    entry.label,
    ...(entry.projection
      ? [`Projected ≈${formatMarketAmount(entry.projection.usd)} per accepted task`]
      : []),
    ...(entry.score !== null ? [`${entry.scoreName ?? "Coding index"} ${entry.score}`] : []),
    ...(measured
      ? [
          `Measured ${measured.range ? formatMarketRange(measured.range) : formatMarketAmount(measured.usd)} · ${
            measured.terminal
              ? `${measured.accepted} of ${measured.terminal} accepted`
              : `${measured.accepted} accepted`
          }`,
        ]
      : []),
    ...(entry.price
      ? [
          `${benchmarkSourceName[entry.price.source]} prices${entry.price.retrievedAt ? ` · ${entry.price.retrievedAt.slice(0, 10)}` : ""}`,
        ]
      : []),
  ]
}

/** Projections with a public score: cost per task against the coding index (the secondary plot). */
export function projectedChartPoints(entries: readonly CatalogEntry[]): ModelChartPoint[] {
  return entries.flatMap((entry) => {
    if (!entry.projection || entry.score === null) return []
    const lines = projectedLines(entry)
    return [
      {
        id: entry.id,
        // Cost on x, the public score on y: better scores sit higher.
        x: entry.projection.usd,
        y: entry.score,
        label: boundedModelLabel(entry.label, pointLabelLimit),
        frontier: entry.frontier,
        backed: entry.observed !== null,
        tooltip: lines,
        description: lines.join(". "),
      },
    ]
  })
}

/**
 * The Projected ranking: every priced model with a projection, cheapest first. It needs no
 * second measure, so it exists whenever any source prices anything.
 */
export function projectedRankRows(entries: readonly CatalogEntry[]): RankingChartRow[] {
  return entries
    .filter((entry) => entry.projection)
    .toSorted((a, b) => a.projection!.usd - b.projection!.usd || a.label.localeCompare(b.label))
    .map((entry) => {
      const lines = projectedLines(entry)
      return {
        id: entry.id,
        label: entry.label,
        value: entry.projection!.usd,
        backed: entry.observed !== null,
        score: entry.score,
        tooltip: lines,
        description: lines.join(". "),
      }
    })
}

/** The Benchmark view: coding index against list price per 1M tokens. */
export function benchmarkChartPoints(points: readonly BenchmarkBaselinePoint[]): ModelChartPoint[] {
  const frontier = new Set(benchmarkFrontier(points).map((point) => point.id))
  return points.map((point) => ({
    id: point.id,
    x: point.price.blended,
    y: point.benchmark.codingIndex,
    label: boundedModelLabel(point.label, pointLabelLimit),
    frontier: frontier.has(point.id),
    tooltip: [
      point.label,
      `${point.benchmark.scoreName ?? "Coding index"} ${index.format(point.benchmark.codingIndex)}`,
      `${formatMarketAmount(point.price.blended)} per 1M tokens (${mix})`,
      `${benchmarkSourceName[point.price.source]} list price`,
    ],
    description: benchmarkPointText(point),
  }))
}
