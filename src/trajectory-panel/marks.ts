/**
 * Mark shapes for the timeline tracks, decided in screen pixels.
 *
 *   tick  an instant, or a call too short to show a span: one 2 px bar
 *   span  a call with a recorded duration wide enough to draw: a 3 px line with end caps ("H")
 *   run   marks whose drawn extents come within MIN_GAP_PX of each other: one solid span over the
 *         union, so neighbours never smear into an unreadable block
 *
 * Time positions are never moved. A run only changes how its members are drawn; each member keeps
 * its own hit target and selection.
 */

/** Drawn width of a tick. */
const TICK_PX = 2
/** Narrowest recorded duration that is drawn as a span rather than a tick. */
export const SPAN_MIN_PX = 6
/** Marks closer than this are drawn as one run. */
export const MIN_GAP_PX = 3

export type MarkShape = "tick" | "span" | "run"

export type MarkInput = {
  id: string
  /** Percent of the plot width. */
  left: number
  /** Percent of the plot width; zero for an instant. */
  width: number
  failed?: boolean
}

export type MarkMember = {
  id: string
  shape: "tick" | "span"
  startPx: number
  endPx: number
  failed: boolean
}

export type MarkGlyph = {
  shape: MarkShape
  startPx: number
  endPx: number
  members: MarkMember[]
  failed: boolean
}

/** Whether a duration of `widthPercent` of a `plotPx` wide plot is drawn as a span. */
export const isSpanWidth = (widthPercent: number, plotPx: number) =>
  (widthPercent / 100) * plotPx >= SPAN_MIN_PX

/** One glyph per tick, span or run, in left-to-right order. */
export function layoutMarks(marks: readonly MarkInput[], plotPx: number): MarkGlyph[] {
  const members: MarkMember[] = marks
    .map((mark) => {
      const start = (mark.left / 100) * plotPx
      const span = isSpanWidth(mark.width, plotPx)
      return span
        ? {
            id: mark.id,
            shape: "span" as const,
            startPx: start,
            endPx: start + (mark.width / 100) * plotPx,
            failed: mark.failed === true,
          }
        : {
            id: mark.id,
            shape: "tick" as const,
            startPx: start - TICK_PX / 2,
            endPx: start + TICK_PX / 2,
            failed: mark.failed === true,
          }
    })
    .sort((a, b) => a.startPx - b.startPx || a.endPx - b.endPx)

  const glyphs: MarkGlyph[] = []
  let group: MarkMember[] = []
  let end = -Infinity
  const flush = () => {
    if (group.length === 0) return
    const only = group.length === 1 ? group[0]! : undefined
    glyphs.push({
      shape: only ? only.shape : "run",
      startPx: group[0]!.startPx,
      endPx: Math.max(...group.map((member) => member.endPx)),
      members: group,
      failed: group.every((member) => member.failed),
    })
    group = []
  }
  for (const member of members) {
    if (group.length > 0 && member.startPx - end < MIN_GAP_PX) {
      group.push(member)
      end = Math.max(end, member.endPx)
    } else {
      flush()
      group = [member]
      end = member.endPx
    }
  }
  flush()
  return glyphs
}
