import { MAX_TOTAL, WirePath, crossingMs, geometryKey, pulsesOn } from "./pulse-path.ts"
import type { WireInput } from "./pulse-path.ts"

export type PulseTiming = { durationMs: number; delayMs: number; iterations: number }

/** One pulse's journey, as the host runs it. */
export type PulseAnimation = {
  cancel(): void
  pause(): void
  play(): void
  /** Time on the animation's own clock in ms, the delay included; null when unknown. */
  elapsed(): number | null
  /** Ends the animation after this many iterations. */
  setIterations(iterations: number): void
}

/** What the loop needs from its environment; tests pass fakes for all of it. */
export type PulseHost = {
  /** False while the tab is hidden or the canvas is off screen. */
  visible(): boolean
  /** True when the person asked for reduced motion; pulses then stay static. */
  reducedMotion(): boolean
  /** Calls `listener` when the reduced-motion preference changes; returns its unsubscribe. */
  onReducedMotionChange?(listener: () => void): () => void
  /**
   * Moves `dot` through `points` (x/y pairs, evenly spaced in time) linearly, `iterations` times
   * (`Infinity` allowed), each taking `durationMs`, after `delayMs` (negative starts part way
   * through). Calls `onFinish` when it ends. Undefined when the environment cannot animate.
   */
  animate(
    dot: HTMLElement,
    points: readonly number[],
    timing: PulseTiming,
    onFinish: () => void,
  ): PulseAnimation | undefined
}

export const browserHost = (): PulseHost => ({
  visible: () => !globalThis.document?.hidden,
  reducedMotion: () => {
    try {
      return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
    } catch {
      return false
    }
  },
  onReducedMotionChange(listener) {
    try {
      const query = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")
      query?.addEventListener?.("change", listener)
      return () => query?.removeEventListener?.("change", listener)
    } catch {
      return () => {}
    }
  },
  animate(dot, points, timing, onFinish) {
    if (typeof dot.animate !== "function") return undefined
    const frames: Keyframe[] = []
    for (let i = 0; i + 1 < points.length; i += 2)
      frames.push({
        transform: `translate3d(${points[i]!.toFixed(1)}px,${points[i + 1]!.toFixed(1)}px,0)`,
        easing: "step-end",
      })
    const animation = dot.animate(frames, {
      duration: timing.durationMs,
      delay: timing.delayMs,
      iterations: timing.iterations,
      easing: "linear",
      fill: "none",
    })
    animation.onfinish = onFinish
    // Cancelling rejects `finished`; nobody awaits it, so it must not surface as unhandled.
    animation.finished.catch(() => {})
    return {
      cancel: () => animation.cancel(),
      pause: () => animation.pause(),
      play: () => animation.play(),
      elapsed: () => (typeof animation.currentTime === "number" ? animation.currentTime : null),
      setIterations: (iterations) => animation.effect?.updateTiming({ iterations }),
    }
  },
})

type Dot = HTMLElement & { __dim?: boolean }
type Pulse = {
  dot: Dot
  animation: PulseAnimation
  /** Delay the animation was created with; a negative one started it part way through. */
  delayMs: number
  /** Iterations it will run: `Infinity` while its wire runs, a whole number once it stopped. */
  iterations: number
  finished: boolean
}
type Wire = {
  id: string
  key: string
  path: WirePath
  running: boolean
  dim: boolean
  pulses: Pulse[]
}

/**
 * A pulse holds still between keyframes (step easing) and moves every `STEP_MS`: the compositor
 * then has no damage to draw on the frames in between, which is what halves its work at 30 fps.
 * At 90 px/s a step is 3 px.
 */
export const STEP_MS = 33
const MAX_KEYFRAMES = 400

/**
 * The one animation driver of the Flow view. Each pulse is one small HTML dot with one Web
 * Animation of `transform` along its wire, repeating for as long as the wire runs; staggered
 * start delays space a wire's pulses evenly. Transform animations run on the compositor, so a
 * pulse in flight costs no main-thread work, no style recalc, no layout, no paint, no timer and
 * no frame callback, and keeps moving while the main thread is busy. The main thread works only
 * when a wire starts, stops or changes shape. A re-render or live update reaches the loop through
 * `update`, which never restarts a pulse in flight: a wire that stops lets each pulse finish its
 * crossing, and a changed geometry re-creates a pulse at the same fraction of the new path.
 * A hidden view pauses every animation; reduced motion creates none.
 */
export function createPulseLoop(layer: Element, host: PulseHost = browserHost()) {
  const wires = new Map<string, Wire>()
  const free: Dot[] = []
  const all: Dot[] = []
  let live = 0
  let paused = false
  let disposed = false
  const stats = { started: 0 }

  const dotFor = () => {
    let dot = free.pop()
    if (!dot) {
      dot = layer.ownerDocument.createElement("div") as Dot
      dot.className = "lazers-radar-flow-dot"
      layer.append(dot)
      all.push(dot)
    }
    return dot
  }
  const release = (wire: Wire, pulse: Pulse) => {
    const index = wire.pulses.indexOf(pulse)
    if (index < 0) return
    wire.pulses.splice(index, 1)
    free.push(pulse.dot)
    live--
    if (wire.pulses.length === 0 && !wire.running) wires.delete(wire.id)
  }
  const begin = (
    wire: Wire,
    dot: Dot,
    timing: PulseTiming,
    iterations = timing.iterations,
  ): Pulse | undefined => {
    const count = Math.min(MAX_KEYFRAMES, 2 + Math.ceil(crossingMs(wire.path.length) / STEP_MS))
    const pulse: Pulse = {
      dot,
      delayMs: timing.delayMs,
      iterations,
      finished: false,
      animation: undefined as never,
    }
    const animation = host.animate(dot, wire.path.points(count), timing, () => {
      pulse.finished = true
      release(wire, pulse)
    })
    if (!animation) return undefined
    pulse.animation = animation
    if (paused) animation.pause()
    dot.__dim = undefined
    stats.started++
    return pulse
  }
  const paint = (wire: Wire) => {
    for (const pulse of wire.pulses)
      if (pulse.dot.__dim !== wire.dim) {
        pulse.dot.__dim = wire.dim
        pulse.dot.setAttribute("data-dim", String(wire.dim))
      }
  }
  /** Where a pulse is on its animation's clock: waiting (negative) or crossing at `iteration`. */
  const local = (pulse: Pulse) => {
    const elapsed = pulse.animation.elapsed()
    return elapsed === null ? null : elapsed - pulse.delayMs
  }
  const emit = (wire: Wire) => {
    const wanted = pulsesOn(wire.path.length)
    const period = crossingMs(wire.path.length)
    for (let k = wire.pulses.length; k < wanted && live < MAX_TOTAL; k++) {
      const pulse = begin(wire, dotFor(), {
        durationMs: period,
        delayMs: (k * period) / wanted,
        iterations: Number.POSITIVE_INFINITY,
      })
      if (!pulse) return
      wire.pulses.push(pulse)
      live++
    }
  }
  /** Lets each pulse finish its crossing; one that has not yet started never will. */
  const wind = (wire: Wire) => {
    const period = crossingMs(wire.path.length)
    for (const pulse of [...wire.pulses]) {
      const at = local(pulse)
      if (at === null || at < 0) {
        pulse.animation.cancel()
        release(wire, pulse)
      } else {
        pulse.iterations = Math.floor(at / period) + 1
        pulse.animation.setIterations(pulse.iterations)
      }
    }
  }
  /** Re-creates a wire's pulses on its new path, each at the fraction it had reached. */
  const reshape = (wire: Wire, path: WirePath) => {
    const before = crossingMs(wire.path.length)
    const after = crossingMs(path.length)
    const old = wire.pulses.splice(0)
    wire.path = path
    for (const pulse of old) {
      const at = local(pulse)
      pulse.animation.cancel()
      const waiting = at !== null && at < 0
      const crossed = at === null || waiting ? 0 : Math.floor(at / before)
      const phase = at === null || waiting ? 0 : (at / before - crossed) % 1
      const iterations = pulse.iterations - crossed
      const next = begin(
        wire,
        pulse.dot,
        {
          durationMs: after,
          delayMs: waiting ? -at! : -phase * after,
          iterations,
        },
        iterations,
      )
      if (next) wire.pulses.push(next)
      else {
        free.push(pulse.dot)
        live--
      }
    }
  }
  const onVisibility = () => {
    if (disposed) return
    const hidden = !host.visible()
    if (hidden === paused) return
    paused = hidden
    for (const wire of wires.values())
      for (const pulse of wire.pulses) {
        if (hidden) pulse.animation.pause()
        else pulse.animation.play()
      }
  }
  globalThis.document?.addEventListener?.("visibilitychange", onVisibility)
  let lastInputs: readonly WireInput[] = []
  // A preference change acts at once: reduced motion cancels every pulse, opting out restores them.
  const stopReducedWatch = host.onReducedMotionChange?.(() => {
    if (disposed) return
    if (host.reducedMotion()) {
      for (const wire of wires.values()) {
        for (const pulse of wire.pulses) {
          pulse.animation.cancel()
          free.push(pulse.dot)
          live--
        }
        wire.pulses = []
        wire.running = false
      }
      wires.clear()
    } else api.update(lastInputs)
  })

  const api = {
    /** Current layout's wires. Safe on every render: pulses in flight are never reset. */
    update(inputs: readonly WireInput[]) {
      if (disposed) return
      lastInputs = inputs
      if (host.visible() === paused) onVisibility()
      const reduced = host.reducedMotion()
      const present = new Set<string>()
      for (const input of inputs) {
        present.add(input.id)
        const running = input.running && !reduced
        let wire = wires.get(input.id)
        const key = geometryKey(input)
        if (!wire) {
          if (!running) continue
          wire = {
            id: input.id,
            key,
            path: new WirePath(input),
            running: false,
            dim: false,
            pulses: [],
          }
          wires.set(input.id, wire)
        } else if (wire.key !== key) {
          wire.key = key
          reshape(wire, new WirePath(input))
        }
        wire.dim = input.dim === true
        if (running && !wire.running) {
          wire.running = true
          // Pulses still finishing from a stop carry on instead of restarting.
          for (const pulse of wire.pulses) {
            pulse.iterations = Number.POSITIVE_INFINITY
            pulse.animation.setIterations(pulse.iterations)
          }
          emit(wire)
        } else if (!running && wire.running) {
          wire.running = false
          wind(wire)
        }
        if (wire.pulses.length === 0 && !wire.running) wires.delete(wire.id)
        else paint(wire)
      }
      for (const wire of [...wires.values()])
        if (!present.has(wire.id) && wire.running) {
          wire.running = false
          wind(wire)
          if (wire.pulses.length === 0) wires.delete(wire.id)
        }
    },
    /** Re-check visibility, e.g. from an IntersectionObserver. */
    wake() {
      onVisibility()
    },
    get stats() {
      return stats
    },
    /** Pulses with an animation alive now. */
    get moving() {
      return live
    },
    dispose() {
      disposed = true
      for (const wire of wires.values()) for (const pulse of wire.pulses) pulse.animation.cancel()
      wires.clear()
      globalThis.document?.removeEventListener?.("visibilitychange", onVisibility)
      stopReducedWatch?.()
      for (const dot of all) dot.remove()
    },
  }
  return api
}
