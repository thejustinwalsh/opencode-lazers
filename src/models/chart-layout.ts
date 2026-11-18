/**
 * Pure layout for the Models scatter plots: nice ticks, linear or log scales, label placement
 * with collision avoidance, hover clusters and the frontier path. No DOM and no chart library;
 * `model-chart.tsx` draws what this returns as SVG.
 */

export const CHART_FONT = 11.5
export const MARK_RADIUS = 4.5
const LABEL_GAP = 3

/** The smallest sample for a model to count when deciding the best trade-off. */
export const FRONTIER_MIN_TERMINAL_TASKS = 2

/**
 * "Best trade-off" is the Pareto set: a model is on it when no other eligible model is at least
 * as good on every objective and strictly better on one. Objectives are all "smaller is better";
 * negate a "higher is better" measure. Observed runs use cost per accepted task, tokens per
 * accepted task and acceptance rate (negated); projections use cost and benchmark score
 * (negated). Eligibility (a minimum sample) is decided by the caller.
 */
export function paretoFrontier<T>(
  items: readonly T[],
  objectives: ReadonlyArray<(item: T) => number | null>,
): T[] {
  const values = items.map((item) => objectives.map((objective) => objective(item)))
  return items.filter((_, index) => {
    const mine = values[index]!
    return !values.some((other, otherIndex) => {
      if (otherIndex === index) return false
      let strictly = false
      for (let objective = 0; objective < mine.length; objective++) {
        const a = other[objective]
        const b = mine[objective]
        // A measure missing on either side cannot separate the two.
        if (a === null || a === undefined || b === null || b === undefined) continue
        if (a > b) return false
        if (a < b) strictly = true
      }
      return strictly
    })
  })
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value))

/**
 * Round axis maximum and step for about `intervals` steps (up to two more are allowed when it ends the
 * axis sooner, so points spread across the plot). The maximum covers `maxValue`.
 */
export function niceAxis(maxValue: number, intervals: number) {
  const target = Math.max(1, Math.floor(intervals))
  if (!(maxValue > 0) || !Number.isFinite(maxValue)) return { max: target, interval: 1 }
  const round = (value: number) => Number(value.toPrecision(10))
  const fit = (count: number) => {
    const raw = maxValue / count
    const base = 10 ** Math.floor(Math.log10(raw))
    const step = [1, 2, 5, 10].map((unit) => unit * base).find((unit) => unit >= raw * 0.999999)!
    const interval = round(step)
    return { max: round(Math.ceil(maxValue / interval - 1e-9) * interval), interval }
  }
  return [fit(target), fit(target + 1), fit(target + 2)].reduce((best, next) =>
    next.max < best.max ? next : best,
  )
}

export type Tick = { value: number; position: number; label: string }

export type Scale = {
  kind: "linear" | "log"
  min: number
  max: number
  ticks: Tick[]
  /** 0 at the low end, 1 at the high end. */
  at: (value: number) => number
}

export type ScaleOptions = {
  values: readonly number[]
  /** Which scale to use. `auto` switches to log when max / min exceeds `LOG_RATIO`. */
  scale: "linear" | "auto-log"
  /** About how many tick intervals to aim for. */
  intervals: number
  format: (value: number) => string
  /** Extra room above the largest value, as a fraction; room for a label to the side. */
  headroom: number
  /** A linear axis starts at zero. */
  zero?: boolean
}

export const LOG_RATIO = 50

export function buildScale(options: ScaleOptions): Scale {
  const positive = options.values.filter((value) => Number.isFinite(value) && value > 0)
  const max = Math.max(0, ...options.values.filter((value) => Number.isFinite(value)))
  const min = positive.length ? Math.min(...positive) : 0
  if (options.scale === "auto-log" && positive.length > 1 && max / min > LOG_RATIO) {
    const low = 10 ** Math.floor(Math.log10(min))
    const target = max * (1 + options.headroom)
    // Ticks at 1 and 3 of each decade, from the decade below the smallest value up to the first
    // tick that covers the largest; thinned to whole decades when that would be too many.
    const all: number[] = []
    for (
      let exponent = Math.log10(low);
      all.at(-1) === undefined || all.at(-1)! < target;
      exponent++
    )
      all.push(10 ** exponent, 3 * 10 ** exponent)
    const covered = all.slice(0, all.findIndex((value) => value >= target) + 1)
    const values =
      covered.length > 7
        ? covered.filter(
            (value) => Math.log10(value) % 1 < 1e-9 || Math.log10(value) % 1 > 1 - 1e-9,
          )
        : covered
    const high = values.at(-1)! >= target ? values.at(-1)! : 10 ** Math.ceil(Math.log10(target))
    if (values.at(-1)! < target) values.push(high)
    const at = (value: number) =>
      (Math.log10(Math.max(value, low)) - Math.log10(low)) / (Math.log10(high) - Math.log10(low))
    return {
      kind: "log",
      min: low,
      max: high,
      at,
      ticks: values.map((value) => ({ value, position: at(value), label: options.format(value) })),
    }
  }
  const axis = niceAxis(max * (1 + options.headroom), options.intervals)
  const ticks: Tick[] = []
  for (let value = 0; value <= axis.max + axis.interval * 1e-6; value += axis.interval) {
    const rounded = Number(value.toPrecision(10))
    ticks.push({ value: rounded, position: rounded / axis.max, label: options.format(rounded) })
  }
  return {
    kind: "linear",
    min: 0,
    max: axis.max,
    at: (value) => value / axis.max,
    ticks,
  }
}

/** Dollar tick: `$3` for whole amounts, `$0.50` otherwise. */
export function formatAxisMoney(value: number) {
  if (Number.isInteger(value)) return `$${value}`
  return `$${Math.round(value * 100) / 100 === value ? value.toFixed(2) : value.toFixed(3)}`
}

const compactTokens = new Intl.NumberFormat("en-US", {
  notation: "compact",
  compactDisplay: "short",
  maximumFractionDigits: 1,
})
export function formatAxisTokens(value: number) {
  return compactTokens.format(value)
}

export type ChartDatum = {
  id: string
  /** Data coordinates. */
  x: number
  y: number
  label: string
  /** On the best trade-off frontier: filled and joined by the polyline. */
  frontier: boolean
  /** Backed by the user's own runs (a projection drawn with a ring). */
  backed?: boolean
}

export type PlacedLabel = { x: number; y: number; anchor: "start" | "end" | "middle"; side: Side }
export type Side = "right" | "left" | "top" | "bottom"

export type PlacedPoint = ChartDatum & {
  cx: number
  cy: number
  /** Absent when the label was dropped to avoid a collision. */
  place?: PlacedLabel
}

export type ChartLayout = {
  width: number
  height: number
  plot: { left: number; top: number; right: number; bottom: number }
  xScale: Scale
  yScale: Scale
  points: PlacedPoint[]
  /** SVG path of the frontier polyline; empty with fewer than two frontier points. */
  frontierPath: string
  /** Groups of point ids closer than `CLUSTER_PX`; each point is reachable by fanning out. */
  clusters: string[][]
}

export const CLUSTER_PX = 10

/** Plot height from its width: clamp(width x 0.48, 220, 360). */
export function chartHeight(width: number) {
  return Math.round(clamp(width * 0.48, 220, 360))
}

export type LayoutInput = {
  width: number
  points: readonly ChartDatum[]
  selectedID: string | null
  xScale: "linear" | "auto-log"
  formatX: (value: number) => string
  formatY: (value: number) => string
}

/** Labels are placed selected first, then the frontier, then the rest; the rest drop first. */
export function placeLabels(
  items: ReadonlyArray<{
    id: string
    cx: number
    cy: number
    text: string
    preferred: Side
    priority: number
  }>,
  box: { left: number; top: number; right: number; bottom: number },
  fontSize = CHART_FONT,
) {
  type Rect = { left: number; right: number; top: number; bottom: number }
  const overlaps = (a: Rect, b: Rect, pad: number) =>
    a.left < b.right + pad &&
    a.right > b.left - pad &&
    a.top < b.bottom + pad &&
    a.bottom > b.top - pad
  const marks = items.map((item) => ({
    id: item.id,
    left: item.cx - MARK_RADIUS + 0.5,
    right: item.cx + MARK_RADIUS - 0.5,
    top: item.cy - MARK_RADIUS + 0.5,
    bottom: item.cy + MARK_RADIUS - 0.5,
  }))
  const order: Record<Side, readonly Side[]> = {
    right: ["right", "left", "top", "bottom"],
    left: ["left", "right", "top", "bottom"],
    top: ["top", "right", "left", "bottom"],
    bottom: ["bottom", "right", "left", "top"],
  }
  const kept: Rect[] = []
  const placed = new Map<string, PlacedLabel>()
  for (const item of items.toSorted((a, b) => a.priority - b.priority)) {
    const width = item.text.length * fontSize * 0.54
    const height = fontSize * 1.1
    const rectOn = (side: Side): { side: Side; rect: Rect; label: PlacedLabel } => {
      const gap = MARK_RADIUS + LABEL_GAP
      const left =
        side === "right"
          ? item.cx + gap
          : side === "left"
            ? item.cx - gap - width
            : item.cx - width / 2
      const top =
        side === "top"
          ? item.cy - gap - 4 - height
          : side === "bottom"
            ? item.cy + gap
            : item.cy - height / 2
      return {
        side,
        rect: { left, right: left + width, top, bottom: top + height },
        label: {
          side,
          anchor: side === "right" ? "start" : side === "left" ? "end" : "middle",
          x: side === "right" ? left : side === "left" ? left + width : item.cx,
          // Text baseline: about three quarters down the line box.
          y: top + height * 0.82,
        },
      }
    }
    const inside = (rect: Rect) =>
      rect.left >= box.left &&
      rect.right <= box.right &&
      rect.top >= box.top &&
      rect.bottom <= box.bottom
    const candidates = order[item.preferred].map(rectOn)
    const choice =
      candidates.find(
        ({ rect }) =>
          inside(rect) &&
          !kept.some((other) => overlaps(rect, other, 2)) &&
          !marks.some((mark) => mark.id !== item.id && overlaps(rect, mark, 0)),
      ) ??
      // The selection is always named, even over other marks, as long as no other label is hit.
      (item.priority === 0
        ? (candidates.find(
            ({ rect }) => inside(rect) && !kept.some((other) => overlaps(rect, other, 2)),
          ) ?? candidates[0])
        : undefined)
    if (!choice) continue
    kept.push(choice.rect)
    placed.set(item.id, choice.label)
  }
  return placed
}

export function layoutChart(input: LayoutInput): ChartLayout {
  const { width } = input
  const height = chartHeight(width)
  const yScale = buildScale({
    values: input.points.map((point) => point.y),
    scale: "linear",
    intervals: height < 260 ? 3 : 4,
    format: input.formatY,
    headroom: 0.08,
  })
  // The left margin holds the rotated title (12 px) and the widest y tick label (mono, ~6.9 px).
  const widest = Math.max(...yScale.ticks.map((tick) => tick.label.length))
  const plot = {
    left: Math.max(46, Math.ceil(widest * 6.9 + 28)),
    top: 14,
    right: width - 14,
    bottom: height - 42,
  }
  const xScale = buildScale({
    values: input.points.map((point) => point.x),
    scale: input.xScale,
    intervals: width < 420 ? 3 : 4,
    format: input.formatX,
    headroom: 0.06,
  })
  const plotWidth = plot.right - plot.left
  const plotHeight = plot.bottom - plot.top
  const base = input.points.map((point) => ({
    ...point,
    cx: plot.left + xScale.at(point.x) * plotWidth,
    cy: plot.bottom - yScale.at(point.y) * plotHeight,
  }))
  const placed = placeLabels(
    base.map((point) => ({
      id: point.id,
      cx: point.cx,
      cy: point.cy,
      text: point.label,
      preferred:
        point.id === input.selectedID
          ? ("top" as const)
          : point.cx > plot.left + plotWidth * 0.68
            ? ("left" as const)
            : ("right" as const),
      priority: point.id === input.selectedID ? 0 : point.frontier ? 1 : 2,
    })),
    plot,
  )
  const points = base.map((point) => ({ ...point, place: placed.get(point.id) }))
  const line = points
    .filter((point) => point.frontier)
    .toSorted((a, b) => a.x - b.x || a.y - b.y || (a.id < b.id ? -1 : 1))
  const frontierPath =
    line.length > 1
      ? line
          .map(
            (point, index) => `${index ? "L" : "M"}${point.cx.toFixed(1)} ${point.cy.toFixed(1)}`,
          )
          .join("")
      : ""
  return {
    width,
    height,
    plot,
    xScale,
    yScale,
    points,
    frontierPath,
    clusters: clusterPoints(points),
  }
}

/** Groups of two or more points whose centres are within CLUSTER_PX of each other. */
export function clusterPoints(points: ReadonlyArray<{ id: string; cx: number; cy: number }>) {
  const parent = new Map(points.map((point) => [point.id, point.id]))
  const find = (id: string): string => {
    const next = parent.get(id)!
    return next === id ? id : find(next)
  }
  for (const [index, a] of points.entries())
    for (const b of points.slice(index + 1))
      if (Math.hypot(a.cx - b.cx, a.cy - b.cy) <= CLUSTER_PX) parent.set(find(a.id), find(b.id))
  const groups = new Map<string, string[]>()
  for (const point of points)
    groups.set(find(point.id), [...(groups.get(find(point.id)) ?? []), point.id])
  return [...groups.values()].filter((group) => group.length > 1)
}

/** Where each member of a cluster is drawn while it is fanned out: evenly around its centre. */
export function fanOut(
  members: ReadonlyArray<{ id: string; cx: number; cy: number }>,
  radius = 16,
) {
  const centre = {
    x: members.reduce((sum, member) => sum + member.cx, 0) / members.length,
    y: members.reduce((sum, member) => sum + member.cy, 0) / members.length,
  }
  return new Map(
    members.map((member, index) => {
      const angle = -Math.PI / 2 + (index / members.length) * Math.PI * 2
      return [
        member.id,
        { cx: centre.x + Math.cos(angle) * radius, cy: centre.y + Math.sin(angle) * radius },
      ] as const
    }),
  )
}

/** Arrow-key travel through points, left to right then bottom to top. Returns the next id. */
export function nextPointID(
  points: ReadonlyArray<{ id: string; cx: number; cy: number }>,
  currentID: string | null,
  key: string,
) {
  const order = points.toSorted((a, b) => a.cx - b.cx || b.cy - a.cy)
  if (!order.length) return undefined
  const index = order.findIndex((point) => point.id === currentID)
  if (key === "Home") return order[0]!.id
  if (key === "End") return order.at(-1)!.id
  if (key === "ArrowRight" || key === "ArrowDown")
    return order[index < 0 ? 0 : Math.min(order.length - 1, index + 1)]!.id
  if (key === "ArrowLeft" || key === "ArrowUp") return order[Math.max(0, index - 1)]!.id
  return undefined
}
