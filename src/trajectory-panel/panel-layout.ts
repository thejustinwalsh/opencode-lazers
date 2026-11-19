/** Keep the endpoints and thin intermediate labels to fit the measured plot width. */
export function visibleTicks<T extends { elapsedMs: number; label: string }>(
  ticks: readonly T[],
  durationMs: number,
  width: number,
  /** Percent position of an elapsed time; defaults to linear. The shared axis supplies it. */
  place: (elapsedMs: number) => number = (elapsedMs) => (elapsedMs / durationMs) * 100,
): T[] {
  if (ticks.length < 2 || durationMs <= 0) return [...ticks]
  const spacing = Math.max(40, ...ticks.map((tick) => tick.label.length * 8 + 12))
  const selected = [ticks[0]!]
  const last = ticks[ticks.length - 1]!
  const position = (tick: T) => (place(tick.elapsedMs) / 100) * Math.max(0, width)
  for (const tick of ticks.slice(1, -1)) {
    if (
      position(tick) - position(selected[selected.length - 1]!) >= spacing &&
      position(last) - position(tick) >= spacing
    )
      selected.push(tick)
  }
  if (position(last) - position(selected[0]!) >= spacing) selected.push(last)
  return selected
}

/** Estimated width of a mono ruler label: ~6.5 px a character plus a little breathing room. */
const labelWidth = (label: string, padding: number) => label.length * 6.5 + padding

export type RulerBreak = {
  startMs: number
  endMs: number
  left: number
  width: number
  label: string
}

/**
 * Ruler text for one plot width. Idle-break labels are placed first, longest break first, each
 * only when clear of the labels already placed. Tick labels then yield: any tick whose text would
 * touch a shown break label is dropped. A break whose label does not fit keeps its band.
 */
export function rulerLabels<T extends { elapsedMs: number; label: string }>(
  ticks: readonly T[],
  breaks: readonly RulerBreak[],
  durationMs: number,
  width: number,
  place: (elapsedMs: number) => number,
): { ticks: T[]; breaks: RulerBreak[] } {
  const taken: Array<[number, number]> = []
  const shown = new Set<RulerBreak>()
  const byLength = [...breaks].sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs))
  for (const span of byLength) {
    const center = ((span.left + span.width / 2) / 100) * width
    const half = labelWidth(span.label, 10) / 2
    if (center - half < 0 || center + half > width) continue
    if (taken.some(([from, to]) => center - half < to && center + half > from)) continue
    taken.push([center - half, center + half])
    shown.add(span)
  }
  const kept = visibleTicks(ticks, durationMs, width, place).filter((tick) => {
    const center = (place(tick.elapsedMs) / 100) * width
    const half = labelWidth(tick.label, 8) / 2
    return !taken.some(([from, to]) => center - half < to && center + half > from)
  })
  return { ticks: kept, breaks: breaks.filter((span) => shown.has(span)) }
}

/** Whole seconds in "Still loading · 40 s", or null when the line carries none. */
export function slowSeconds(line: string): number | null {
  const match = /(\d+)\s*s\b/.exec(line)
  return match ? Number(match[1]) : null
}

/** Estimated width of one mono ruler character, in px. */
export const LABEL_CHAR_PX = 6.5
/** The widest mark hit target, centred on its time. */
const MARK_HIT_PX = 14

/**
 * Room kept at the right end of the fitted timeline: half the widest tick label plus 8 px, so the
 * last label and the last mark stay fully inside the panel (the scrollbar gutter is separate).
 */
export function endPadding(labels: readonly string[]) {
  const widest = Math.max(0, ...labels.map((label) => label.length))
  return Math.ceil((widest * LABEL_CHAR_PX) / 2) + 8
}

/** Right edge, in px from the track's left, of a ruler label centred at `centerPercent`. */
export const labelRightEdge = (centerPercent: number, label: string, trackPx: number) =>
  (centerPercent / 100) * trackPx + (label.length * LABEL_CHAR_PX) / 2

/** Right edge, in px from the track's left, of a mark whose time is at `percent`. */
export const markRightEdge = (percent: number, trackPx: number, widthPercent = 0) =>
  ((percent + widthPercent) / 100) * trackPx + MARK_HIT_PX / 2
