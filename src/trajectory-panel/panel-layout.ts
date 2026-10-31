export function clampSplit(value: number) {
  return Math.max(20, Math.min(75, value))
}

/** Keep the endpoints and thin intermediate labels to fit the measured plot width. */
export function visibleTicks<T extends { elapsedMs: number; label: string }>(
  ticks: readonly T[],
  durationMs: number,
  width: number,
): T[] {
  if (ticks.length < 2 || durationMs <= 0) return [...ticks]
  const spacing = Math.max(40, ...ticks.map((tick) => tick.label.length * 8 + 12))
  const selected = [ticks[0]!]
  const last = ticks[ticks.length - 1]!
  const position = (tick: T) => (tick.elapsedMs / durationMs) * Math.max(0, width)
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
