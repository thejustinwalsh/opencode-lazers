import { For, Show, createEffect, createSignal, createUniqueId, onCleanup, onMount } from "solid-js"
import type { JSX } from "solid-js"
import { Portal } from "solid-js/web"
import type { EChartsCoreOption } from "echarts/core"
import { BENCHMARK_PRICE_MIX } from "./benchmark-baseline.ts"
import type { BenchmarkBaselineGap, BenchmarkBaselinePoint } from "./benchmark-baseline.ts"
import {
  ComparisonChartAdapter,
  chartKeyStep,
  frontierEndLabel,
  resolveNativeComparisonChartTheme,
  visuallyHidden,
} from "./comparison-chart.tsx"
import type { ComparisonChartLayout, ComparisonChartTheme } from "./comparison-chart.tsx"
import { boundedModelLabel, formatMarketAmount, routeLabel } from "./comparison-presentation.ts"

export type BenchmarkChartData = {
  points: readonly BenchmarkBaselinePoint[]
  selectedID?: string | null
}

const index = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })
const tokenCount = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })
const mix = `${BENCHMARK_PRICE_MIX.input} input : ${BENCHMARK_PRICE_MIX.output} output tokens`

export const benchmarkSourceName = {
  openrouter: "OpenRouter",
  opencode: "OpenCode",
} as const

/** Terse model · score · price shared by tooltip, keyboard announcement and Chart data. */
export function benchmarkPointTooltip(point: BenchmarkBaselinePoint) {
  return `${boundedModelLabel(point.label)} · Coding ${index.format(point.benchmark.codingIndex)} · ${formatMarketAmount(point.price.blended)} / 1M tokens`
}

/** Complete accessible description; names sources, units and the token mix. */
export function benchmarkPointText(point: BenchmarkBaselinePoint) {
  const price = point.price
  const tier = price.appliesBelowTokens
    ? `; base rate for prompts under ${tokenCount.format(price.appliesBelowTokens)} tokens`
    : ""
  return `${point.label} · exact route ${routeLabel(point.route)}: Artificial Analysis Coding Index ${index.format(point.benchmark.codingIndex)} for ${point.benchmark.displayName ?? point.benchmark.modelPermaslug}; ${benchmarkSourceName[price.source]} list price ${formatMarketAmount(price.input)} input and ${formatMarketAmount(price.output)} output per 1M tokens, ${formatMarketAmount(price.blended)} per 1M at ${mix}${tier}; ${point.observed ? "has observed task outcomes for these filters" : "no observed task outcomes for these filters"}.`
}

export function benchmarkGapText(gap: BenchmarkBaselineGap) {
  return gap.reason === "no-price"
    ? `${boundedModelLabel(gap.label)} · not plotted, no price`
    : `${boundedModelLabel(gap.label)} · not plotted, no Coding Index`
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

export function benchmarkChartOptions(
  data: BenchmarkChartData,
  theme: ComparisonChartTheme,
  layout: ComparisonChartLayout,
) {
  const fontSize = layout.fontSize
  const plotWidth = Math.max(1, layout.width - layout.grid.left - layout.grid.right)
  const roomForAllLabels = plotWidth >= fontSize * 22
  const labelLimit = Math.min(18, Math.max(8, Math.floor(plotWidth / (fontSize * 0.66))))
  const frontier = benchmarkFrontier(data.points)
  const frontierIDs = new Set(frontier.map((point) => point.id))
  const largest = Math.max(0, ...data.points.map((point) => point.price.blended))
  const narrowAxis = layout.width < 400 || layout.height < 240
  const axisTitleFontSize = Math.min(fontSize, layout.width < 400 ? 12 : 16)
  const axisText = {
    color: theme.mutedText,
    fontFamily: theme.fontFamily,
    fontSize: axisTitleFontSize,
  }
  const axisLabel = (formatter: (value: number) => string) => ({
    color: theme.mutedText,
    fontFamily: theme.monoFontFamily,
    fontSize,
    margin: Math.max(4, Math.ceil(fontSize * 0.4)),
    hideOverlap: true,
    formatter,
  })
  return {
    animation: false,
    backgroundColor: theme.surface,
    textStyle: { fontFamily: theme.fontFamily, color: theme.text },
    aria: {
      enabled: true,
      description: benchmarkDescription(data.points),
      decal: { show: false },
    },
    grid: layout.grid,
    tooltip: {
      trigger: "item",
      confine: true,
      formatter: (parameters: { data?: { configurationID?: string } }) => {
        const point = data.points.find((entry) => entry.id === parameters.data?.configurationID)
        return point
          ? benchmarkPointTooltip(point).replace(
              /[&<>"']/g,
              (character) => `&#${character.charCodeAt(0)};`,
            )
          : ""
      },
    },
    xAxis: {
      type: "value",
      name: narrowAxis
        ? "USD / 1M tokens"
        : `USD / 1M tokens (${BENCHMARK_PRICE_MIX.input}:${BENCHMARK_PRICE_MIX.output} in:out)`,
      nameLocation: "middle",
      nameGap: Math.ceil(axisTitleFontSize * 2.1),
      min: 0,
      splitNumber: layout.xSplitNumber,
      nameTextStyle: axisText,
      axisLabel: axisLabel(formatMarketAmount),
      axisLine: { lineStyle: { color: theme.grid } },
      splitLine: { lineStyle: { color: theme.grid, opacity: 0.35 } },
    },
    yAxis: {
      type: "value",
      name: "Coding Index",
      nameLocation: "middle",
      nameGap: Math.max(4, Math.ceil(axisTitleFontSize * 0.65)),
      min: 0,
      splitNumber: layout.ySplitNumber,
      nameTextStyle: axisText,
      axisLabel: axisLabel((value: number) => index.format(value)),
      axisLine: { lineStyle: { color: theme.grid } },
      splitLine: { lineStyle: { color: theme.grid, opacity: 0.35 } },
    },
    series: [
      {
        id: "benchmark-baseline",
        name: "Public benchmark",
        type: "scatter",
        data: data.points.map((point) => {
          const selected = point.id === data.selectedID
          return {
            name: point.label,
            value: [point.price.blended, point.benchmark.codingIndex],
            configurationID: point.id,
            symbol: frontierIDs.has(point.id) ? "diamond" : "circle",
            symbolSize: selected ? 14 : 10,
            itemStyle: {
              // Filled: observed for these filters. Hollow: benchmark only.
              color: point.observed ? (selected ? theme.accent : theme.text) : theme.surface,
              borderColor: selected ? theme.text : theme.accent,
              borderWidth: selected ? 2.5 : 1.5,
              ...(selected ? { shadowBlur: 12, shadowColor: theme.accent } : {}),
            },
            label: {
              show: selected || roomForAllLabels,
              formatter: boundedModelLabel(point.label, labelLimit),
              position: largest > 0 && point.price.blended >= largest * 0.68 ? "left" : "right",
              color: selected ? theme.text : theme.mutedText,
              fontFamily: theme.fontFamily,
              fontSize,
              fontWeight: selected ? 700 : 400,
            },
          }
        }),
        emphasis: { focus: "self" },
        labelLayout: { hideOverlap: true, moveOverlap: "shiftY" },
      },
      {
        id: "benchmark-frontier",
        name: "Benchmark frontier",
        type: "line",
        data:
          frontier.length > 1
            ? frontier.map((point) => [point.price.blended, point.benchmark.codingIndex])
            : [],
        smooth: false,
        connectNulls: false,
        showSymbol: false,
        silent: true,
        z: 1,
        lineStyle: { color: theme.accent, width: 2, type: "dashed" },
        emphasis: { disabled: true },
        blur: { lineStyle: { opacity: 1 }, endLabel: { opacity: 1 } },
        endLabel: frontierEndLabel("Benchmark frontier", frontier.length > 1, theme, fontSize),
      },
    ],
  } satisfies EChartsCoreOption
}

export type BenchmarkChartProps = BenchmarkChartData & {
  gaps: readonly BenchmarkBaselineGap[]
  onSelect: (id: string) => void
  /** Where the "Chart data as a table" disclosure renders; inline until the mount exists. */
  dataMount?: () => HTMLElement | undefined
  emptyText: string
  /** Extra Chart data content, e.g. coverage and a load-more control. */
  dataFooter?: JSX.Element
  theme?: ComparisonChartTheme
  fontFamily?: string
  monoFontFamily?: string
  appearanceVersion?: unknown
}

export function BenchmarkChart(props: BenchmarkChartProps) {
  let host: HTMLDivElement | undefined
  let adapter: ComparisonChartAdapter<BenchmarkChartData> | undefined
  const descriptionID = createUniqueId()
  const [announcement, setAnnouncement] = createSignal("")
  const empty = () => props.points.length === 0
  const currentTheme = () =>
    props.theme ??
    (host
      ? resolveNativeComparisonChartTheme(host, props.fontFamily, props.monoFontFamily)
      : undefined)
  // Keyboard travel follows the price axis, cheapest first.
  const order = () => props.points
  const focusPoint = (point: BenchmarkBaselinePoint | undefined) => {
    adapter?.focus(point?.id)
    setAnnouncement(point ? benchmarkPointTooltip(point) : "")
  }
  const keyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      focusPoint(undefined)
      return
    }
    const points = order()
    const next = chartKeyStep(
      points.length,
      points.findIndex((point) => point.id === props.selectedID),
      event.key,
    )
    if (next === undefined) return
    event.preventDefault()
    const point = points[next]!
    focusPoint(point)
    if (point.id !== props.selectedID) props.onSelect(point.id)
  }

  createEffect(() => {
    void props.appearanceVersion
    const data: BenchmarkChartData = { points: props.points, selectedID: props.selectedID }
    const theme = currentTheme()
    if (adapter && theme) adapter.update(data, theme)
  })
  onMount(() => {
    if (!host) return
    adapter = new ComparisonChartAdapter<BenchmarkChartData>(
      host,
      (id) => props.onSelect(id),
      benchmarkChartOptions,
    )
    const theme = currentTheme()
    if (theme) adapter.update({ points: props.points, selectedID: props.selectedID }, theme)
  })
  onCleanup(() => {
    adapter?.dispose()
    adapter = undefined
  })

  return (
    <div
      class="lazers-models-comparison-chart lazers-models-benchmark-chart"
      data-empty={empty()}
      style={{ width: "100%", "min-width": "0" }}
    >
      <div
        class="lazers-models-comparison-chart-plot"
        role="group"
        aria-roledescription="chart"
        aria-label="Benchmark chart. Arrow keys move between models; Escape hides the tooltip."
        tabIndex={empty() ? -1 : 0}
        onKeyDown={keyDown}
        onFocus={() => focusPoint(order().find((point) => point.id === props.selectedID))}
        onBlur={() => focusPoint(undefined)}
        style={{ width: "100%", "min-width": "0" }}
      >
        <div
          ref={(element) => {
            host = element
          }}
          role="img"
          aria-label="Public Coding Index against list price per 1M tokens"
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
          {props.emptyText}
        </p>
      </Show>
      <p id={descriptionID} style={visuallyHidden}>
        {props.points.map(benchmarkPointText).join(" ")}
        {benchmarkFrontierText(benchmarkFrontier(props.points))}
      </p>
      <p aria-live="polite" style={visuallyHidden}>
        {announcement()}
      </p>
      <ul
        class="lazers-models-comparison-chart-legend"
        aria-label="Chart mark legend"
        hidden={empty()}
      >
        <Show when={benchmarkFrontier(props.points).length > 0}>
          <li>
            <span
              class="lazers-models-chart-key lazers-models-chart-key-frontier"
              aria-hidden="true"
            />
            Best trade-off
          </li>
        </Show>
        <Show when={!empty()}>
          <li>
            <span
              class="lazers-models-chart-key lazers-models-chart-key-hollow"
              aria-hidden="true"
            />
            Other
          </li>
        </Show>
      </ul>
      {(() => {
        const data = (
          <details class="lazers-models-disclosure lazers-models-comparison-chart-data">
            <summary>
              <span>Chart data as a table</span>
              <span class="lazers-models-disclosure-hint">
                {props.points.length + props.gaps.length} models
              </span>
            </summary>
            <ul>
              <For each={props.points}>
                {(point) => (
                  <li>
                    <button
                      type="button"
                      data-configuration-id={point.id}
                      aria-pressed={props.selectedID === point.id}
                      aria-label={`Select ${benchmarkPointText(point)}`}
                      title={benchmarkPointText(point)}
                      onClick={() => props.onSelect(point.id)}
                    >
                      {benchmarkPointTooltip(point)} · {benchmarkSourceName[point.price.source]}
                    </button>
                  </li>
                )}
              </For>
              <For each={props.gaps}>
                {(gap) => (
                  <li>
                    <button
                      type="button"
                      data-configuration-id={gap.id}
                      aria-pressed={props.selectedID === gap.id}
                      aria-label={`Select ${gap.label} · exact route ${routeLabel(gap.route)}. ${benchmarkGapText(gap)}.`}
                      onClick={() => props.onSelect(gap.id)}
                    >
                      {benchmarkGapText(gap)}
                    </button>
                  </li>
                )}
              </For>
            </ul>
            {props.dataFooter}
          </details>
        )
        return (
          <Show when={props.dataMount?.()} fallback={data}>
            {(mount) => <Portal mount={mount()}>{data}</Portal>}
          </Show>
        )
      })()}
    </div>
  )
}
