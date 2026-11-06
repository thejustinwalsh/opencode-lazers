import { CustomChart, LineChart, ScatterChart } from "echarts/charts"
import type { CustomSeriesOption } from "echarts/charts"
import { AriaComponent, GridComponent, TooltipComponent } from "echarts/components"
import * as echarts from "echarts/core"
import type { EChartsCoreOption, EChartsType } from "echarts/core"
import { LabelLayout } from "echarts/features"
import { SVGRenderer } from "echarts/renderers"
import { For, Show, createEffect, createUniqueId, onCleanup, onMount } from "solid-js"
import type { ModelDecisionGraphPoint } from "./decision-contract.ts"
import type { ModelDecisionReferenceEstimate } from "./reference-estimate.ts"
import {
  boundedModelLabel,
  formatMarketAmount,
  formatMarketRange,
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

export function compactTokenAxisValue(value: number) {
  return tokenAxis.format(value)
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
  }
}

export function comparisonChartPointText(point: ComparisonChartPoint) {
  const identity = point.route
    ? `exact route ${routeLabel(point.route)}`
    : `producer label ${point.label}; exact route metadata not present`
  const source =
    point.marketSource === "openrouter"
      ? "OpenRouter"
      : point.marketSource === "opencode"
        ? "OpenCode"
        : point.marketSource === "mixed"
          ? "configured price sources"
          : point.marketSource === "unavailable"
            ? "configured source not recorded"
            : "configured price source not supplied"
  const partial = point.partial ? "; partial cohort coverage" : ""
  return `${point.label} · ${identity}; ${tokens.format(point.tokensPerAcceptedTask)} actual tokens per accepted task; canonical current-market value ${money.format(point.currentMarketUSDPerAcceptedTask)} per accepted task (short display ${formatMarketAmount(point.currentMarketUSDPerAcceptedTask)}); ordered whole-model price-source valuation from ${source}; ${point.observationCount} observation${point.observationCount === 1 ? "" : "s"}; denominator ${point.acceptedTaskCount} accepted task${point.acceptedTaskCount === 1 ? "" : "s"}${partial}.`
}

function comparisonChartPointTooltip(point: ComparisonChartPoint) {
  return `${boundedModelLabel(point.label)} · ≈${formatMarketAmount(point.currentMarketUSDPerAcceptedTask)} / accepted task · ${compactTokenAxisValue(point.tokensPerAcceptedTask)} tokens${point.partial ? " · partial cohort" : ""}`
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
      ? `OpenRouter scalar reference ${money.format(amount.value)} per accepted task`
      : amount.kind === "range"
        ? `OpenRouter conditional range ${money.format(amount.minimum)}–${money.format(amount.maximum)} per accepted task`
        : amount.kind === "subtotal"
          ? `OpenRouter priced subtotal only ${money.format(amount.value)} per accepted task; total and remainder unknown`
          : `OpenRouter priced subtotal range only ${money.format(amount.minimum)}–${money.format(amount.maximum)} per accepted task; total and remainder unknown`
    : estimate.status === "zero-accepted"
      ? "no accepted-task denominator"
      : "no numeric per-task amount"
  const coordinate =
    reference.tokensPerAcceptedTask === null
      ? "Actual cohort token coordinate unknown"
      : `${tokens.format(reference.tokensPerAcceptedTask)} actual cohort tokens per accepted task`
  return `${reference.label} · exact route ${routeLabel(estimate.route)}: ${coordinate}; ${amountLabel}; basis OpenRouter published model-reference cost per accepted task; denominator ${estimate.acceptedTaskCount} accepted task${estimate.acceptedTaskCount === 1 ? "" : "s"}; OpenRouter source ${estimate.provenance.freshness}; actual route-specific task mix (not a common workload).`
}

function comparisonChartReferenceTooltip(reference: ComparisonChartReference) {
  const amount = referenceAmount(reference.estimate)
  if (!amount) return ""
  const value =
    amount.kind === "scalar" || amount.kind === "subtotal"
      ? formatMarketAmount(amount.value)
      : formatMarketRange({ minimum: amount.minimum, maximum: amount.maximum })
  const description =
    amount.kind === "scalar"
      ? "scalar reference"
      : amount.kind === "range"
        ? "conditional range"
        : amount.kind === "subtotal"
          ? "priced subtotal · total unknown"
          : "priced subtotal range · total unknown"
  return `OpenRouter · ${boundedModelLabel(reference.label)} · ≈${value}${amount.kind === "subtotal" || amount.kind === "subtotal-range" ? " priced portion" : ""} / accepted task · ${description}`
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
            `${unplottedReferences.length} OpenRouter reference estimate${unplottedReferences.length === 1 ? "" : "s"} are not plotted because a numeric actual cohort token coordinate or per-task amount is missing.`,
          ]
        : []),
    ].join(" ") || noPointDescription
  )
}

function intervalRenderer(theme: ComparisonChartTheme, subtotal: boolean) {
  const renderer: NonNullable<CustomSeriesOption["renderItem"]> = (_params, api) => {
    const x = Number(api.value(0))
    const minimum = Number(api.value(1))
    const maximum = Number(api.value(2))
    const lower = api.coord([x, minimum])
    const upper = api.coord([x, maximum])
    const cap = 5
    const style = {
      stroke: theme.accent,
      lineWidth: 2,
      ...(subtotal ? { lineDash: [4, 3], opacity: 0.8 } : {}),
    }
    return {
      type: "group",
      children: [
        {
          type: "line",
          shape: { x1: lower[0]!, y1: lower[1]!, x2: upper[0]!, y2: upper[1]! },
          style,
        },
        {
          type: "line",
          shape: {
            x1: lower[0]! - cap,
            y1: lower[1]!,
            x2: lower[0]! + cap,
            y2: lower[1]!,
          },
          style,
        },
        {
          type: "line",
          shape: {
            x1: upper[0]! - cap,
            y1: upper[1]!,
            x2: upper[0]! + cap,
            y2: upper[1]!,
          },
          style,
        },
      ],
    }
  }
  return renderer
}

export function comparisonChartOptions(data: ComparisonChartData, theme: ComparisonChartTheme) {
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
    .toSorted((left, right) => left.tokensPerAcceptedTask - right.tokensPerAcceptedTask)
  const description = comparisonChartDescription(points, references)
  const referenceByConfiguration = new Map(
    referenceMarks.map((item) => [item.reference.configurationID, item.reference]),
  )

  return {
    animation: false,
    backgroundColor: theme.surface,
    textStyle: { fontFamily: theme.fontFamily, color: theme.text },
    aria: { enabled: true, description, decal: { show: false } },
    grid: { left: 72, right: 14, top: 22, bottom: 44, containLabel: false },
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
      nameGap: 26,
      min: 0,
      nameTextStyle: { color: theme.mutedText, fontFamily: theme.fontFamily },
      axisLabel: {
        color: theme.mutedText,
        fontFamily: theme.monoFontFamily,
        formatter: compactTokenAxisValue,
      },
      axisLine: { lineStyle: { color: theme.grid } },
      splitLine: { lineStyle: { color: theme.grid, opacity: 0.35 } },
    },
    yAxis: {
      type: "value",
      name: "USD / accepted task",
      nameLocation: "middle",
      nameGap: 48,
      min: 0,
      nameTextStyle: { color: theme.mutedText, fontFamily: theme.fontFamily },
      axisLabel: {
        color: theme.mutedText,
        fontFamily: theme.monoFontFamily,
        formatter: (value: number) => money.format(value),
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
            },
            label: {
              show: true,
              formatter: boundedModelLabel(point.label, 18),
              position:
                largestTokenValue > 0 && point.tokensPerAcceptedTask >= largestTokenValue * 0.65
                  ? "left"
                  : "right",
              color: selected ? theme.text : theme.mutedText,
              fontFamily: theme.fontFamily,
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
        lineStyle: { color: theme.accent, width: 1.5, type: "dashed" },
      },
      {
        id: "openrouter-reference-scalars",
        name: "OpenRouter scalar reference",
        type: "scatter",
        data: scalarReferences.map(({ reference, amount, tokens: tokenCount }) => ({
          name: reference.label,
          value: [tokenCount, amount.value],
          configurationID: reference.configurationID,
          markKind: "reference",
          symbol: "triangle",
          symbolSize: 12,
          itemStyle: { color: theme.accent, borderColor: theme.text, borderWidth: 1 },
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
          symbolSize: 12,
          itemStyle: { color: theme.surface, borderColor: theme.accent, borderWidth: 2 },
        })),
        emphasis: { focus: "self" },
      },
      {
        id: "openrouter-conditional-ranges",
        name: "Conditional range",
        type: "custom",
        renderItem: intervalRenderer(theme, false),
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
        renderItem: intervalRenderer(theme, true),
        data: subtotalRangeReferences.map(({ reference, amount, tokens: tokenCount }) => ({
          name: reference.label,
          value: [tokenCount, amount.minimum, amount.maximum],
          configurationID: reference.configurationID,
          markKind: "reference",
        })),
        encode: { x: 0, y: [1, 2] },
        z: 6,
      },
    ],
  } satisfies EChartsCoreOption
}

/** Owns exactly one chart and all of its listeners/observers. */
export class ComparisonChartAdapter {
  readonly chart: EChartsType
  private observer?: ResizeObserver
  private active = true
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

  update(data: ComparisonChartData, theme: ComparisonChartTheme) {
    if (!this.active) return false
    this.chart.setOption(comparisonChartOptions(data, theme), { notMerge: true })
    this.resize()
    return true
  }

  resize() {
    if (!this.active) return false
    const bounds = this.host.getBoundingClientRect()
    const width = this.host.clientWidth || bounds.width
    const height = this.host.clientHeight || bounds.height
    if (width <= 0 || height <= 0) return false
    this.chart.resize({ width, height })
    return true
  }

  dispose() {
    if (!this.active) return
    this.active = false
    this.observer?.disconnect()
    this.observer = undefined
    this.host.ownerDocument.defaultView?.removeEventListener("resize", this.windowResize)
    this.chart.off("click", this.click)
    this.chart.dispose()
  }
}

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
  const hasSubtotal = () =>
    (props.references ?? []).some(
      (reference) =>
        referenceIsPlottable(reference) && referenceAmount(reference.estimate)?.kind === "subtotal",
    )
  const hasSubtotalRange = () =>
    (props.references ?? []).some(
      (reference) =>
        referenceIsPlottable(reference) &&
        referenceAmount(reference.estimate)?.kind === "subtotal-range",
    )

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

  return (
    <div class="lazers-models-comparison-chart" style={{ width: "100%", "min-width": "0" }}>
      <div
        ref={(element) => {
          host = element
        }}
        role="img"
        aria-label="Actual cohort tokens, canonical current-market observations, and OpenRouter reference costs per accepted task"
        aria-describedby={descriptionID}
        style={{
          width: "100%",
          height: "100%",
          "min-height": "0",
          overflow: "hidden",
          "font-family": "inherit",
        }}
      />
      <p
        id={descriptionID}
        style={{
          position: "absolute",
          width: "1px",
          height: "1px",
          padding: "0",
          margin: "-1px",
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          "white-space": "nowrap",
          border: "0",
        }}
      >
        {comparisonChartDescription(props.points, props.references ?? [])}
      </p>
      <ul class="lazers-models-comparison-chart-legend" aria-label="Chart mark legend">
        <Show when={props.points.some(plottable)}>
          <li>
            <span
              class="lazers-models-chart-key lazers-models-chart-key-canonical"
              aria-hidden="true"
            />
            Observed cohort
          </li>
        </Show>
        <Show when={hasFrontierPoint()}>
          <li>
            <span
              class="lazers-models-chart-key lazers-models-chart-key-frontier"
              aria-hidden="true"
            />
            Frontier
          </li>
        </Show>
        <Show
          when={(props.references ?? []).some(
            (reference) => reference.estimate.status === "exact" && referenceIsPlottable(reference),
          )}
        >
          <li>
            <span
              class="lazers-models-chart-key lazers-models-chart-key-reference"
              aria-hidden="true"
            />
            Scalar reference
          </li>
        </Show>
        <Show
          when={(props.references ?? []).some(
            (reference) =>
              reference.estimate.status === "conditional" && referenceIsPlottable(reference),
          )}
        >
          <li>
            <span
              class="lazers-models-chart-key lazers-models-chart-key-range"
              aria-hidden="true"
            />
            Conditional range
          </li>
        </Show>
        <Show when={hasSubtotal()}>
          <li>
            <span
              class="lazers-models-chart-key lazers-models-chart-key-subtotal"
              aria-hidden="true"
            />
            Priced subtotal · total unknown
          </li>
        </Show>
        <Show when={hasSubtotalRange()}>
          <li>
            <span
              class="lazers-models-chart-key lazers-models-chart-key-subtotal-range"
              aria-hidden="true"
            />
            Priced subtotal range · total unknown
          </li>
        </Show>
      </ul>
      <Show when={(props.references ?? []).some((reference) => !referenceIsPlottable(reference))}>
        <p class="lazers-models-chart-empty" role="note">
          Some references need numeric coordinates and amounts to appear here.
        </p>
      </Show>
      <details class="lazers-models-comparison-chart-data">
        <summary>Accessible chart data and point selection</summary>
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
              return (
                <li>
                  <button
                    type="button"
                    data-configuration-id={configurationID}
                    aria-pressed={props.selectedConfigurationID === configurationID}
                    aria-label={`Select ${text}`}
                    onClick={() => props.onSelect(configurationID)}
                  >
                    {text}
                  </button>
                </li>
              )
            }}
          </For>
        </ul>
      </details>
    </div>
  )
}
