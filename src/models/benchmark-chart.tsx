import { For, Show, createEffect, createSignal, createUniqueId, onCleanup, onMount } from "solid-js"
import type { JSX } from "solid-js"
import type { EChartsCoreOption } from "echarts/core"
import { BENCHMARK_PRICE_MIX } from "./benchmark-baseline.ts"
import type { BenchmarkBaselineGap, BenchmarkBaselinePoint } from "./benchmark-baseline.ts"
import {
  ComparisonChartAdapter,
  chartKeyStep,
  chartPlotFrame,
  niceAxis,
  placeChartLabels,
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
  const plotHeight = Math.max(1, layout.height - layout.grid.top - layout.grid.bottom)
  const labelLimit = Math.min(30, Math.max(12, Math.floor(plotWidth / (fontSize * 1.25))))
  const frontier = benchmarkFrontier(data.points)
  const frontierIDs = new Set(frontier.map((point) => point.id))
  const frame = chartPlotFrame(theme, layout)
  const xAxis = niceAxis(
    Math.max(0, ...data.points.map((point) => point.price.blended)) * 1.05,
    layout.xSplitNumber,
  )
  const yAxis = niceAxis(
    Math.max(0, ...data.points.map((point) => point.benchmark.codingIndex)) * 1.08,
    layout.ySplitNumber,
  )
  const placed = placeChartLabels(
    data.points.map((point) => ({
      id: point.id,
      x: point.price.blended,
      y: point.benchmark.codingIndex,
      text: boundedModelLabel(point.label, labelLimit),
      side:
        point.id === data.selectedID
          ? ("top" as const)
          : xAxis.max > 0 && point.price.blended >= xAxis.max * 0.68
            ? ("left" as const)
            : ("right" as const),
      priority: point.id === data.selectedID ? 0 : frontierIDs.has(point.id) ? 1 : 2,
    })),
    { plotWidth, plotHeight, xMax: xAxis.max, yMax: yAxis.max, fontSize },
  )
  const neutral = theme.neutral ?? theme.mutedText
  const background = theme.background ?? theme.surface
  const selected = data.points.find((point) => point.id === data.selectedID)
  const drawn = data.points.toSorted(
    (left, right) => Number(left.id === data.selectedID) - Number(right.id === data.selectedID),
  )
  return {
    animation: false,
    backgroundColor: frame.backgroundColor,
    textStyle: { fontFamily: theme.fontFamily, color: theme.text },
    aria: {
      enabled: true,
      description: benchmarkDescription(data.points),
      decal: { show: false },
    },
    grid: frame.grid,
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
      name:
        layout.width < 400
          ? "USD per 1M tokens"
          : `USD per 1M tokens (${BENCHMARK_PRICE_MIX.input}:${BENCHMARK_PRICE_MIX.output} in:out)`,
      nameLocation: "middle",
      nameGap: frame.xNameGap,
      min: 0,
      max: xAxis.max,
      interval: xAxis.interval,
      nameTextStyle: frame.axisName,
      axisLabel: frame.axisLabel(formatMarketAmount),
      axisLine: frame.axisLine,
      axisTick: frame.axisTick,
      splitLine: frame.splitLine,
    },
    yAxis: {
      type: "value",
      name: "Coding Index",
      nameLocation: "middle",
      nameGap: frame.yNameGap,
      min: 0,
      max: yAxis.max,
      interval: yAxis.interval,
      nameTextStyle: frame.axisName,
      axisLabel: frame.axisLabel((value: number) => index.format(value)),
      axisLine: frame.axisLine,
      axisTick: frame.axisTick,
      splitLine: frame.splitLine,
    },
    series: [
      {
        id: "benchmark-baseline",
        name: "Public benchmark",
        type: "scatter",
        data: drawn.map((point) => {
          const isSelected = point.id === data.selectedID
          const onFrontier = frontierIDs.has(point.id)
          return {
            name: point.label,
            value: [point.price.blended, point.benchmark.codingIndex],
            configurationID: point.id,
            symbol: "circle",
            symbolSize: isSelected ? 11 : 9,
            // Filled blue: on the best trade-off frontier. Hollow neutral: any other.
            itemStyle: {
              color: onFrontier ? theme.accent : background,
              borderColor: isSelected ? theme.text : onFrontier ? theme.accent : neutral,
              borderWidth: isSelected ? 2 : 1.5,
            },
            label: {
              show: placed.has(point.id),
              formatter: boundedModelLabel(point.label, labelLimit),
              position: placed.get(point.id) ?? "right",
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
                value: [selected.price.blended, selected.benchmark.codingIndex],
                configurationID: selected.id,
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

export type BenchmarkChartProps = BenchmarkChartData & {
  gaps: readonly BenchmarkBaselineGap[]
  onSelect: (id: string) => void
  /** Where the "Chart data as a table" disclosure renders; inline until the mount exists. */
  dataMount?: () => HTMLElement | undefined
  emptyText: string
  /** Right of the legend, e.g. the benchmark source and price mix. */
  caption?: string
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
  // The table lives in the selected-model disclosures once that pane has a mount for it.
  let dataSlot: HTMLElement | undefined
  let dataDetails: HTMLElement | undefined
  createEffect(() => {
    const target = props.dataMount?.() ?? dataSlot
    if (target && dataDetails && dataDetails.parentNode !== target) target.append(dataDetails)
  })
  onCleanup(() => dataDetails?.remove())
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
      <div class="lazers-models-chart-foot" hidden={empty()}>
        <ul class="lazers-models-comparison-chart-legend" aria-label="Chart mark legend">
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
      </div>
    </div>
  )
}
