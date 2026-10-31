export function clampSplit(value: number) {
  return Math.max(20, Math.min(80, value))
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
