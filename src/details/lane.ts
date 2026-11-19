import { durationText } from "./format.ts"

export type LaneTick = {
  /** Milliseconds since the lane origin. */
  at: number
  failed?: boolean
  /** Opaque id returned on the mark that holds this tick. */
  id?: string
  /** What the tick is (`Read`, `Check`), for its hover. */
  label?: string
  /** How long the call took, for its hover. */
  durationMs?: number
}

export type LaneMark = {
  /** Percent of the active segment's width. */
  left: number
  failed: boolean
  /** Ticks merged into this mark (more than one when they share a bucket). */
  count: number
  selected: boolean
  /** Span of the ticks in this mark, in ms since the lane origin. */
  fromMs: number
  toMs: number
  /** Set only when the mark holds exactly one tick that has them. */
  label?: string
  durationMs?: number
}

export type LaneSegment =
  | { kind: "active"; startMs: number; endMs: number; width: number; marks: LaneMark[] }
  | { kind: "idle"; startMs: number; endMs: number; width: number; label: string }

export type LaneInput = {
  ticks: readonly LaneTick[]
  /** Lane span in ms; defaults to the last tick. */
  durationMs?: number
  /** A quiet stretch this long becomes a collapsed, labelled span. */
  idleMinMs?: number
  /** Id of the selected tick; its mark is outlined. */
  selectedId?: string
  /** Most marks drawn per active segment however many ticks there are. */
  maxMarks?: number
}

const IDLE_MIN_MS = 60_000
/** A quiet stretch also has to be this share of the whole span to collapse. */
const IDLE_MIN_SHARE = 0.08
/** Quiet stretches collapsed at most; the largest win, the rest stay proportional space. */
const MAX_IDLE_SPANS = 3
/** Track share a collapsed idle span takes: enough for its label, however long it was. */
const IDLE_WIDTH = 10
const MIN_ACTIVE_WIDTH = 3

/**
 * Pure layout for the Activity lane. Ticks are sorted and the quiet stretches that dominate the
 * span (at least `idleMinMs` and 8 % of the whole, the three largest) collapse to labelled idle
 * spans of a small fixed width (`1d 20h idle`); every other gap stays empty space inside an active
 * segment. Active segments share the rest of the track by their duration. Within a segment ticks
 * are merged into at most `maxMarks` buckets, so the DOM stays bounded for thousands of ticks; a
 * bucket is failed when any tick in it failed and selected when it holds the selected tick.
 */
export function laneLayout(input: LaneInput): LaneSegment[] {
  const idleMin = input.idleMinMs ?? IDLE_MIN_MS
  const maxMarks = Math.max(1, input.maxMarks ?? 120)
  const ticks = [...input.ticks].sort((a, b) => a.at - b.at)
  const duration = Math.max(input.durationMs ?? 0, ticks.at(-1)?.at ?? 0)
  if (duration <= 0 && ticks.length === 0) return []

  // Gap `index` precedes tick `index`; the trailing gap has index `ticks.length`.
  const gapBounds = (index: number) => ({
    from: index === 0 ? 0 : ticks[index - 1]!.at,
    to: index === ticks.length ? duration : ticks[index]!.at,
  })
  const collapsed = new Set(
    Array.from({ length: ticks.length + 1 }, (_, index) => {
      const { from, to } = gapBounds(index)
      return { index, size: to - from }
    })
      .filter((gap) => gap.size >= idleMin && gap.size >= duration * IDLE_MIN_SHARE)
      .toSorted((left, right) => right.size - left.size)
      .slice(0, MAX_IDLE_SPANS)
      .map((gap) => gap.index),
  )

  const spans: Array<{ kind: "active" | "idle"; start: number; end: number; ticks: LaneTick[] }> =
    []
  let start = 0
  let group: LaneTick[] = []
  const closeActive = (end: number) => {
    if (!group.length && end <= start) return
    spans.push({ kind: "active", start, end, ticks: group })
    group = []
  }
  for (let index = 0; index <= ticks.length; index++) {
    if (collapsed.has(index)) {
      const { from, to } = gapBounds(index)
      closeActive(from)
      spans.push({ kind: "idle", start: from, end: to, ticks: [] })
      start = to
    }
    if (index < ticks.length) group.push(ticks[index]!)
  }
  closeActive(Math.max(ticks.at(-1)?.at ?? 0, duration))

  const idleCount = spans.filter((span) => span.kind === "idle").length
  const activeShare = Math.max(MIN_ACTIVE_WIDTH, 100 - idleCount * IDLE_WIDTH)
  const activeTotal = spans
    .filter((span) => span.kind === "active")
    .reduce((sum, span) => sum + Math.max(span.end - span.start, 1), 0)
  const raw = spans.map((span) =>
    span.kind === "idle"
      ? IDLE_WIDTH
      : Math.max(
          MIN_ACTIVE_WIDTH,
          (Math.max(span.end - span.start, 1) / activeTotal) * activeShare,
        ),
  )
  const scale = 100 / raw.reduce((sum, width) => sum + width, 0)

  return spans.map((span, index): LaneSegment => {
    const width = raw[index]! * scale
    if (span.kind === "idle")
      return {
        kind: "idle",
        startMs: span.start,
        endMs: span.end,
        width,
        label: `${durationText(span.end - span.start)} idle`,
      }
    return {
      kind: "active",
      startMs: span.start,
      endMs: span.end,
      width,
      marks: marksFor(span.ticks, span.start, span.end, maxMarks, input.selectedId),
    }
  })
}

function marksFor(
  ticks: readonly LaneTick[],
  start: number,
  end: number,
  maxMarks: number,
  selectedId: string | undefined,
): LaneMark[] {
  const length = Math.max(end - start, 1)
  const buckets = new Map<number, LaneMark>()
  for (const tick of ticks) {
    const bucket = Math.min(maxMarks - 1, Math.floor(((tick.at - start) / length) * maxMarks))
    const mark = buckets.get(bucket) ?? {
      left: ((bucket + 0.5) / maxMarks) * 100,
      failed: false,
      count: 0,
      selected: false,
      fromMs: tick.at,
      toMs: tick.at,
    }
    mark.count += 1
    mark.fromMs = Math.min(mark.fromMs, tick.at)
    mark.toMs = Math.max(mark.toMs, tick.at)
    if (mark.count === 1) {
      if (tick.label) mark.label = tick.label
      if (tick.durationMs !== undefined) mark.durationMs = tick.durationMs
    } else {
      delete mark.label
      delete mark.durationMs
    }
    mark.failed ||= tick.failed === true
    mark.selected ||= selectedId !== undefined && tick.id === selectedId
    buckets.set(bucket, mark)
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, mark]) => mark)
}
