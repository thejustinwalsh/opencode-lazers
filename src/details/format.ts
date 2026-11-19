/**
 * Number formatting every details pane shares. These are the existing Trajectory formatters, not
 * a second set: `durationText` (240ms, 18s, 4m 47s, 48m, 1h 02m, 1d 20h) and `compactCount`
 * (950, 20.3k, 16M, 1.2B).
 */
export { compactCount, durationText } from "../trajectory-panel/projection.ts"

/** `17 · 5 files`: the Calls stat. A zero or missing file count is left out. */
export function callsText(calls: number, files?: number) {
  const base = String(calls)
  return files ? `${base} · ${files} ${files === 1 ? "file" : "files"}` : base
}
