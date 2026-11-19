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
}

export const browserHost = (): PulseHost => ({
  requestFrame: (callback) => globalThis.requestAnimationFrame(callback),
  cancelFrame: (handle) => globalThis.cancelAnimationFrame(handle),
  now: () => globalThis.performance.now(),
  visible: () => !globalThis.document?.hidden,
  reducedMotion: () => {
    try {
      return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
    } catch {
      return false
    }
  },
})

type Dot = SVGCircleElement & { __dim?: boolean }

/**
 * The one animation driver of the Flow view. It owns the pulse pool and a recycled set of circles
 * in `layer`, outside Solid's render path: a re-render, a live update or a layout change reaches
 * it only through `update`, which re-syncs wires and never touches a pulse in flight. One
 * `requestAnimationFrame` loop runs only while there is something to move, the view is visible and
 * motion is allowed.
 */
export function createPulseLoop(layer: Element, host: PulseHost = browserHost()) {
  const pool = new PulsePool()
  const dots: Dot[] = []
  let shown = 0
  let handle: number | undefined
  let disposed = false
  const stats = { frames: 0, started: 0 }

  const place = (dot: Dot, x: number, y: number) => {
    const list = (dot as unknown as { transform?: SVGAnimatedTransformList }).transform?.baseVal
    if (list && list.numberOfItems > 0) list.getItem(0).setTranslate(x, y)
    else dot.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`)
  }
  const dotAt = (index: number) => {
    let dot = dots[index]
    if (!dot) {
      dot = layer.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "circle") as Dot
      dot.setAttribute("class", "lazers-radar-flow-dot")
      dot.setAttribute("r", "1.8")
      dot.setAttribute("cx", "0")
      dot.setAttribute("cy", "0")
      dot.setAttribute("transform", "translate(0 0)")
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
    for (let hide = index; hide < shown; hide++)
      dots[hide]!.setAttribute("transform", "translate(-20 -20)")
    shown = index
  }
  const enabled = () => !disposed && pool.active && host.visible() && !host.reducedMotion()
  const frame = (time: number) => {
    handle = undefined
    if (!enabled()) return
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
