/** Pure geometry for the shared details pane. All lengths are CSS pixels. */

export const DETAILS_HEADER_HEIGHT = 32
export const DETAILS_MIN_BODY = 72
export const DETAILS_MIN_TOP = 120
export const DETAILS_DEFAULT_SIZE = 0.45
export const DETAILS_KEY_STEP = 0.05

export interface DetailsState {
  open: boolean
  /** Body height as a fraction of the pane container's height. */
  size: number
}

const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback)

/** The tallest body the container allows: the top region keeps at least 120 px. */
export function maxBodyHeight(containerHeight: number) {
  return Math.max(DETAILS_MIN_BODY, finite(containerHeight, 0) - DETAILS_MIN_TOP)
}

/** Clamp a stored fraction so the body is 72 px at least and leaves 120 px above it. */
export function clampSize(size: number, containerHeight: number) {
  const height = finite(containerHeight, 0)
  const value = finite(size, DETAILS_DEFAULT_SIZE)
  if (height <= 0) return Math.max(0, Math.min(1, value))
  const min = DETAILS_MIN_BODY / height
  const max = maxBodyHeight(height) / height
  return Math.max(min, Math.min(max, value))
}

/** The body height in pixels for a stored fraction. */
export function bodyHeight(size: number, containerHeight: number) {
  return Math.round(clampSize(size, containerHeight) * Math.max(0, finite(containerHeight, 0)))
}

/**
 * Drag result. `pointerY` is where the header's top edge should sit; the body fills the space
 * below it. A body under 72 px collapses and leaves the stored size alone.
 */
export function dragState(
  previous: DetailsState,
  input: { pointerY: number; containerTop: number; containerHeight: number },
): DetailsState {
  const height = finite(input.containerHeight, 0)
  if (height <= 0) return previous
  const body = input.containerTop + height - input.pointerY - DETAILS_HEADER_HEIGHT
  if (body < DETAILS_MIN_BODY) return { open: false, size: previous.size }
  return { open: true, size: clampSize(body / height, height) }
}

/** Up grows the body, Down shrinks it by 5 %; Down below the minimum collapses. Others: none. */
export function keyboardState(
  previous: DetailsState,
  key: string,
  containerHeight: number,
): DetailsState | undefined {
  if (key === "Enter" || key === " ") return { ...previous, open: !previous.open }
  if (key !== "ArrowUp" && key !== "ArrowDown") return undefined
  const direction = key === "ArrowUp" ? 1 : -1
  if (!previous.open) {
    return direction > 0
      ? { open: true, size: clampSize(previous.size, containerHeight) }
      : previous
  }
  const height = finite(containerHeight, 0)
  const next = previous.size + direction * DETAILS_KEY_STEP
  if (direction < 0 && height > 0 && next * height < DETAILS_MIN_BODY)
    return { open: false, size: previous.size }
  return { open: true, size: clampSize(next, height) }
}

/** Stored values are optional and untrusted: closed by default, 0.45 when the size is unusable. */
export function storedState(view: { open?: boolean; size?: number }): DetailsState {
  const size = view.size
  return {
    open: view.open === true,
    size:
      typeof size === "number" && Number.isFinite(size) && size > 0 && size <= 1
        ? size
        : DETAILS_DEFAULT_SIZE,
  }
}

/** Old layouts stored the top region's percentage; the body is what remains below it. */
export function sizeFromLegacySplit(split: number | undefined) {
  if (typeof split !== "number" || !Number.isFinite(split)) return undefined
  return Math.max(0.1, Math.min(0.8, (100 - split) / 100))
}
