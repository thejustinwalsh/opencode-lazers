/**
 * The one time-to-position transform for the trajectory plot. Attempt rails, check intervals,
 * tool and file marks, ruler ticks, gridlines and idle breaks all place themselves through
 * `Axis.place`, so they stay aligned through compression, zoom and scroll.
 *
 * A known idle stretch (no recorded activity for `IDLE_MIN_MS` or more) is drawn as a narrow
 * break. Real timestamps are never altered: only their screen position is.
 */

export const IDLE_MIN_MS = 60_000
const IDLE_SHOWN_MIN_MS = 8_000
const IDLE_SHOWN_SHARE = 0.02

export type IdleSpan = { startMs: number; endMs: number }

export type Axis = {
  /** Elapsed milliseconds since the origin, as a percent of the plot width. */
  place: (elapsedMs: number) => number
  /** Compressed idle stretches in elapsed time, in order. */
  idle: readonly IdleSpan[]
}

type Piece = { start: number; end: number; shownStart: number; shownEnd: number }

export function linearAxis(durationMs: number): Axis {
  return {
    place: (elapsed) =>
      durationMs <= 0 ? 0 : Math.max(0, Math.min(100, (elapsed / durationMs) * 100)),
    idle: [],
  }
}

/**
 * `activity` is every recorded elapsed time the plot must show. Pass `compress: false` while
 * history is still loading: unloaded time is not idle time.
 */
export function buildAxis(
  durationMs: number,
  activity: readonly number[],
  compress: boolean,
): Axis {
  if (!compress || durationMs <= 0) return linearAxis(durationMs)
  const points = [...new Set([0, ...activity.filter((at) => at >= 0 && at <= durationMs)])].sort(
    (a, b) => a - b,
  )
  const idle: IdleSpan[] = []
  for (let index = 1; index < points.length; index++)
    if (points[index]! - points[index - 1]! >= IDLE_MIN_MS)
      idle.push({ startMs: points[index - 1]!, endMs: points[index]! })
  if (idle.length === 0) return linearAxis(durationMs)

  const shown = Math.max(IDLE_SHOWN_MIN_MS, durationMs * IDLE_SHOWN_SHARE)
  const pieces: Piece[] = []
  let cursor = 0
  let visible = 0
  const push = (start: number, end: number, length: number) => {
    pieces.push({ start, end, shownStart: visible, shownEnd: visible + length })
    visible += length
    cursor = end
  }
  for (const span of idle) {
    if (span.startMs > cursor) push(cursor, span.startMs, span.startMs - cursor)
    push(span.startMs, span.endMs, Math.min(shown, span.endMs - span.startMs))
  }
  if (durationMs > cursor) push(cursor, durationMs, durationMs - cursor)
  const total = visible

  return {
    idle,
    place: (elapsed) => {
      const at = Math.max(0, Math.min(durationMs, elapsed))
      const piece = pieces.find((candidate) => at <= candidate.end) ?? pieces[pieces.length - 1]!
      const share = piece.end === piece.start ? 0 : (at - piece.start) / (piece.end - piece.start)
      const shownAt = piece.shownStart + share * (piece.shownEnd - piece.shownStart)
      return Math.max(0, Math.min(100, (shownAt / total) * 100))
    },
  }
}
