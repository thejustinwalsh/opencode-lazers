import { CustomChart, LineChart, ScatterChart } from "echarts/charts"
import type { CustomSeriesOption } from "echarts/charts"
import { AriaComponent, GridComponent, TooltipComponent } from "echarts/components"
import * as echarts from "echarts/core"
import type { EChartsCoreOption, EChartsType } from "echarts/core"
import { LabelLayout } from "echarts/features"
import { SVGRenderer } from "echarts/renderers"
import { For, Show, createEffect, createSignal, createUniqueId, onCleanup, onMount } from "solid-js"
import type { JSX } from "solid-js"
import type { ModelDecisionGraphPoint } from "./decision-contract.ts"
import type { ModelDecisionReferenceEstimate } from "./reference-estimate.ts"
import {
  boundedModelEffortLabel,
  chartModelEffortLabel,
  formatMarketAmount,
  formatMarketRange,
  modelEffortLabel,
  routeLabel,
} from "./comparison-presentation.ts"

echarts.use([
  ScatterChart,
  CustomChart,
  LineChart,
  GridComponent,
  TooltipComponent,
  AriaComponent,
  LabelLayout,
  SVGRenderer,
])

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

/** Reserve axis room from the rendered host size and inherited native font. */
export function comparisonChartResponsiveLayout(
  width: number,
  height: number,
  inheritedFontSize = 12,
): ComparisonChartLayout {
  const safeWidth = Math.max(1, width)
  const safeHeight = Math.max(1, height)
  const fontSize = clamp(Number.isFinite(inheritedFontSize) ? inheritedFontSize : 12, 10, 24)
  const grid = {
    left: Math.max(72, Math.ceil(24 + fontSize * 6.3)),
    right: Math.max(12, Math.ceil(fontSize * 0.8)),
    top: Math.max(20, Math.ceil(5 + fontSize * 1.4)),
    bottom: Math.max(48, Math.ceil(22 + fontSize * 2.1)),
    containLabel: false as const,
  }
  const plotWidth = Math.max(1, safeWidth - grid.left - grid.right)
  const plotHeight = Math.max(1, safeHeight - grid.top - grid.bottom)
  return {
    width: safeWidth,
    height: safeHeight,
    fontSize,
    grid,
    xSplitNumber: clamp(Math.floor(plotWidth / (fontSize * 4.4)), 2, 8),
    // Below ~420 px the y labels would collide, so keep at most three.
    ySplitNumber: clamp(Math.floor(plotHeight / (fontSize * 2.5)), 2, safeWidth < 420 ? 3 : 6),
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
    accent: styles ? nativeToken(styles, "--border-selected", "currentColor") : "currentColor",
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

function intervalRenderer(
  theme: ComparisonChartTheme,
  subtotal: boolean,
  selectedConfigurationIDs: readonly string[],
  selectedConfigurationID: string | null | undefined,
) {
  const renderer: NonNullable<CustomSeriesOption["renderItem"]> = (params, api) => {
    const x = Number(api.value(0))
    const minimum = Number(api.value(1))
    const maximum = Number(api.value(2))
    const selected = selectedConfigurationIDs[params.dataIndexInside] === selectedConfigurationID
    const lower = api.coord([x, minimum])
    const upper = api.coord([x, maximum])
    const middle = api.coord([x, minimum / 2 + maximum / 2])
    const cap = 5
    const style = {
      stroke: theme.accent,
      lineWidth: selected ? 3.5 : 2,
      ...(subtotal ? { lineDash: [4, 3], opacity: 0.8 } : {}),
    }
    const children = [
      {
        type: "line" as const,
        shape: { x1: lower[0]!, y1: lower[1]!, x2: upper[0]!, y2: upper[1]! },
        style,
      },
      {
        type: "line" as const,
        shape: {
          x1: lower[0]! - cap,
          y1: lower[1]!,
          x2: lower[0]! + cap,
          y2: lower[1]!,
        },
        style,
      },
      ...(selected
        ? [
            {
              type: "circle" as const,
              shape: { cx: middle[0]!, cy: middle[1]!, r: 4 },
              style: { fill: theme.surface, stroke: theme.text, lineWidth: 2 },
            },
          ]
        : []),
      {
        type: "line" as const,
        shape: {
          x1: upper[0]! - cap,
          y1: upper[1]!,
          x2: upper[0]! + cap,
          y2: upper[1]!,
        },
        style,
      },
    ]
    return {
      type: "group",
      children,
    }
  }
  return renderer
}

export type ChartLabelItem = {
  id: string
  x: number
  y: number
  /** Possibly two lines, separated by a newline. */
  text: string
  side: "left" | "right" | "top"
  /** 0 selected, 1 frontier, 2 the rest. */
  priority: number
  /** Provider and model, so one model is never named twice beside the selection. */
  model: string
}

/**
 * Which point labels fit. Keeps the selected label first, then frontier points, then the rest,
 * and drops any label that would overlap one already kept or repeat the selected model's name.
 * Positions are estimated from the value extents; tooltips and the data table name the rest.
 */
export function visibleChartLabelIDs(
  items: readonly ChartLabelItem[],
  box: { plotWidth: number; plotHeight: number; xMax: number; yMax: number; fontSize: number },
) {
  const kept: { left: number; right: number; top: number; bottom: number }[] = []
  const shown = new Set<string>()
  const selected = items.find((item) => item.priority === 0)
  const ordered = items.toSorted((left, right) => left.priority - right.priority)
  for (const item of ordered) {
    if (item.priority > 0 && selected && item.model === selected.model) continue
    const lines = item.text.split("\n")
    const width = Math.max(...lines.map((line) => line.length)) * box.fontSize * 0.6
    const height = lines.length * box.fontSize * 1.3
    const cx = box.xMax > 0 ? (item.x / box.xMax) * box.plotWidth : 0
    const cy = box.yMax > 0 ? box.plotHeight - (item.y / box.yMax) * box.plotHeight : 0
    const left =
      item.side === "right" ? cx + 8 : item.side === "left" ? cx - 8 - width : cx - width / 2
    const top = item.side === "top" ? cy - 6 - height : cy - height / 2
    const rect = { left, right: left + width, top, bottom: top + height }
    const clash = kept.some(
      (other) =>
        rect.left < other.right + 2 &&
        rect.right > other.left - 2 &&
        rect.top < other.bottom + 2 &&
        rect.bottom > other.top - 2,
    )
    if (clash) continue
    kept.push(rect)
    shown.add(item.id)
  }
  return shown
}

/** The frontier line carries no text; the legend names it "Best trade-off". */
export function frontierEndLabel(
  _text: string,
  _show: boolean,
  theme: ComparisonChartTheme,
  fontSize: number,
) {
  return {
    show: false,
    formatter: "",
    position: "top" as const,
    align: "right" as const,
    verticalAlign: "bottom" as const,
    distance: 6,
    color: theme.mutedText,
    fontFamily: theme.fontFamily,
    fontSize,
  }
}

export function comparisonChartOptions(
  data: ComparisonChartData,
  theme: ComparisonChartTheme,
  layout = comparisonChartResponsiveLayout(700, 300, theme.fontSize ?? 12),
) {
  const points = data.points.filter(plottable)
  const references = data.references ?? []
  type ReferenceMark = {
    reference: ComparisonChartReference
    amount: ReferenceAmount
    tokens: number
  }
  const referenceMarks: ReferenceMark[] = references.flatMap((reference) => {
    const amount = referenceAmount(reference.estimate)
    if (!referenceIsPlottable(reference) || !amount || reference.tokensPerAcceptedTask === null)
      return []
    return [{ reference, amount, tokens: reference.tokensPerAcceptedTask }]
  })
  const scalarReferences = referenceMarks.filter(
    (item): item is ReferenceMark & { amount: Extract<ReferenceAmount, { kind: "scalar" }> } =>
      item.amount.kind === "scalar",
  )
  const subtotalReferences = referenceMarks.filter(
    (item): item is ReferenceMark & { amount: Extract<ReferenceAmount, { kind: "subtotal" }> } =>
      item.amount.kind === "subtotal",
  )
  const rangeReferences = referenceMarks.filter(
    (item): item is ReferenceMark & { amount: Extract<ReferenceAmount, { kind: "range" }> } =>
      item.amount.kind === "range",
  )
  const subtotalRangeReferences = referenceMarks.filter(
    (
      item,
    ): item is ReferenceMark & { amount: Extract<ReferenceAmount, { kind: "subtotal-range" }> } =>
      item.amount.kind === "subtotal-range",
  )
  const frontier = new Set(data.frontierConfigurationIDs)
  const largestTokenValue = Math.max(
    0,
    ...points.map((point) => point.tokensPerAcceptedTask),
    ...referenceMarks.map((item) => item.tokens),
  )
  const frontierPoints = points
    .filter((point) => frontier.has(point.configurationID))
    .toSorted(
      (left, right) =>
        left.tokensPerAcceptedTask - right.tokensPerAcceptedTask ||
        left.currentMarketUSDPerAcceptedTask - right.currentMarketUSDPerAcceptedTask ||
        (left.configurationID < right.configurationID
          ? -1
          : left.configurationID > right.configurationID
            ? 1
            : 0),
    )
  const description = comparisonChartDescription(points, references)
  const referenceByConfiguration = new Map(
    referenceMarks.map((item) => [item.reference.configurationID, item.reference]),
  )
  const selectedLabels = new Map<
    string,
    {
      configurationID: string
      label: string
      route?: { providerID: string; modelID: string; variant?: string | null }
      tokens: number
      amount: number
    }
  >()
  if (data.selectedConfigurationID) {
    for (const point of points) {
      if (point.configurationID !== data.selectedConfigurationID) continue
      const key = `${point.configurationID}\u0000${point.tokensPerAcceptedTask}\u0000${point.currentMarketUSDPerAcceptedTask}`
      selectedLabels.set(key, {
        configurationID: point.configurationID,
        label: point.label,
        route: point.route,
        tokens: point.tokensPerAcceptedTask,
        amount: point.currentMarketUSDPerAcceptedTask,
      })
    }
    for (const item of referenceMarks) {
      if (item.reference.configurationID !== data.selectedConfigurationID) continue
      const amount =
        item.amount.kind === "scalar" || item.amount.kind === "subtotal"
          ? item.amount.value
          : item.amount.minimum / 2 + item.amount.maximum / 2
      const key = `${item.reference.configurationID}\u0000${item.tokens}\u0000${amount}`
      selectedLabels.set(key, {
        configurationID: item.reference.configurationID,
        label: item.reference.label,
        route: item.reference.estimate.route,
        tokens: item.tokens,
        amount,
      })
    }
  }
  const selectedLabelData = [...selectedLabels.values()]
  const labelPosition = (tokensValue: number) =>
    largestTokenValue > 0 && tokensValue >= largestTokenValue * 0.68 ? "left" : "right"
  const selectedLabelAlignment = (tokensValue: number) => {
    if (largestTokenValue <= 0) return "center" as const
    const relativePosition = tokensValue / largestTokenValue
    if (relativePosition <= 0.32) return "left" as const
    if (relativePosition >= 0.68) return "right" as const
    return "center" as const
  }
  const fontSize = layout.fontSize
  const plotWidth = Math.max(1, layout.width - layout.grid.left - layout.grid.right)
  const labelLimit = clamp(Math.floor(plotWidth / (fontSize * 0.66)), 8, 18)
  const roomForAllLabels = plotWidth >= fontSize * 22
  const labelItems: ChartLabelItem[] = points.map((point) => ({
    id: point.configurationID,
    x: point.tokensPerAcceptedTask,
    y: point.currentMarketUSDPerAcceptedTask,
    text: chartModelEffortLabel(point.label, point.route, labelLimit),
    side: labelPosition(point.tokensPerAcceptedTask),
    priority:
      point.configurationID === data.selectedConfigurationID
        ? 0
        : frontier.has(point.configurationID)
          ? 1
          : 2,
    model: point.route ? `${point.route.providerID}/${point.route.modelID}` : point.configurationID,
  }))
  const visibleLabels = visibleChartLabelIDs(labelItems, {
    plotWidth,
    plotHeight: Math.max(1, layout.height - layout.grid.top - layout.grid.bottom),
    xMax: largestTokenValue * 1.1,
    yMax: Math.max(0, ...points.map((point) => point.currentMarketUSDPerAcceptedTask)) * 1.1,
    fontSize,
  })
  const boundedSelectedLabels = selectedLabelData.map((item) => ({
    ...item,
    alignment: selectedLabelAlignment(item.tokens),
    visibleLabel: chartModelEffortLabel(item.label, item.route, labelLimit),
  }))
  const axisTitleFontSize = Math.min(
    fontSize,
    layout.width < 400 ? 12 : layout.width < 600 ? 16 : 20,
  )
  const compactYAxisName = layout.height < 240 || (layout.height < 280 && fontSize >= 18)

  return {
    animation: false,
    backgroundColor: theme.surface,
    textStyle: { fontFamily: theme.fontFamily, color: theme.text },
    aria: { enabled: true, description, decal: { show: false } },
    grid: layout.grid,
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
      name: "Tokens / accepted task",
      nameLocation: "middle",
      nameGap: Math.ceil(axisTitleFontSize * 2.1),
      min: 0,
      splitNumber: layout.xSplitNumber,
      nameTextStyle: {
        color: theme.mutedText,
        fontFamily: theme.fontFamily,
        fontSize: axisTitleFontSize,
      },
      axisLabel: {
        color: theme.mutedText,
        fontFamily: theme.monoFontFamily,
        fontSize,
        margin: Math.max(4, Math.ceil(fontSize * 0.4)),
        hideOverlap: true,
        formatter: compactTokenAxisValue,
      },
      axisLine: { lineStyle: { color: theme.grid } },
      splitLine: { lineStyle: { color: theme.grid, opacity: 0.35 } },
    },
    yAxis: {
      type: "value",
      name: compactYAxisName ? "USD / task" : "USD / accepted task",
      nameLocation: "middle",
      nameGap: Math.max(4, Math.ceil(axisTitleFontSize * 0.65)),
      min: 0,
      splitNumber: layout.ySplitNumber,
      nameTextStyle: {
        color: theme.mutedText,
        fontFamily: theme.fontFamily,
        fontSize: axisTitleFontSize,
      },
      axisLabel: {
        color: theme.mutedText,
        fontFamily: theme.monoFontFamily,
        fontSize,
        margin: Math.max(4, Math.ceil(fontSize * 0.4)),
        hideOverlap: true,
        formatter: formatMarketAmount,
      },
      axisLine: { lineStyle: { color: theme.grid } },
      splitLine: { lineStyle: { color: theme.grid, opacity: 0.35 } },
    },
    series: [
      {
        id: "observations",
        name: "Observed cohort",
        type: "scatter",
        data: points.map((point) => {
          const selected = point.configurationID === data.selectedConfigurationID
          return {
            name: point.label,
            value: [point.tokensPerAcceptedTask, point.currentMarketUSDPerAcceptedTask],
            configurationID: point.configurationID,
            groupID: point.groupID,
            markKind: "canonical",
            symbol: frontier.has(point.configurationID) ? "diamond" : "circle",
            symbolSize: selected ? 14 : 10,
            itemStyle: {
              color: selected ? theme.accent : theme.text,
              borderColor: selected ? theme.text : theme.accent,
              borderWidth: selected ? 2 : 1,
              ...(selected ? { shadowBlur: 12, shadowColor: theme.accent } : {}),
            },
            label: {
              // Narrow plots keep only frontier labels; the rest stay on tooltip and keyboard.
              show:
                !selected &&
                visibleLabels.has(point.configurationID) &&
                (roomForAllLabels || frontier.has(point.configurationID)),
              formatter: chartModelEffortLabel(point.label, point.route, labelLimit),
              position: labelPosition(point.tokensPerAcceptedTask),
              color: selected ? theme.text : theme.mutedText,
              fontFamily: theme.fontFamily,
              fontSize,
              fontWeight: selected ? 600 : 400,
            },
          }
        }),
        emphasis: { focus: "self" },
        labelLayout: { hideOverlap: true, moveOverlap: "shiftY" },
      },
      {
        id: "authoritative-frontier",
        name: "Observed frontier",
        type: "line",
        data:
          frontierPoints.length > 1
            ? frontierPoints.map((point) => [
                point.tokensPerAcceptedTask,
                point.currentMarketUSDPerAcceptedTask,
              ])
            : [],
        smooth: false,
        connectNulls: false,
        showSymbol: false,
        silent: true,
        z: 1,
        lineStyle: { color: theme.accent, width: 2, type: "dashed" },
        emphasis: { disabled: true },
        blur: { lineStyle: { opacity: 1 }, endLabel: { opacity: 1 } },
        endLabel: frontierEndLabel("Observed frontier", frontierPoints.length > 1, theme, fontSize),
      },
      {
        id: "openrouter-reference-scalars",
        name: "OpenRouter model catalog scalar reference",
        type: "scatter",
        data: scalarReferences.map(({ reference, amount, tokens: tokenCount }) => ({
          name: reference.label,
          value: [tokenCount, amount.value],
          configurationID: reference.configurationID,
          markKind: "reference",
          symbol: "triangle",
          symbolSize: reference.configurationID === data.selectedConfigurationID ? 18 : 12,
          itemStyle: {
            color: theme.accent,
            borderColor: theme.text,
            borderWidth: reference.configurationID === data.selectedConfigurationID ? 3 : 1,
          },
        })),
        emphasis: { focus: "self" },
      },
      {
        id: "openrouter-reference-subtotals",
        name: "Priced subtotal · total unknown",
        type: "scatter",
        data: subtotalReferences.map(({ reference, amount, tokens: tokenCount }) => ({
          name: reference.label,
          value: [tokenCount, amount.value],
          configurationID: reference.configurationID,
          markKind: "reference",
          symbol: "diamond",
          symbolSize: reference.configurationID === data.selectedConfigurationID ? 18 : 12,
          itemStyle: {
            color: theme.surface,
            borderColor: theme.accent,
            borderWidth: reference.configurationID === data.selectedConfigurationID ? 3 : 2,
          },
        })),
        emphasis: { focus: "self" },
      },
      {
        id: "openrouter-conditional-ranges",
        name: "Conditional range",
        type: "custom",
        renderItem: intervalRenderer(
          theme,
          false,
          rangeReferences.map(({ reference }) => reference.configurationID),
          data.selectedConfigurationID,
        ),
        data: rangeReferences.map(({ reference, amount, tokens: tokenCount }) => ({
          name: reference.label,
          value: [tokenCount, amount.minimum, amount.maximum],
          configurationID: reference.configurationID,
          markKind: "reference",
        })),
        encode: { x: 0, y: [1, 2] },
        z: 6,
      },
      {
        id: "openrouter-subtotal-ranges",
        name: "Priced subtotal range · total unknown",
        type: "custom",
        renderItem: intervalRenderer(
          theme,
          true,
          subtotalRangeReferences.map(({ reference }) => reference.configurationID),
          data.selectedConfigurationID,
        ),
        data: subtotalRangeReferences.map(({ reference, amount, tokens: tokenCount }) => ({
          name: reference.label,
          value: [tokenCount, amount.minimum, amount.maximum],
          configurationID: reference.configurationID,
          markKind: "reference",
        })),
        encode: { x: 0, y: [1, 2] },
        z: 6,
      },
      {
        id: "selected-identities",
        name: "Selected model identity",
        type: "scatter",
        data: boundedSelectedLabels.map((item) => ({
          name: modelEffortLabel(item.label, item.route),
          value: [item.tokens, item.amount],
          configurationID: item.configurationID,
          markKind: "selected-identity",
          symbol: "circle",
          symbolSize: 1,
          itemStyle: { color: theme.surface, borderWidth: 0 },
          label: {
            show: true,
            formatter: item.visibleLabel,
            position: "top",
            align: item.alignment,
            distance: 6,
          },
        })),
        silent: true,
        tooltip: { show: false },
        z: 20,
        label: {
          show: true,
          formatter: (parameters: { name?: string }) =>
            boundedModelEffortLabel(parameters.name ?? "Selected model", labelLimit),
          color: theme.text,
          fontFamily: theme.fontFamily,
          fontSize,
          fontWeight: 700,
        },
        labelLayout: ({ labelRect }: { labelRect: { x: number; width: number } }) => {
          const plotLeft = layout.grid.left + 1
          const plotRight = layout.width - layout.grid.right - 1
          const dx =
            labelRect.x < plotLeft
              ? plotLeft - labelRect.x
              : labelRect.x + labelRect.width > plotRight
                ? plotRight - labelRect.x - labelRect.width
                : 0
          return { dx, moveOverlap: "shiftY", hideOverlap: false }
        },
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
        item.id === "selected-identities" ||
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
  const hasFrontierPoint = () =>
    props.points.some((point) => props.frontierConfigurationIDs.includes(point.configurationID))
  const hasOtherMark = () =>
    props.points.some(
      (point) =>
        plottable(point) && !props.frontierConfigurationIDs.includes(point.configurationID),
    ) || (props.references ?? []).some(referenceIsPlottable)

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
      <ul
        class="lazers-models-comparison-chart-legend"
        aria-label="Chart mark legend"
        hidden={empty()}
      >
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
