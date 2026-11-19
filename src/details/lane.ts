import { durationText } from "./format.ts"

export type LaneTick = {
  /** Milliseconds since the lane origin. */
  at: number
  failed?: boolean
  /** Opaque id returned on the mark that holds this tick. */
  id?: string
}

export type LaneMark = {
  /** Percent of the active segment's width. */
  left: number
  failed: boolean
  /** Ticks merged into this mark (more than one when they share a bucket). */
  count: number
  selected: boolean
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
/** Track share one collapsed idle span takes, however long it was. */
const IDLE_WIDTH = 14
const MIN_ACTIVE_WIDTH = 3

/**
 * Pure layout for the Activity lane. Ticks are sorted, split into active segments at every quiet
 * stretch of `idleMinMs` or more, and each idle stretch collapses to a fixed share of the track
 * with a label (`1d 19h idle`). Active segments share the rest by their duration. Within a
 * segment ticks are merged into at most `maxMarks` buckets, so the DOM stays bounded for
 * thousands of ticks; a bucket is failed when any tick in it failed and selected when it holds the
 * selected tick.
 */
export function laneLayout(input: LaneInput): LaneSegment[] {
  const idleMin = input.idleMinMs ?? IDLE_MIN_MS
  const maxMarks = Math.max(1, input.maxMarks ?? 120)
  const ticks = [...input.ticks].sort((a, b) => a.at - b.at)
  const duration = Math.max(input.durationMs ?? 0, ticks.at(-1)?.at ?? 0)
  if (duration <= 0 && ticks.length === 0) return []

  const spans: Array<{ kind: "active" | "idle"; start: number; end: number; ticks: LaneTick[] }> =
    []
  let start = 0
  let group: LaneTick[] = []
  let previous = 0
  const closeActive = (end: number) => {
    if (!group.length && end <= start) return
    spans.push({ kind: "active", start, end, ticks: group })
    group = []
  }
  for (const tick of ticks) {
    if (tick.at - previous >= idleMin) {
      if (group.length) closeActive(previous)
      else if (previous > start) closeActive(previous)
      spans.push({ kind: "idle", start: previous, end: tick.at, ticks: [] })
      start = tick.at
    }
    group.push(tick)
    previous = tick.at
  }
  if (duration - previous >= idleMin) {
    closeActive(previous)
    spans.push({ kind: "idle", start: previous, end: duration, ticks: [] })
  } else closeActive(Math.max(previous, duration))

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
    }
    mark.count += 1
    mark.failed ||= tick.failed === true
    mark.selected ||= selectedId !== undefined && tick.id === selectedId
    buckets.set(bucket, mark)
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, mark]) => mark)
}
