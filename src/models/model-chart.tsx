import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { JSX } from "solid-js"
import {
  RANK_ROW_HEIGHT,
  RANK_VISIBLE_ROWS,
  fanOut,
  layoutChart,
  layoutRanking,
  nextPointID,
} from "./chart-layout.ts"
import type { ChartDatum, RankRow } from "./chart-layout.ts"

/** One plotted model: its position, its label and the words for the tooltip and screen readers. */
export type ModelChartPoint = ChartDatum & {
  /** Tooltip lines: model, effort, cost range, tokens, accepted n of m, source. */
  tooltip: readonly string[]
  /** The accessible name of the point. */
  description: string
}

export type ModelChartProps = {
  points: readonly ModelChartPoint[]
  selectedID: string | null
  onSelect: (id: string) => void
  xTitle: string
  yTitle: string
  formatX: (value: number) => string
  formatY: (value: number) => string
  /** `auto-log` switches the x axis to a log scale when the spread exceeds 50x. */
  xScale?: "linear" | "auto-log"
  /** The accessible name of the whole chart. */
  label: string
  /** Right of the legend, e.g. "14 accepted tasks · OpenRouter prices". */
  caption?: string | undefined
  /** Name the ring mark in the legend. */
  backedLegend?: string
  /** What to say, and offer, when there is nothing to plot. */
  emptyText?: string
  emptyAction?: JSX.Element
}

const DEFAULT_WIDTH = 474

/**
 * The scatter plot, drawn as SVG: hairline frame, weak grid, filled accent points joined by a thin
 * polyline for the best trade-off, hollow neutral points for the rest, every point labelled.
 * Layout is `chart-layout.ts`; this component only measures its width and draws.
 */
export function ModelChart(props: ModelChartProps) {
  let wrapper: HTMLDivElement | undefined
  const [width, setWidth] = createSignal(DEFAULT_WIDTH)
  const [hovered, setHovered] = createSignal<string | null>(null)
  onMount(() => {
    if (!wrapper) return
    const measure = () => {
      const next = Math.floor(wrapper!.clientWidth)
      if (next > 0 && next !== width()) setWidth(next)
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(wrapper)
    onCleanup(() => observer.disconnect())
  })

  const layout = createMemo(() =>
    layoutChart({
      width: width(),
      points: props.points,
      selectedID: props.selectedID,
      xScale: props.xScale ?? "linear",
      formatX: props.formatX,
      formatY: props.formatY,
    }),
  )
  // Elements are keyed by id so a layout change never recreates a point (and drops its focus).
  const pointIDs = createMemo(() => layout().points.map((point) => point.id), [], {
    equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]),
  })
  const byID = createMemo(() => new Map(props.points.map((point) => [point.id, point] as const)))
  // Points closer than 10 px fan out while one of them is hovered or focused.
  const fanned = createMemo(() => {
    const id = hovered()
    const current = layout()
    const cluster = id ? current.clusters.find((group) => group.includes(id)) : undefined
    if (!cluster) return new Map<string, { cx: number; cy: number }>()
    return fanOut(current.points.filter((point) => cluster.includes(point.id)))
  })
  const position = (point: { id: string; cx: number; cy: number }) =>
    fanned().get(point.id) ?? point
  const tip = createMemo(() => {
    const id = hovered()
    const point = id ? layout().points.find((entry) => entry.id === id) : undefined
    const data = id ? byID().get(id) : undefined
    if (!point || !data) return undefined
    const at = position(point)
    return { lines: data.tooltip, left: at.cx, top: at.cy, flip: at.cx > layout().width * 0.55 }
  })
  const empty = () => props.points.length === 0
  const key = (event: KeyboardEvent, id: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      props.onSelect(id)
      return
    }
    if (event.key === "Escape") {
      setHovered(null)
      return
    }
    const next = nextPointID(layout().points, id, event.key)
    if (next === undefined) return
    event.preventDefault()
    wrapper?.querySelector<SVGGElement>(`[data-point-id="${CSS.escape(next)}"]`)?.focus()
  }
  const roving = () => props.selectedID ?? layout().points[0]?.id ?? null
  const hasFrontier = () => props.points.some((point) => point.frontier)
  const hasOther = () => props.points.some((point) => !point.frontier)
  const hasBacked = () => props.points.some((point) => point.backed)

  return (
    <div class="lazers-chart" data-empty={empty()} ref={wrapper}>
      <Show
        when={!empty()}
        fallback={
          <div class="lazers-chart-empty" role="status">
            <p>{props.emptyText}</p>
            {props.emptyAction}
          </div>
        }
      >
        <svg
          class="lazers-chart-svg"
          width={layout().width}
          height={layout().height}
          viewBox={`0 0 ${layout().width} ${layout().height}`}
          role="group"
          aria-roledescription="chart"
          aria-label={props.label}
        >
          <rect
            class="lazers-chart-frame"
            x={layout().plot.left}
            y={layout().plot.top}
            width={layout().plot.right - layout().plot.left}
            height={layout().plot.bottom - layout().plot.top}
          />
          <For each={layout().xScale.ticks}>
            {(tick) => {
              const x = () =>
                layout().plot.left + tick.position * (layout().plot.right - layout().plot.left)
              return (
                <>
                  <Show when={tick.position > 0.001 && tick.position < 0.999}>
                    <line
                      class="lazers-chart-grid"
                      x1={x()}
                      x2={x()}
                      y1={layout().plot.top}
                      y2={layout().plot.bottom}
                    />
                  </Show>
                  <text
                    class="lazers-chart-tick"
                    x={x()}
                    y={layout().plot.bottom + 15}
                    text-anchor={
                      tick.position > 0.97 ? "end" : tick.position < 0.03 ? "start" : "middle"
                    }
                  >
                    {tick.label}
                  </text>
                </>
              )
            }}
          </For>
          <For each={layout().yScale.ticks}>
            {(tick) => {
              const y = () =>
                layout().plot.bottom - tick.position * (layout().plot.bottom - layout().plot.top)
              return (
                <>
                  <Show when={tick.position > 0.001 && tick.position < 0.999}>
                    <line
                      class="lazers-chart-grid"
                      x1={layout().plot.left}
                      x2={layout().plot.right}
                      y1={y()}
                      y2={y()}
                    />
                  </Show>
                  <text
                    class="lazers-chart-tick"
                    x={layout().plot.left - 6}
                    y={y() + 4}
                    text-anchor="end"
                  >
                    {tick.label}
                  </text>
                </>
              )
            }}
          </For>
          <text
            class="lazers-chart-title"
            x={(layout().plot.left + layout().plot.right) / 2}
            y={layout().height - 6}
            text-anchor="middle"
          >
            {props.xTitle}
            {layout().xScale.kind === "log" ? " · log" : ""}
          </text>
          <text
            class="lazers-chart-title"
            transform={`translate(12 ${(layout().plot.top + layout().plot.bottom) / 2}) rotate(-90)`}
            text-anchor="middle"
          >
            {props.yTitle}
          </text>
          <Show when={layout().frontierPath}>
            <path class="lazers-chart-frontier" d={layout().frontierPath} />
          </Show>
          <For each={layout().points.filter((point) => point.id === props.selectedID)}>
            {(point) => (
              <circle
                class="lazers-chart-halo"
                cx={position(point).cx}
                cy={position(point).cy}
                r="12"
              />
            )}
          </For>
          <For each={pointIDs()}>
            {(id) => {
              const point = () => layout().points.find((entry) => entry.id === id)!
              const at = () => position(point())
              const selected = () => point().id === props.selectedID
              const data = () => byID().get(point().id)
              const fannedOut = () => fanned().has(point().id)
              return (
                <g
                  class="lazers-chart-point"
                  data-point-id={point().id}
                  data-frontier={point().frontier ? "" : undefined}
                  data-selected={selected() ? "" : undefined}
                  role="button"
                  tabindex={point().id === roving() ? 0 : -1}
                  aria-pressed={selected()}
                  aria-label={data()?.description ?? point().label}
                  onClick={() => props.onSelect(point().id)}
                  onKeyDown={(event) => key(event, point().id)}
                  onPointerEnter={() => setHovered(point().id)}
                  onPointerLeave={() =>
                    setHovered((current) => (current === point().id ? null : current))
                  }
                  onFocus={() => setHovered(point().id)}
                  onBlur={() => setHovered((current) => (current === point().id ? null : current))}
                >
                  <circle class="lazers-chart-hit" cx={at().cx} cy={at().cy} r="10" />
                  <Show when={point().backed}>
                    <circle class="lazers-chart-ring" cx={at().cx} cy={at().cy} r="8" />
                  </Show>
                  <circle
                    class="lazers-chart-mark"
                    cx={at().cx}
                    cy={at().cy}
                    r={selected() ? 5.5 : 4.5}
                  />
                  <Show when={point().place && !fannedOut()}>
                    <>
                      <Show when={selected() && point().place!.side === "top"}>
                        <line
                          class="lazers-chart-leader"
                          x1={at().cx}
                          x2={at().cx}
                          y1={at().cy - 8}
                          y2={at().cy - 13}
                        />
                      </Show>
                      <text
                        class="lazers-chart-label"
                        data-selected={selected() ? "" : undefined}
                        x={point().place!.x}
                        y={point().place!.y}
                        text-anchor={point().place!.anchor}
                      >
                        {point().label}
                      </text>
                    </>
                  </Show>
                </g>
              )
            }}
          </For>
        </svg>
        <Show when={tip()}>
          {(current) => (
            <div
              class="lazers-chart-tip"
              role="tooltip"
              data-flip={current().flip ? "" : undefined}
              style={{ left: `${current().left}px`, top: `${current().top}px` }}
            >
              <For each={current().lines}>{(line) => <div>{line}</div>}</For>
            </div>
          )}
        </Show>
        <div class="lazers-chart-foot">
          <ul class="lazers-chart-legend" aria-label="Chart mark legend">
            <Show when={hasFrontier()}>
              <li>
                <span class="lazers-chart-key" data-kind="frontier" aria-hidden="true" />
                Best trade-off
              </li>
            </Show>
            <Show when={hasOther()}>
              <li>
                <span class="lazers-chart-key" data-kind="other" aria-hidden="true" />
                Other
              </li>
            </Show>
            <Show when={hasBacked() && props.backedLegend}>
              <li>
                <span class="lazers-chart-key" data-kind="backed" aria-hidden="true" />
                {props.backedLegend}
              </li>
            </Show>
          </ul>
          <Show when={props.caption}>
            <p class="lazers-chart-caption">{props.caption}</p>
          </Show>
        </div>
      </Show>
    </div>
  )
}

export type RankingChartRow = RankRow & {
  tooltip: readonly string[]
  description: string
}

export type RankingChartProps = {
  rows: readonly RankingChartRow[]
  selectedID: string | null
  onSelect: (id: string) => void
  formatValue: (value: number) => string
  label: string
  caption?: string | undefined
  /** Name the ring mark in the legend. */
  backedLegend?: string
  /** Show the public score as a muted right-hand column. */
  showScore?: boolean
  /** Title above the axis, e.g. "Projected cost per accepted task". */
  title: string
}

/**
 * The Projected view: one row per priced model, cheapest first, cost along x. It needs no second
 * measure. At most `RANK_VISIBLE_ROWS` rows show; the rest scroll inside the chart area under a
 * fixed axis. Rows are focusable like the scatter's points.
 */
export function RankingChart(props: RankingChartProps) {
  let wrapper: HTMLDivElement | undefined
  const [width, setWidth] = createSignal(DEFAULT_WIDTH)
  onMount(() => {
    if (!wrapper) return
    const measure = () => {
      const next = Math.floor(wrapper!.clientWidth)
      if (next > 0 && next !== width()) setWidth(next)
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(wrapper)
    onCleanup(() => observer.disconnect())
  })
  const layout = createMemo(() =>
    layoutRanking({
      width: width(),
      rows: props.rows,
      formatValue: props.formatValue,
      showScore: Boolean(props.showScore),
    }),
  )
  const byID = createMemo(() => new Map(props.rows.map((row) => [row.id, row] as const)))
  const ids = createMemo(() => props.rows.map((row) => row.id), [], {
    equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]),
  })
  const roving = () => props.selectedID ?? props.rows[0]?.id ?? null
  const key = (event: KeyboardEvent, id: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      props.onSelect(id)
      return
    }
    const order = ids()
    const index = order.indexOf(id)
    const next =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? order[Math.min(order.length - 1, index + 1)]
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? order[Math.max(0, index - 1)]
          : event.key === "Home"
            ? order[0]
            : event.key === "End"
              ? order.at(-1)
              : undefined
    if (next === undefined) return
    event.preventDefault()
    wrapper?.querySelector<SVGGElement>(`[data-point-id="${CSS.escape(next)}"]`)?.focus()
  }
  // The selection stays in view when the list scrolls.
  createEffect(() => {
    void props.selectedID
    queueMicrotask(() =>
      wrapper
        ?.querySelector<SVGGElement>("[data-selected]")
        ?.scrollIntoView?.({ block: "nearest" }),
    )
  })
  // Tick labels that would touch their neighbour are left out.
  const axisTicks = () => {
    let last = -1
    return layout().xScale.ticks.filter((tick) => {
      if (tick.position - last < 0.22) return false
      last = tick.position
      return true
    })
  }
  const left = () => layout().plotLeft
  const right = () => layout().plotRight
  const at = (position: number) => left() + position * (right() - left())
  const hasBacked = () => props.rows.some((row) => row.backed)

  return (
    <div class="lazers-chart lazers-rank" ref={wrapper}>
      <div class="lazers-rank-title">
        {props.title}
        {layout().xScale.kind === "log" ? " · log" : ""}
      </div>
      <svg class="lazers-rank-axis" width={layout().width} height="20" aria-hidden="true">
        <For each={axisTicks()}>
          {(tick) => (
            <text
              class="lazers-chart-tick"
              x={at(tick.position)}
              y="14"
              text-anchor={tick.position > 0.97 ? "end" : tick.position < 0.03 ? "start" : "middle"}
            >
              {tick.label}
            </text>
          )}
        </For>
      </svg>
      <div
        class="lazers-rank-scroll"
        style={{ "max-height": `${RANK_VISIBLE_ROWS * RANK_ROW_HEIGHT}px` }}
      >
        <svg
          class="lazers-chart-svg"
          width={layout().width}
          height={layout().height}
          role="group"
          aria-roledescription="chart"
          aria-label={props.label}
        >
          <For each={layout().xScale.ticks}>
            {(tick) => (
              <line
                class="lazers-chart-grid"
                x1={at(tick.position)}
                x2={at(tick.position)}
                y1="0"
                y2={layout().height}
              />
            )}
          </For>
          <For each={ids()}>
            {(id) => {
              const row = () => layout().rows.find((entry) => entry.id === id)!
              const data = () => byID().get(id)
              const selected = () => id === props.selectedID
              return (
                <g
                  class="lazers-chart-point lazers-rank-row"
                  data-point-id={id}
                  data-selected={selected() ? "" : undefined}
                  role="button"
                  tabindex={id === roving() ? 0 : -1}
                  aria-pressed={selected()}
                  aria-label={data()?.description ?? row().label}
                  onClick={() => props.onSelect(id)}
                  onKeyDown={(event) => key(event, id)}
                >
                  <title>{data()?.tooltip.join("\n")}</title>
                  <rect
                    class="lazers-rank-hit"
                    x="0"
                    y={row().cy - RANK_ROW_HEIGHT / 2}
                    width={layout().width}
                    height={RANK_ROW_HEIGHT}
                  />
                  <Show when={selected()}>
                    <circle class="lazers-chart-halo" cx={row().cx} cy={row().cy} r="12" />
                  </Show>
                  <text
                    class="lazers-chart-label"
                    data-selected={selected() ? "" : undefined}
                    x="0"
                    y={row().cy + 4}
                  >
                    {row().text}
                  </text>
                  <line
                    class="lazers-rank-stem"
                    x1={left()}
                    x2={row().cx}
                    y1={row().cy}
                    y2={row().cy}
                  />
                  <Show when={row().backed}>
                    <circle class="lazers-chart-ring" cx={row().cx} cy={row().cy} r="8" />
                  </Show>
                  <circle
                    class="lazers-chart-mark lazers-rank-mark"
                    cx={row().cx}
                    cy={row().cy}
                    r={selected() ? 5.5 : 4.5}
                  />
                  <text
                    class="lazers-chart-value"
                    x={row().valueInside ? row().cx - 10 : row().cx + 10}
                    y={row().cy + 4}
                    text-anchor={row().valueInside ? "end" : "start"}
                  >
                    {row().valueText}
                  </text>
                  <Show when={layout().scoreWidth > 0 && row().score != null}>
                    <text
                      class="lazers-rank-score"
                      x={layout().width - 4}
                      y={row().cy + 4}
                      text-anchor="end"
                    >
                      score {row().score}
                    </text>
                  </Show>
                </g>
              )
            }}
          </For>
        </svg>
      </div>
      <div class="lazers-chart-foot">
        <ul class="lazers-chart-legend" aria-label="Chart mark legend">
          <li>
            <span class="lazers-chart-key" data-kind="frontier" aria-hidden="true" />
            Projected cost
          </li>
          <Show when={hasBacked() && props.backedLegend}>
            <li>
              <span class="lazers-chart-key" data-kind="backed" aria-hidden="true" />
              {props.backedLegend}
            </li>
          </Show>
        </ul>
        <Show when={props.caption}>
          <p class="lazers-chart-caption">{props.caption}</p>
        </Show>
      </div>
    </div>
  )
}
