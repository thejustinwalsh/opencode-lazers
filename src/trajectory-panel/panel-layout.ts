export function clampSplit(value: number) {
  return Math.max(20, Math.min(75, value))
}

export function splitFromPointer(
  current: number,
  rootTop: number,
  rootHeight: number,
  separatorHeight: number,
  pointerY: number,
) {
  const available = rootHeight - separatorHeight
  if (!Number.isFinite(available) || available <= 0) return clampSplit(current)
  return clampSplit(((pointerY - rootTop) / available) * 100)
}

export function splitFromKey(current: number, key: string, step = 5) {
  if (key === "Home") return 20
  if (key === "End") return 75
  if (key === "ArrowUp") return clampSplit(current - step)
  if (key === "ArrowDown") return clampSplit(current + step)
  return clampSplit(current)
}
