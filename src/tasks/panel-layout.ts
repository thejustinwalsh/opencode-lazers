export const SPLIT_MIN = 20
export const SPLIT_MAX = 75
/** The list share when content fills it; also the legacy stored default. */
export const SPLIT_DEFAULT = 48
export const TASK_ROW_HEIGHT = 32
export const PLAN_HEADING_HEIGHT = 28

export function clampSplit(value: number) {
  return Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, value))
}

export function splitFromPointer(
  current: number,
  rootTop: number,
  rootHeight: number,
  headerHeight: number,
  separatorHeight: number,
  pointerY: number,
) {
  const available = rootHeight - headerHeight - separatorHeight
  if (!Number.isFinite(available) || available <= 0) return clampSplit(current)
  return clampSplit(((pointerY - rootTop - headerHeight) / available) * 100)
}

/**
 * Fit a sparse list so the inspector gets the rest; a full list keeps the default share.
 * `extra` covers list padding, notes and the Load more control.
 */
export function contentSplit(input: {
  rows: number
  headings: number
  extra: number
  available: number
}) {
  if (!Number.isFinite(input.available) || input.available <= 0) return SPLIT_DEFAULT
  const needed =
    input.rows * TASK_ROW_HEIGHT + input.headings * PLAN_HEADING_HEIGHT + Math.max(0, input.extra)
  return Math.max(SPLIT_MIN, Math.min(SPLIT_DEFAULT, Math.ceil((needed / input.available) * 100)))
}

/** Stored splits predating the explicit flag count as user-set unless they equal the default. */
export function splitWasAdjusted(view: { split: number; splitAdjusted?: boolean }) {
  return view.splitAdjusted ?? view.split !== SPLIT_DEFAULT
}
