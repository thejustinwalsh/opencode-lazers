import { LineChart, ScatterChart } from "echarts/charts"
import { AriaComponent, GridComponent, TooltipComponent } from "echarts/components"
import * as echarts from "echarts/core"
import type { EChartsCoreOption, EChartsType } from "echarts/core"
import { LabelLayout } from "echarts/features"
import { SVGRenderer } from "echarts/renderers"
import { For, createEffect, createUniqueId, onCleanup, onMount } from "solid-js"
import type { ModelDecisionGraphPoint } from "./decision-contract.ts"

echarts.use([
  ScatterChart,
  LineChart,
  GridComponent,
  TooltipComponent,
  AriaComponent,
  LabelLayout,
  SVGRenderer,
])

export type ComparisonChartPoint = ModelDecisionGraphPoint

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
  maximumFractionDigits: 6,
})
const tokens = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 })

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
  return `${point.label}: ${tokens.format(point.tokensPerAcceptedTask)} tokens per accepted task; ${money.format(point.currentMarketUSDPerAcceptedTask)} current market USD per accepted task; ${point.observationCount} observation${point.observationCount === 1 ? "" : "s"}; ${point.acceptedTaskCount} accepted.`
}

function tooltipText(point: ComparisonChartPoint) {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }
  return comparisonChartPointText(point).replace(/[&<>"']/g, (character) => entities[character]!)
}

function plottable(point: ComparisonChartPoint) {
  return (
    Number.isFinite(point.tokensPerAcceptedTask) &&
    point.tokensPerAcceptedTask >= 0 &&
    Number.isFinite(point.currentMarketUSDPerAcceptedTask) &&
    point.currentMarketUSDPerAcceptedTask >= 0
  )
}

export function comparisonChartOptions(data: ComparisonChartData, theme: ComparisonChartTheme) {
  const points = data.points.filter(plottable)
  const frontier = new Set(data.frontierConfigurationIDs)
  const frontierPoints = points
    .filter((point) => frontier.has(point.configurationID))
    .toSorted((left, right) => left.tokensPerAcceptedTask - right.tokensPerAcceptedTask)
  const description = points.length
    ? points.map(comparisonChartPointText).join(" ")
    : "No plottable observations. Unknown and zero-accepted configurations have no coordinates."

  return {
    animation: false,
    backgroundColor: theme.surface,
    textStyle: { fontFamily: theme.fontFamily, color: theme.text },
    aria: { enabled: true, description, decal: { show: false } },
    grid: { left: 76, right: 24, top: 28, bottom: 62, containLabel: false },
    tooltip: {
      trigger: "item",
      confine: true,
      formatter: (parameters: { data?: { configurationID?: string } }) => {
        const point = points.find(
          (candidate) => candidate.configurationID === parameters.data?.configurationID,
        )
        return point ? tooltipText(point) : ""
      },
    },
    xAxis: {
      type: "value",
      name: "Tokens / accepted task",
      nameLocation: "middle",
      nameGap: 40,
      min: 0,
      nameTextStyle: { color: theme.mutedText, fontFamily: theme.fontFamily },
      axisLabel: { color: theme.mutedText, fontFamily: theme.monoFontFamily },
      axisLine: { lineStyle: { color: theme.grid } },
      splitLine: { lineStyle: { color: theme.grid, opacity: 0.35 } },
    },
    yAxis: {
      type: "value",
      name: "Current market USD / accepted task",
      nameLocation: "middle",
      nameGap: 58,
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
        name: "Observed configurations",
        type: "scatter",
        data: points.map((point) => {
          const selected = point.configurationID === data.selectedConfigurationID
          return {
            name: point.label,
            value: [point.tokensPerAcceptedTask, point.currentMarketUSDPerAcceptedTask],
            configurationID: point.configurationID,
            groupID: point.groupID,
            symbol: frontier.has(point.configurationID) ? "diamond" : "circle",
            symbolSize: selected ? 14 : 10,
            itemStyle: {
              color: selected ? theme.accent : theme.text,
              borderColor: selected ? theme.text : theme.accent,
              borderWidth: selected ? 2 : 1,
            },
            label: {
              show: true,
              formatter: point.label,
              position: "right",
              color: selected ? theme.text : theme.mutedText,
              fontFamily: theme.fontFamily,
              fontWeight: selected ? 600 : 400,
            },
          }
        }),
        emphasis: { focus: "self" },
        labelLayout: { hideOverlap: true },
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

  createEffect(() => {
    // Subscribe before onMount supplies the non-reactive adapter. Reading props only
    // inside the adapter branch would miss every later data-only update.
    void props.appearanceVersion
    const data: ComparisonChartData = {
      points: props.points,
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
        aria-label="Observed model tokens and current market cost per accepted task"
        aria-describedby={descriptionID}
        style={{
          width: "100%",
          height: "100%",
          "min-height": "240px",
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
        {props.points.length
          ? props.points.map(comparisonChartPointText).join(" ")
          : "No plottable observations. Unknown and zero-accepted configurations have no coordinates."}
      </p>
      <details class="lazers-models-comparison-chart-data">
        <summary>Chart data and point selection</summary>
        <ul>
          <For each={props.points.filter(plottable)}>
            {(point) => (
              <li>
                <button
                  type="button"
                  data-configuration-id={point.configurationID}
                  aria-pressed={props.selectedConfigurationID === point.configurationID}
                  aria-label={`Select ${comparisonChartPointText(point)}`}
                  onClick={() => props.onSelect(point.configurationID)}
                >
                  {comparisonChartPointText(point)}
                </button>
              </li>
            )}
          </For>
        </ul>
      </details>
    </div>
  )
}
