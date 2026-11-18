import { LineChart, ScatterChart } from "echarts/charts"
import { AriaComponent, GridComponent, TooltipComponent } from "echarts/components"
import * as echarts from "echarts/core"
import type { EChartsCoreOption, EChartsType } from "echarts/core"
import { SVGRenderer } from "echarts/renderers"
import { For, Show, createEffect, createSignal, createUniqueId, onCleanup, onMount } from "solid-js"
import type { JSX } from "solid-js"
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

echarts.use([ScatterChart, LineChart, GridComponent, TooltipComponent, AriaComponent, SVGRenderer])

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

export interface ComparisonChartTheme {
  surface: string
  text: string
  mutedText: string
  grid: string
  accent: string
  /** Panel background; hollow marks are filled with it. Falls back to `surface`. */
  background?: string
  /** Stroke of non-frontier marks. Falls back to `mutedText`. */
  neutral?: string
  fontFamily: string
  monoFontFamily: string
  fontSize?: number
}

export interface ComparisonChartLayout {
  width: number
  height: number
  fontSize: number
  grid: { left: number; right: number; top: number; bottom: number; containLabel: false }
  xSplitNumber: number
  ySplitNumber: number
}

export interface ComparisonChartData {
  points: readonly ComparisonChartPoint[]
  references?: readonly ComparisonChartReference[]
  frontierConfigurationIDs: readonly string[]
  selectedConfigurationID?: string | null
}

export interface ComparisonChartProps extends ComparisonChartData {
  onSelect: (configurationID: string) => void
  /** Supply reactive native values, or appearanceVersion to re-read host CSS tokens. */
  theme?: ComparisonChartTheme
  fontFamily?: string
  monoFontFamily?: string
  appearanceVersion?: unknown
  /** Shown under the empty-state text, e.g. a switch to another comparison. */
  emptyAction?: JSX.Element
  /** Right of the legend, e.g. "14 accepted tasks · OpenRouter prices". */
  caption?: string
  /** Where the "Chart data as a table" disclosure renders; inline until the mount exists. */
  dataMount?: () => HTMLElement | undefined
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

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value))

/** Chart text size from the mockup type scale; grows only when the host font is large. */
export const CHART_FONT_SIZE = 11.5

/**
 * Round axis maximum and step for about `intervals` steps, so ticks read 0, 5M, 10M, 15M, 20M
 * rather than whatever the renderer picks. The maximum covers `maxValue`.
 */
export function niceAxis(maxValue: number, intervals: number) {
  const target = Math.max(1, Math.floor(intervals))
  if (!(maxValue > 0) || !Number.isFinite(maxValue)) return { max: target, interval: 1 }
  const raw = maxValue / target
  const base = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((unit) => unit * base).find((unit) => unit >= raw * 0.999999)!
  const round = (value: number) => Number(value.toPrecision(10))
  const interval = round(step)
  return { max: round(Math.ceil(maxValue / interval - 1e-9) * interval), interval }
}

/** Dollar axis tick: `$3` for whole amounts, `$0.50` otherwise. */
export function formatAxisMoney(value: number) {
  if (Number.isInteger(value)) return `$${value}`
  return `$${Math.round(value * 100) / 100 === value ? value.toFixed(2) : value.toFixed(3)}`
}

/** Reserve axis room from the rendered host size and inherited native font. */
export function comparisonChartResponsiveLayout(
  width: number,
  height: number,
  inheritedFontSize = 12,
): ComparisonChartLayout {
  const safeWidth = Math.max(1, width)
  const safeHeight = Math.max(1, height)
  const inherited = Number.isFinite(inheritedFontSize) ? inheritedFontSize : 12
  const fontSize = clamp(Math.max(CHART_FONT_SIZE, inherited * 0.82), CHART_FONT_SIZE, 24)
  const grid = {
    left: Math.ceil(fontSize * 4.9),
    right: Math.ceil(fontSize * 1.6),
    top: Math.ceil(fontSize * 1.2),
    bottom: Math.ceil(fontSize * 3.7),
    containLabel: false as const,
  }
  const plotWidth = Math.max(1, safeWidth - grid.left - grid.right)
  const plotHeight = Math.max(1, safeHeight - grid.top - grid.bottom)
  return {
    width: safeWidth,
    height: safeHeight,
    fontSize,
    grid,
    // About five round ticks: four steps. Fewer when the plot is small.
    xSplitNumber: clamp(Math.floor(plotWidth / (fontSize * 7.5)), 2, 4),
    ySplitNumber: clamp(Math.floor(plotHeight / (fontSize * 3.6)), 2, safeWidth < 420 ? 3 : 4),
  }
}

function nativeToken(styles: CSSStyleDeclaration, name: string, fallback: string) {
  return styles.getPropertyValue(name).trim() || fallback
}

/** Resolve the pinned host tokens at update time rather than freezing a palette. */
export function resolveNativeComparisonChartTheme(
  element: HTMLElement,
  fontFamily?: string,
  monoFontFamily?: string,
): ComparisonChartTheme {
  const styles = element.ownerDocument.defaultView?.getComputedStyle(element)
  return {
    surface: styles ? nativeToken(styles, "--surface-base", "transparent") : "transparent",
    text: styles ? nativeToken(styles, "--text-strong", "currentColor") : "currentColor",
    mutedText: styles ? nativeToken(styles, "--text-weak", "currentColor") : "currentColor",
    grid: styles ? nativeToken(styles, "--border-weak-base", "currentColor") : "currentColor",
    accent: styles
      ? nativeToken(
          styles,
          "--text-interactive-base",
          nativeToken(styles, "--border-selected", "currentColor"),
        )
      : "currentColor",
    background: styles ? nativeToken(styles, "--background-base", "transparent") : "transparent",
    neutral: styles ? nativeToken(styles, "--text-base", "currentColor") : "currentColor",
    fontFamily: fontFamily || styles?.fontFamily || "sans-serif",
    monoFontFamily: monoFontFamily || fontFamily || styles?.fontFamily || "monospace",
    fontSize: Number.parseFloat(styles?.fontSize ?? "") || 12,
  }
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

function referenceAmount(estimate: ModelDecisionReferenceEstimate): ReferenceAmount | undefined {
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

export type ChartLabelSide = "right" | "left" | "top" | "bottom"

export type ChartLabelItem = {
  id: string
  x: number
  y: number
  text: string
  /** Preferred side; the others are tried, in a fixed order, when it would collide. */
  side: ChartLabelSide
  /** 0 selected, 1 frontier, 2 the rest. */
  priority: number
}

const labelSideOrder: Record<ChartLabelSide, readonly ChartLabelSide[]> = {
  right: ["right", "left", "top", "bottom"],
  left: ["left", "right", "top", "bottom"],
  top: ["top", "right", "left", "bottom"],
  bottom: ["bottom", "right", "left", "top"],
}
const MARKER_RADIUS = 5

/**
 * Where each point label goes. Labels are placed selected first, then frontier points, then the
 * rest, so when space runs out the non-frontier labels are the ones dropped. A label tries its
 * preferred side, then the others, and is dropped when every side overlaps an already placed
 * label, any other mark, or the plot edge. Positions are estimated from the value extents.
 */
export function placeChartLabels(
  items: readonly ChartLabelItem[],
  box: { plotWidth: number; plotHeight: number; xMax: number; yMax: number; fontSize: number },
) {
  type Rect = { left: number; right: number; top: number; bottom: number }
  const overlaps = (a: Rect, b: Rect, pad: number) =>
    a.left < b.right + pad &&
    a.right > b.left - pad &&
    a.top < b.bottom + pad &&
    a.bottom > b.top - pad
  const centre = (item: ChartLabelItem) => ({
    cx: box.xMax > 0 ? (item.x / box.xMax) * box.plotWidth : 0,
    cy: box.yMax > 0 ? box.plotHeight - (item.y / box.yMax) * box.plotHeight : box.plotHeight,
  })
  const markers = items.map((item) => {
    const { cx, cy } = centre(item)
    return {
      id: item.id,
      left: cx - MARKER_RADIUS,
      right: cx + MARKER_RADIUS,
      top: cy - MARKER_RADIUS,
      bottom: cy + MARKER_RADIUS,
    }
  })
  const kept: Rect[] = []
  const placed = new Map<string, ChartLabelSide>()
  const ordered = items.toSorted((left, right) => left.priority - right.priority)
  for (const item of ordered) {
    const lines = item.text.split("\n")
    const width = Math.max(...lines.map((line) => line.length)) * box.fontSize * 0.54
    const height = lines.length * box.fontSize * 1.3
    const { cx, cy } = centre(item)
    const rectOn = (side: ChartLabelSide): Rect => {
      const left =
        side === "right"
          ? cx + MARKER_RADIUS + 3
          : side === "left"
            ? cx - MARKER_RADIUS - 3 - width
            : cx - width / 2
      const top =
        side === "top"
          ? cy - MARKER_RADIUS - 2 - height
          : side === "bottom"
            ? cy + MARKER_RADIUS + 2
            : cy - height / 2
      return { left, right: left + width, top, bottom: top + height }
    }
    const insidePlot = (rect: Rect) =>
      rect.left >= 0 &&
      rect.right <= box.plotWidth &&
      rect.top >= 0 &&
      rect.bottom <= box.plotHeight
    const clearOfLabels = (rect: Rect) => !kept.some((other) => overlaps(rect, other, 2))
    const clearOfMarks = (rect: Rect) =>
      !markers.some((marker) => marker.id !== item.id && overlaps(rect, marker, 1))
    // The best trade-off labels and the rest need a clear side. The selection is always named:
    // when every side is crowded by other marks it sits over them, still clear of other labels,
    // and as a last resort on its preferred side.
    const candidates = labelSideOrder[item.side].map((side) => ({ side, rect: rectOn(side) }))
    const choice =
      candidates.find(
        ({ rect }) => insidePlot(rect) && clearOfLabels(rect) && clearOfMarks(rect),
      ) ??
      (item.priority === 0
        ? (candidates.find(({ rect }) => insidePlot(rect) && clearOfLabels(rect)) ?? candidates[0])
        : undefined)
    if (!choice) continue
    kept.push(choice.rect)
    placed.set(item.id, choice.side)
  }
  return placed
}

/** The ids that keep a label; see `placeChartLabels` for where it goes. */
export function visibleChartLabelIDs(
  items: readonly ChartLabelItem[],
  box: Parameters<typeof placeChartLabels>[1],
) {
  return new Set(placeChartLabels(items, box).keys())
}

/** One plotted mark: an observed point, or a catalog reference estimate at its midpoint. */
export type ChartMark = {
  configurationID: string
  groupID?: string
  label: string
  route?: { providerID: string; modelID: string; variant?: string | null }
  tokens: number
  /** USD per accepted task; the midpoint for a range, the lower bound for a priced subtotal. */
  amount: number
  frontier: boolean
  kind: "canonical" | "reference"
}

/**
 * Every plotted mark, one per model configuration. An observed point wins over a catalog
 * reference for the same configuration. Ranges plot at their midpoint; the range itself is in
 * the selection summary, never drawn as whiskers.
 */
export function comparisonChartMarks(data: ComparisonChartData): ChartMark[] {
  const frontier = new Set(data.frontierConfigurationIDs)
  const marks = new Map<string, ChartMark>()
  for (const reference of data.references ?? []) {
    const amount = referenceAmount(reference.estimate)
    if (!amount || !referenceIsPlottable(reference) || reference.tokensPerAcceptedTask === null)
      continue
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
      // Catalog estimates are a different measure: they never join the observed frontier.
      frontier: false,
      kind: "reference",
    })
  }
  for (const point of data.points) {
    if (!plottable(point)) continue
    marks.set(point.configurationID, {
      configurationID: point.configurationID,
      groupID: point.groupID,
      label: point.label,
      ...(point.route ? { route: point.route } : {}),
      tokens: point.tokensPerAcceptedTask,
      amount: point.currentMarketUSDPerAcceptedTask,
      frontier: frontier.has(point.configurationID),
      kind: "canonical",
    })
  }
  return [...marks.values()]
}

/** The thin polyline through the best trade-off marks, left to right. Needs two or more. */
export function chartFrontierLine(marks: readonly ChartMark[]): [number, number][] {
  const line = marks
    .filter((mark) => mark.frontier)
    .toSorted(
      (left, right) =>
        left.tokens - right.tokens ||
        left.amount - right.amount ||
        (left.configurationID < right.configurationID
          ? -1
          : left.configurationID > right.configurationID
            ? 1
            : 0),
    )
    .map((mark): [number, number] => [mark.tokens, mark.amount])
  return line.length > 1 ? line : []
}

/** Frame, weak grid and axis text shared by the Compare and Benchmark plots. */
export function chartPlotFrame(theme: ComparisonChartTheme, layout: ComparisonChartLayout) {
  const fontSize = layout.fontSize
  const axisName = { color: theme.mutedText, fontFamily: theme.fontFamily, fontSize }
  const axisLabel = (formatter: (value: number) => string) => ({
    color: theme.mutedText,
    fontFamily: theme.monoFontFamily,
    fontSize,
    margin: Math.max(6, Math.ceil(fontSize * 0.55)),
    hideOverlap: true,
    formatter,
  })
  return {
    backgroundColor: "transparent",
    grid: {
      ...layout.grid,
      show: true,
      borderColor: theme.grid,
      borderWidth: 1,
      backgroundColor: "transparent",
    },
    axisName,
    axisLabel,
    axisLine: { lineStyle: { color: theme.grid } },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: theme.grid, opacity: 0.7 } },
    xNameGap: Math.ceil(fontSize * 2.1),
    yNameGap: Math.ceil(fontSize * 3.1),
  }
}

/**
 * A mark's one-line label, "GPT-6 Luna · max". A long effort is cut to ten characters first so the
 * model name keeps its room; the full route stays in the tooltip and the data table.
 */
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

export function comparisonChartOptions(
  data: ComparisonChartData,
  theme: ComparisonChartTheme,
  layout = comparisonChartResponsiveLayout(700, 300, theme.fontSize ?? 12),
) {
  const points = data.points.filter(plottable)
  const references = data.references ?? []
  const marks = comparisonChartMarks(data)
  const frame = chartPlotFrame(theme, layout)
  const selectedID = data.selectedConfigurationID
  const description = comparisonChartDescription(points, references)
  const referenceByConfiguration = new Map(
    references.map((reference) => [reference.configurationID, reference] as const),
  )
  const fontSize = layout.fontSize
  const plotWidth = Math.max(1, layout.width - layout.grid.left - layout.grid.right)
  const plotHeight = Math.max(1, layout.height - layout.grid.top - layout.grid.bottom)
  const labelLimit = clamp(Math.floor(plotWidth / (fontSize * 1.25)), 12, 30)
  const xAxis = niceAxis(
    Math.max(0, ...marks.map((mark) => mark.tokens)) * 1.05,
    layout.xSplitNumber,
  )
  const yAxis = niceAxis(
    Math.max(0, ...marks.map((mark) => mark.amount)) * 1.08,
    layout.ySplitNumber,
  )
  const labelText = (mark: ChartMark) => chartMarkLabel(mark.label, mark.route, labelLimit)
  const placed = placeChartLabels(
    marks.map((mark) => ({
      id: mark.configurationID,
      x: mark.tokens,
      y: mark.amount,
      text: labelText(mark),
      side:
        mark.configurationID === selectedID
          ? ("top" as const)
          : xAxis.max > 0 && mark.tokens >= xAxis.max * 0.68
            ? ("left" as const)
            : ("right" as const),
      priority: mark.configurationID === selectedID ? 0 : mark.frontier ? 1 : 2,
    })),
    { plotWidth, plotHeight, xMax: xAxis.max, yMax: yAxis.max, fontSize },
  )
  const selected = marks.find((mark) => mark.configurationID === selectedID)
  const neutral = theme.neutral ?? theme.mutedText
  const background = theme.background ?? theme.surface
  // The selection is drawn last so its mark and label sit above the rest.
  const drawn = marks.toSorted(
    (left, right) =>
      Number(left.configurationID === selectedID) - Number(right.configurationID === selectedID),
  )

  return {
    animation: false,
    backgroundColor: frame.backgroundColor,
    textStyle: { fontFamily: theme.fontFamily, color: theme.text },
    aria: { enabled: true, description, decal: { show: false } },
    grid: frame.grid,
    tooltip: {
      trigger: "item",
      confine: true,
      formatter: (parameters: { data?: { configurationID?: string; markKind?: string } }) => {
        const datum = parameters.data
        if (!datum?.configurationID) return ""
        if (datum.markKind === "reference") {
          const reference = referenceByConfiguration.get(datum.configurationID)
          return reference ? tooltipText(comparisonChartReferenceTooltip(reference)) : ""
        }
        const point = points.find(
          (candidate) => candidate.configurationID === datum.configurationID,
        )
        return point ? tooltipText(comparisonChartPointTooltip(point)) : ""
      },
    },
    xAxis: {
      type: "value",
      name: "Tokens per accepted task",
      nameLocation: "middle",
      nameGap: frame.xNameGap,
      min: 0,
      max: xAxis.max,
      interval: xAxis.interval,
      nameTextStyle: frame.axisName,
      axisLabel: frame.axisLabel(compactTokenAxisValue),
      axisLine: frame.axisLine,
      axisTick: frame.axisTick,
      splitLine: frame.splitLine,
    },
    yAxis: {
      type: "value",
      name: plotHeight < 140 ? "Cost per task" : "Cost per accepted task",
      nameLocation: "middle",
      nameGap: frame.yNameGap,
      min: 0,
      max: yAxis.max,
      interval: yAxis.interval,
      nameTextStyle: frame.axisName,
      axisLabel: frame.axisLabel(formatAxisMoney),
      axisLine: frame.axisLine,
      axisTick: frame.axisTick,
      splitLine: frame.splitLine,
    },
    series: [
      {
        id: "observations",
        name: "Observed cohort",
        type: "scatter",
        data: drawn.map((mark) => {
          const isSelected = mark.configurationID === selectedID
          return {
            name: mark.label,
            value: [mark.tokens, mark.amount],
            configurationID: mark.configurationID,
            ...(mark.groupID ? { groupID: mark.groupID } : {}),
            markKind: mark.kind === "reference" ? "reference" : "canonical",
            // Filled blue: on the best trade-off frontier. Hollow neutral: any other.
            symbol: "circle",
            symbolSize: isSelected ? 11 : 9,
            itemStyle: {
              color: mark.frontier ? theme.accent : background,
              borderColor: isSelected ? theme.text : mark.frontier ? theme.accent : neutral,
              borderWidth: isSelected ? 2 : 1.5,
            },
            label: {
              show: placed.has(mark.configurationID),
              formatter: labelText(mark),
              position: placed.get(mark.configurationID) ?? "right",
              distance: 6,
              color: isSelected ? theme.text : neutral,
              fontFamily: theme.fontFamily,
              fontSize,
              fontWeight: isSelected ? 500 : 400,
            },
          }
        }),
        emphasis: { focus: "self" },
        z: 3,
      },
      {
        id: "authoritative-frontier",
        name: "Observed frontier",
        type: "line",
        data: chartFrontierLine(marks),
        smooth: false,
        connectNulls: false,
        showSymbol: false,
        silent: true,
        z: 1,
        lineStyle: { color: theme.accent, width: 1.5, opacity: 0.75 },
        emphasis: { disabled: true },
        blur: { lineStyle: { opacity: 0.75 } },
      },
      {
        id: "selected-halo",
        name: "Selected model",
        type: "scatter",
        data: selected
          ? [
              {
                value: [selected.tokens, selected.amount],
                configurationID: selected.configurationID,
                markKind: "halo",
                symbol: "circle",
                symbolSize: 26,
                itemStyle: { color: theme.accent, opacity: 0.16, borderWidth: 0 },
              },
            ]
          : [],
        silent: true,
        tooltip: { show: false },
        z: 2,
      },
    ],
  } satisfies EChartsCoreOption
}

export type ChartOptionsBuilder<Data> = (
  data: Data,
  theme: ComparisonChartTheme,
  layout: ComparisonChartLayout,
) => EChartsCoreOption

/** Owns exactly one chart and all of its listeners/observers. */
export class ComparisonChartAdapter<Data = ComparisonChartData> {
  readonly chart: EChartsType
  private observer?: ResizeObserver
  private active = true
  private data?: Data
  private theme?: ComparisonChartTheme
  private appliedLayout?: string
  private focused?: string
  private readonly click = (parameters: { data?: unknown }) => {
    if (!this.active || typeof parameters.data !== "object" || parameters.data === null) return
    if (!("configurationID" in parameters.data)) return
    const configurationID = (parameters.data as { configurationID?: unknown }).configurationID
    if (typeof configurationID === "string") this.onSelect(configurationID)
  }
  private readonly windowResize = () => this.resize()

  constructor(
    readonly host: HTMLElement,
    private readonly onSelect: (configurationID: string) => void,
    private readonly buildOptions: ChartOptionsBuilder<Data> = comparisonChartOptions as unknown as ChartOptionsBuilder<Data>,
  ) {
    this.chart = echarts.init(host, undefined, { renderer: "svg" })
    this.chart.on("click", this.click)
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.resize())
      this.observer.observe(host)
    }
    host.ownerDocument.defaultView?.addEventListener("resize", this.windowResize)
  }

  get disposed() {
    return !this.active
  }

  update(data: Data, theme: ComparisonChartTheme) {
    if (!this.active) return false
    this.data = data
    this.theme = theme
    this.appliedLayout = undefined
    this.resize()
    return true
  }

  resize() {
    if (!this.active) return false
    const bounds = this.host.getBoundingClientRect()
    const width = this.host.clientWidth || bounds.width
    const height = this.host.clientHeight || bounds.height
    if (width <= 0 || height <= 0) return false
    if (this.data && this.theme) {
      const styles = this.host.ownerDocument.defaultView?.getComputedStyle(this.host)
      const computedFontSize = Number.parseFloat(styles?.fontSize ?? "")
      const fontSize =
        Number.isFinite(computedFontSize) && computedFontSize > 0
          ? computedFontSize
          : (this.theme.fontSize ?? 12)
      const layout = comparisonChartResponsiveLayout(width, height, fontSize)
      const key = [layout.width, layout.height, layout.fontSize].join(":")
      if (key !== this.appliedLayout) {
        this.chart.setOption(this.buildOptions(this.data, this.theme, layout), {
          notMerge: true,
        })
        this.appliedLayout = key
      }
    }
    this.chart.resize({ width, height })
    // Rebuilt options drop the visible tooltip; restore the keyboard-focused one.
    if (this.focused && this.appliedLayout) this.showFocusedTip()
    return true
  }

  /** Show the tooltip for a keyboard-focused model, or hide it with undefined. */
  focus(configurationID: string | undefined) {
    if (!this.active) return
    this.focused = configurationID
    if (configurationID && this.appliedLayout) this.showFocusedTip()
    else if (!configurationID) this.chart.dispatchAction({ type: "hideTip" })
  }

  private showFocusedTip() {
    const series =
      (this.chart.getOption() as { series?: Array<{ id?: string; data?: unknown[] }> }).series ?? []
    for (const [seriesIndex, item] of series.entries()) {
      if (
        item.id === "selected-halo" ||
        item.id === "authoritative-frontier" ||
        item.id === "benchmark-frontier"
      )
        continue
      const dataIndex = (item.data ?? []).findIndex(
        (datum) =>
          typeof datum === "object" &&
          datum !== null &&
          (datum as { configurationID?: unknown }).configurationID === this.focused,
      )
      if (dataIndex < 0) continue
      this.chart.dispatchAction({ type: "showTip", seriesIndex, dataIndex })
      return
    }
    this.chart.dispatchAction({ type: "hideTip" })
  }

  dispose() {
    if (!this.active) return
    this.active = false
    this.observer?.disconnect()
    this.observer = undefined
    this.host.ownerDocument.defaultView?.removeEventListener("resize", this.windowResize)
    this.chart.off("click", this.click)
    this.chart.dispose()
    this.data = undefined
    this.theme = undefined
    this.appliedLayout = undefined
    this.focused = undefined
  }
}

/** Next index for arrow, Home and End travel through an ordered set of chart marks. */
export function chartKeyStep(length: number, current: number, key: string) {
  if (!length) return undefined
  if (key === "Home") return 0
  if (key === "End") return length - 1
  if (key === "ArrowRight" || key === "ArrowDown")
    return current < 0 ? 0 : Math.min(length - 1, current + 1)
  if (key === "ArrowLeft" || key === "ArrowUp") return Math.max(0, current - 1)
  return undefined
}

export const visuallyHidden = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: "0",
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  "white-space": "nowrap",
  border: "0",
} as const

export function ComparisonChart(props: ComparisonChartProps) {
  let host: HTMLDivElement | undefined
  let adapter: ComparisonChartAdapter | undefined
  const descriptionID = createUniqueId()
  const currentTheme = () =>
    props.theme ??
    (host
      ? resolveNativeComparisonChartTheme(host, props.fontFamily, props.monoFontFamily)
      : undefined)
  const chartChoices = () => {
    const choices = new Map<
      string,
      { point?: ComparisonChartPoint; reference?: ComparisonChartReference }
    >()
    for (const reference of props.references ?? []) {
      const current = choices.get(reference.configurationID) ?? {}
      choices.set(reference.configurationID, { ...current, reference })
    }
    for (const point of props.points) {
      const current = choices.get(point.configurationID) ?? {}
      choices.set(point.configurationID, { ...current, point })
    }
    return [...choices.entries()]
  }
  const marks = () =>
    comparisonChartMarks({
      points: props.points,
      references: props.references,
      frontierConfigurationIDs: props.frontierConfigurationIDs,
    })
  const hasFrontierPoint = () => marks().some((mark) => mark.frontier)
  const hasOtherMark = () => marks().some((mark) => !mark.frontier)

  createEffect(() => {
    // Subscribe before onMount supplies the non-reactive adapter. Reading props only
    // inside the adapter branch would miss every later data-only update.
    void props.appearanceVersion
    const data: ComparisonChartData = {
      points: props.points,
      references: props.references,
      frontierConfigurationIDs: props.frontierConfigurationIDs,
      selectedConfigurationID: props.selectedConfigurationID,
    }
    const theme = currentTheme()
    if (adapter && theme) adapter.update(data, theme)
  })
  onMount(() => {
    if (!host) return
    adapter = new ComparisonChartAdapter(host, (configurationID) => props.onSelect(configurationID))
    const theme = currentTheme()
    if (theme) adapter.update(props, theme)
  })
  onCleanup(() => {
    adapter?.dispose()
    adapter = undefined
  })

  // The table lives in the selected-model disclosures once that pane has a mount for it.
  let dataSlot: HTMLElement | undefined
  let dataDetails: HTMLElement | undefined
  createEffect(() => {
    const target = props.dataMount?.() ?? dataSlot
    if (target && dataDetails && dataDetails.parentNode !== target) target.append(dataDetails)
  })
  onCleanup(() => dataDetails?.remove())
  const empty = () => !comparisonChartHasPlottablePoints(props.points, props.references ?? [])
  const keyboardOrder = () => comparisonChartKeyboardOrder(props.points, props.references ?? [])
  const [announcement, setAnnouncement] = createSignal("")
  const focusChoice = (choice: { configurationID: string; label: string } | undefined) => {
    adapter?.focus(choice?.configurationID)
    setAnnouncement(choice?.label ?? "")
  }
  const keyDown = (event: KeyboardEvent) => {
    const order = keyboardOrder()
    if (event.key === "Escape") {
      focusChoice(undefined)
      return
    }
    if (!order.length) return
    const next = chartKeyStep(
      order.length,
      order.findIndex((choice) => choice.configurationID === props.selectedConfigurationID),
      event.key,
    )
    if (next === undefined) return
    event.preventDefault()
    const choice = order[next]!
    focusChoice(choice)
    if (choice.configurationID !== props.selectedConfigurationID)
      props.onSelect(choice.configurationID)
  }

  return (
    <div
      class="lazers-models-comparison-chart"
      data-empty={empty()}
      style={{ width: "100%", "min-width": "0" }}
    >
      <div
        class="lazers-models-comparison-chart-plot"
        role="group"
        aria-roledescription="chart"
        aria-label="Model cost chart. Arrow keys move between models; Escape hides the tooltip."
        tabIndex={empty() ? -1 : 0}
        onKeyDown={keyDown}
        onFocus={() =>
          focusChoice(
            keyboardOrder().find(
              (choice) => choice.configurationID === props.selectedConfigurationID,
            ),
          )
        }
        onBlur={() => focusChoice(undefined)}
        style={{ width: "100%", "min-width": "0" }}
      >
        <div
          ref={(element) => {
            host = element
          }}
          role="img"
          aria-label="Cost per accepted task against tokens per accepted task"
          aria-describedby={descriptionID}
          style={{
            width: "100%",
            height: "100%",
            "min-height": "0",
            overflow: "hidden",
            "font-family": "inherit",
          }}
        />
      </div>
      <Show when={empty()}>
        <p class="lazers-models-chart-empty" role="status">
          {comparisonChartEmptyText(props.points, props.references ?? [])}
        </p>
        {props.emptyAction}
      </Show>
      <p id={descriptionID} style={visuallyHidden}>
        {comparisonChartDescription(props.points, props.references ?? [])}
      </p>
      <p aria-live="polite" style={visuallyHidden}>
        {announcement()}
      </p>
      <div class="lazers-models-chart-foot" hidden={empty()}>
        <ul class="lazers-models-comparison-chart-legend" aria-label="Chart mark legend">
          <Show when={hasFrontierPoint()}>
            <li>
              <span
                class="lazers-models-chart-key lazers-models-chart-key-frontier"
                aria-hidden="true"
              />
              Best trade-off
            </li>
          </Show>
          <Show when={hasOtherMark()}>
            <li>
              <span
                class="lazers-models-chart-key lazers-models-chart-key-canonical"
                aria-hidden="true"
              />
              Other
            </li>
          </Show>
        </ul>
        <Show when={props.caption}>
          <p class="lazers-models-chart-caption">{props.caption}</p>
        </Show>
      </div>
      <div
        class="lazers-models-chart-data-slot"
        ref={(element) => {
          dataSlot = element
        }}
      >
        <details
          class="lazers-models-disclosure lazers-models-comparison-chart-data"
          ref={(element) => {
            dataDetails = element
          }}
        >
          <summary>
            <span>Chart data as a table</span>
            <span class="lazers-models-disclosure-hint">{chartChoices().length} models</span>
          </summary>
          <ul>
            <For each={chartChoices()}>
              {([configurationID, choice]) => {
                const descriptions = [
                  ...(choice.point ? [comparisonChartPointText(choice.point)] : []),
                  ...(choice.reference ? [comparisonChartReferenceText(choice.reference)] : []),
                  ...(choice.reference && !referenceIsPlottable(choice.reference)
                    ? [
                        "Not plotted: a numeric actual token coordinate or per-task amount is missing.",
                      ]
                    : []),
                ]
                const text = descriptions.join(" ")
                const visible = comparisonChartChoiceSummary(choice)
                return (
                  <li>
                    <button
                      type="button"
                      data-configuration-id={configurationID}
                      aria-pressed={props.selectedConfigurationID === configurationID}
                      aria-label={`Select ${text}`}
                      title={text}
                      onClick={() => props.onSelect(configurationID)}
                    >
                      {visible}
                    </button>
                  </li>
                )
              }}
            </For>
          </ul>
        </details>
      </div>
    </div>
  )
}
