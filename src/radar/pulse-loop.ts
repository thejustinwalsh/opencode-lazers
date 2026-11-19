import { MAX_TOTAL, PulsePool } from "./pulse-pool.ts"
import type { WireInput } from "./pulse-pool.ts"

/** What the loop needs from its environment; tests pass fakes for all of it. */
export type PulseHost = {
  requestFrame(callback: (time: number) => void): number
  cancelFrame(handle: number): void
  /** Milliseconds on the same clock the frame callback receives. */
  now(): number
  /** False while the tab is hidden or the canvas is off screen. */
  visible(): boolean
  /** True when the person asked for reduced motion; pulses then stay static. */
  reducedMotion(): boolean
  /** Least milliseconds between drawn frames; positions are time-based, so skipping costs nothing. */
  minFrameMs?: number
}

/** 30 fps: a 90 px/s dot moves 3 px between draws, and the compositor interpolates nothing. */
export const FRAME_MS = 33

export const browserHost = (): PulseHost => ({
  requestFrame: (callback) => globalThis.requestAnimationFrame(callback),
  cancelFrame: (handle) => globalThis.cancelAnimationFrame(handle),
  now: () => globalThis.performance.now(),
  minFrameMs: FRAME_MS,
  visible: () => !globalThis.document?.hidden,
  reducedMotion: () => {
    try {
      return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
    } catch {
      return false
    }
  },
})

type Dot = HTMLElement & { __dim?: boolean; __at?: string }

/**
 * The one animation driver of the Flow view. It owns the pulse pool and a recycled set of small
 * HTML dots in `layer`, an absolutely positioned layer over the SVG canvas, outside Solid's render
 * path. Dots move only by `transform: translate3d` on their own compositor layers, so a frame
 * never invalidates layout or repaints the SVG. A re-render, a live update or a layout change
 * reaches the loop only through `update`, which re-syncs wires and never touches a pulse in
 * flight. One `requestAnimationFrame` loop runs, at most every `minFrameMs`, only while there is
 * something to move, the view is visible and motion is allowed.
 */
export function createPulseLoop(layer: Element, host: PulseHost = browserHost()) {
  const pool = new PulsePool()
  const dots: Dot[] = []
  let shown = 0
  let handle: number | undefined
  let disposed = false
  let drawn = Number.NEGATIVE_INFINITY
  const stats = { frames: 0, started: 0 }

  const place = (dot: Dot, x: number, y: number) => {
    const value = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`
    if (dot.__at === value) return
    dot.__at = value
    dot.style.transform = value
  }
  const dotAt = (index: number) => {
    let dot = dots[index]
    if (!dot) {
      dot = layer.ownerDocument.createElement("div") as Dot
      dot.className = "lazers-radar-flow-dot"
      layer.append(dot)
      dots[index] = dot
    }
    return dot
  }
  const draw = () => {
    let index = 0
    pool.forEach((_id, x, y, _fraction, dim) => {
      if (index >= MAX_TOTAL) return
      const dot = dotAt(index++)
      place(dot, x, y)
      if (dot.__dim !== dim) {
        dot.__dim = dim
        dot.setAttribute("data-dim", String(dim))
      }
    })
    for (let hide = index; hide < shown; hide++) place(dots[hide]!, -20, -20)
    shown = index
  }
  const enabled = () => !disposed && pool.active && host.visible() && !host.reducedMotion()
  const frame = (time: number) => {
    handle = undefined
    if (!enabled()) return
    if (time - drawn < (host.minFrameMs ?? 0)) return schedule()
    drawn = time
    stats.frames++
    pool.step(time)
    draw()
    schedule()
  }
  const schedule = () => {
    if (handle !== undefined || !enabled()) return
    handle = host.requestFrame(frame)
  }
  const stop = () => {
    if (handle !== undefined) host.cancelFrame(handle)
    handle = undefined
  }
  const onVisibility = () => {
    if (host.visible()) {
      // Time spent hidden is not travel: restart the clock instead of jumping every pulse home.
      pool.resume(host.now())
      drawn = Number.NEGATIVE_INFINITY
      schedule()
    } else stop()
  }
  globalThis.document?.addEventListener?.("visibilitychange", onVisibility)

  return {
    /** Current layout's wires. Safe on every render: pulses in flight are never reset. */
    update(wires: readonly WireInput[]) {
      pool.sync(wires, host.now())
      if (host.reducedMotion()) return
      schedule()
    },
    /** Re-check visibility, e.g. from an IntersectionObserver. */
    wake() {
      onVisibility()
    },
    get running() {
      return handle !== undefined
    },
    get stats() {
      return stats
    },
    get pool() {
      return pool
    },
    dispose() {
      disposed = true
      stop()
      globalThis.document?.removeEventListener?.("visibilitychange", onVisibility)
      for (const dot of dots) dot.remove()
    },
  }
}
