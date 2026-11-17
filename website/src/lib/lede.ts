import {
  layoutNextLine,
  prepareWithSegments,
  type LayoutCursor,
  type PreparedTextWithSegments,
} from "@chenglou/pretext"
import { CAT_CONTOUR } from "../assets/cat-geometry"

export interface LedeParts {
  /** Positioned container the lines are laid out in. */
  box: HTMLElement
  /** The original paragraph; stays in the DOM for assistive technology. */
  source: HTMLElement
  /** aria-hidden container that receives the positioned lines. */
  lines: HTMLElement
  /** Un-translated rest frame of the cat sprite (parallax drift happens inside it). */
  catFrame: HTMLElement
}

const MIN_SLOT = 150 // px: narrower free runs are skipped, never filled with one word
const PAD = 22 // px clearance around the cat contour (absorbs parallax drift)

type Slot = { x: number; w: number }

/** Free runs for a line band after subtracting the cat contour's intrusion. */
function freeSlots(
  boxW: number,
  band: [number, number],
  cat: { x: number; y: number; w: number; h: number },
): Slot[] {
  const rows = CAT_CONTOUR.length
  const r0 = Math.floor(((band[0] - cat.y) / cat.h) * rows)
  const r1 = Math.ceil(((band[1] - cat.y) / cat.h) * rows) - 1
  let left = Infinity
  let right = -Infinity
  for (let r = Math.max(0, r0); r <= Math.min(rows - 1, r1); r++) {
    const span = CAT_CONTOUR[r]
    if (!span) continue
    left = Math.min(left, cat.x + span[0] * cat.w - PAD)
    right = Math.max(right, cat.x + span[1] * cat.w + PAD)
  }
  if (right < left) return [{ x: 0, w: boxW }]
  const slots: Slot[] = []
  if (left > MIN_SLOT) slots.push({ x: 0, w: Math.min(left, boxW) })
  if (boxW - right > MIN_SLOT) slots.push({ x: Math.max(0, right), w: boxW - Math.max(0, right) })
  return slots
}

export async function enhanceLede(parts: LedeParts): Promise<() => void> {
  const { box, source, lines, catFrame } = parts
  const text = (source.textContent ?? "").trim()
  const cs = getComputedStyle(source)
  const font = `${cs.fontWeight} ${cs.fontSize} "Archivo Variable"`
  const lineHeight = parseFloat(cs.lineHeight)
  if (!text || !Number.isFinite(lineHeight)) return () => {}

  await document.fonts.load(font, text)
  if (!document.fonts.check(font, text)) return () => {}

  // Prepared once; resize and parallax only re-run layout.
  const prepared: PreparedTextWithSegments = prepareWithSegments(text, font)
  let hidden = false
  let frame = 0

  const layout = () => {
    const b = box.getBoundingClientRect()
    const c = catFrame.getBoundingClientRect()
    const cat = { x: c.left - b.left, y: c.top - b.top, w: c.width, h: c.height }
    const boxW = b.width
    const out: HTMLElement[] = []
    let cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 }
    let y = 0
    let guard = 0
    while (guard++ < 400) {
      const slots = freeSlots(boxW, [y, y + lineHeight], cat)
      if (slots.length === 0) {
        y += lineHeight
        continue
      }
      const slot = slots.reduce((a, s) => (s.w > a.w ? s : a))
      const line = layoutNextLine(prepared, slot.w, cursor)
      if (!line) break
      const span = document.createElement("span")
      span.textContent = line.text
      span.style.cssText = `position:absolute;left:${slot.x.toFixed(1)}px;top:${y.toFixed(1)}px;white-space:pre`
      out.push(span)
      cursor = line.end
      y += lineHeight
    }
    lines.replaceChildren(...out)
    box.style.minHeight = `${Math.ceil(y)}px`
    if (!hidden) {
      // Visually hidden, not display:none: the paragraph stays in the accessibility tree.
      Object.assign(source.style, {
        position: "absolute",
        width: "1px",
        height: "1px",
        overflow: "hidden",
        clipPath: "inset(50%)",
        whiteSpace: "nowrap",
      })
      hidden = true
    }
  }

  const schedule = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(layout)
  }
  layout()
  const ro = new ResizeObserver(schedule)
  ro.observe(box)
  ro.observe(catFrame)
  window.addEventListener("resize", schedule)
  return () => {
    ro.disconnect()
    window.removeEventListener("resize", schedule)
    cancelAnimationFrame(frame)
  }
}
