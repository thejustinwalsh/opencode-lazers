/**
 * Pure zoom and pan maths for the trajectory timeline.
 *
 * The plot scrolls horizontally inside a viewport. `fitPx` is the width of the time track when
 * the whole timeline fits (zoom 1); at zoom `z` the track is `fitPx * z` wide, so the scroll range
 * is exactly `[0, fitPx * (z - 1)]`. Positions inside the track are measured in px from its left
 * edge, which is where the sticky label column ends.
 */

export type Viewport = { zoom: number; scrollLeft: number }

/**
 * A feature (a tool call, an attempt rail, the gap between two marks) reads comfortably when it is
 * this wide: wider than the 14 px mark hit target, with room for its outline.
 */
export const COMFORT_PX = 24

/**
 * Browsers stop laying out boxes wider than about 33.5 million px (Chrome and Safari: 2^25 - 1;
 * Firefox is lower per element but well above this). Half of that leaves headroom for the label
 * column, borders and the end padding, so a very long timeline cannot zoom into a blank plot.
 */
export const MAX_PLOT_PX = 16_000_000

/** Pointer travel before a press becomes a drag; below it the gesture stays a click. */
export const DRAG_SLOP_PX = 4

/** Fraction of the viewport one arrow-key press pans. */
export const KEY_PAN_SHARE = 0.15

/** The most one wheel event may zoom by, so a mouse-wheel notch is a step, not a leap. */
const WHEEL_STEP_LIMIT = 40
/** Zoom per wheel delta unit: a trackpad pinch (deltas of 1 to 5) zooms smoothly. */
const WHEEL_SENSITIVITY = 0.01
/** The multiplier a button or key press zooms by. */
const ZOOM_STEP = 2

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/** Range of valid scroll offsets: the whole track minus what the viewport already shows. */
const scrollRange = (zoom: number, fitPx: number) => Math.max(0, fitPx * (zoom - 1))

export const clampScroll = (scrollLeft: number, zoom: number, fitPx: number) =>
  clamp(scrollLeft, 0, scrollRange(zoom, fitPx))

/**
 * The smallest positive extent (in percent of the track) among the features the person may need
 * to tell apart: span widths, and the distances between distinct neighbouring mark positions.
 * Zero-width and coincident marks carry no extent and are skipped.
 */
export function shortestFeature(
  spans: readonly number[],
  positions: readonly number[],
): number | null {
  let shortest = Infinity
  for (const width of spans) if (width > 0 && width < shortest) shortest = width
  const sorted = [...positions].sort((a, b) => a - b)
  for (let index = 1; index < sorted.length; index++) {
    const distance = sorted[index]! - sorted[index - 1]!
    if (distance > 0 && distance < shortest) shortest = distance
  }
  return Number.isFinite(shortest) ? shortest : null
}

/**
 * The deepest useful zoom: the one that makes the shortest feature `COMFORT_PX` wide, bounded
 * by the layout limit. With no measurable feature there is nothing finer to inspect, so the
 * timeline stays fitted. The minimum zoom is always 1 (fit).
 */
export function maxZoom(shortestPercent: number | null, fitPx: number): number {
  if (fitPx <= 0 || shortestPercent === null || shortestPercent <= 0) return 1
  const wanted = COMFORT_PX / ((shortestPercent / 100) * fitPx)
  return Math.max(1, Math.min(wanted, MAX_PLOT_PX / fitPx))
}

const clampZoom = (zoom: number, max: number) => clamp(zoom, 1, Math.max(1, max))

/** The zoom a button or key press steps to, snapping to fit and to the maximum. */
export function stepZoom(current: number, direction: 1 | -1, max: number) {
  const next = direction === 1 ? current * ZOOM_STEP : current / ZOOM_STEP
  return clampZoom(next, max)
}

/** Zoom multiplier for one wheel event. Negative `deltaY` (scroll up / pinch out) zooms in. */
export function wheelZoomFactor(deltaY: number, deltaMode = 0) {
  // deltaMode 1 is lines, 2 is pages; normalise to pixels so one notch reads the same everywhere.
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 100 : deltaY
  return Math.exp(-clamp(pixels, -WHEEL_STEP_LIMIT, WHEEL_STEP_LIMIT) * WHEEL_SENSITIVITY)
}

/**
 * Zoom to `nextZoom` keeping the time under `anchorPx` (px from the track's left edge, within
 * the visible track) under the same screen position.
 */
export function zoomAbout(
  view: Viewport,
  nextZoom: number,
  anchorPx: number,
  fitPx: number,
  max: number,
): Viewport {
  const zoom = clampZoom(nextZoom, max)
  if (fitPx <= 0 || zoom === view.zoom)
    return { zoom, scrollLeft: clampScroll(view.scrollLeft, zoom, fitPx) }
  const anchor = clamp(anchorPx, 0, fitPx)
  const fraction = (view.scrollLeft + anchor) / (fitPx * view.zoom)
  return { zoom, scrollLeft: clampScroll(fraction * fitPx * zoom - anchor, zoom, fitPx) }
}

export function panBy(view: Viewport, deltaPx: number, fitPx: number): Viewport {
  return { zoom: view.zoom, scrollLeft: clampScroll(view.scrollLeft + deltaPx, view.zoom, fitPx) }
}
