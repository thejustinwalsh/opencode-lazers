/**
 * The Flow view's pulses as pure, time-based state. A running wire emits a pulse on a steady
 * cadence; every pulse then travels the whole wire at one speed (px/s, the same on every wire)
 * and is removed only when it arrives. Nothing here touches the DOM or the clock: callers pass
 * `now` (ms), so the same inputs give the same pulses however frames are paced.
 */

/** Travel speed, px per second, on every wire. */
export const PULSE_SPEED = 90
/** Most pulses on one wire, and in the whole view. */
export const MAX_PER_WIRE = 5
export const MAX_TOTAL = 60
const MIN_SPACING = 56
const MAX_SPACING = 120
/** Samples along a wire's curve for arc-length lookup; geometry changes recompute them once. */
const SAMPLES = 32

/** A wire as the layout describes it: a cubic from (x0, y0) to (x1, y1) with its control column mx. */
export type WireGeometry = { x0: number; y0: number; x1: number; y1: number; mx: number }
export type WireInput = WireGeometry & { id: string; running: boolean; dim?: boolean }

type Wire = {
  id: string
  geometryKey: string
  length: number
  /** Cumulative arc length at each sample, and the sample points. */
  arc: Float64Array
  xs: Float64Array
  ys: Float64Array
  emitting: boolean
  dim: boolean
  /** Time (ms) the next pulse is emitted; meaningful while `emitting`. */
  nextEmit: number
  count: number
  /** Fraction travelled, 0 to 1, of each live pulse (the first `count` entries). */
  progress: Float64Array
}

const cubic = (t: number, a: number, b: number, c: number, d: number) => {
  const u = 1 - t
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d
}

function sample(wire: Wire, g: WireGeometry) {
  let length = 0
  for (let i = 0; i < SAMPLES; i++) {
    const t = i / (SAMPLES - 1)
    wire.xs[i] = cubic(t, g.x0, g.mx, g.mx, g.x1)
    wire.ys[i] = cubic(t, g.y0, g.y0, g.y1, g.y1)
    if (i > 0) length += Math.hypot(wire.xs[i]! - wire.xs[i - 1]!, wire.ys[i]! - wire.ys[i - 1]!)
    wire.arc[i] = length
  }
  wire.length = Math.max(1, length)
}

/** Seconds-equivalent spacing: 2 to 4 pulses on a wire at once, whatever its length. */
export const spacingPx = (length: number) =>
  Math.min(MAX_SPACING, Math.max(MIN_SPACING, length / 3))

/** Milliseconds between emissions on a wire of this length. */
export const emitIntervalMs = (length: number) => (spacingPx(length) / PULSE_SPEED) * 1000

/** A stable offset in [0, 1) from the wire id, so wires do not all fire on the same frame. */
function phase(id: string) {
  let hash = 2166136261
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619)
  return ((hash >>> 0) % 1000) / 1000
}

export class PulsePool {
  private readonly wires = new Map<string, Wire>()
  private last: number | undefined
  private total = 0

  /**
   * Updates the wires to the layout's current ones. A wire present in `inputs` that is running
   * emits; one that stopped, or left the layout, only finishes the pulses already in flight. A
   * geometry change re-samples the path; pulses keep their fraction of it.
   */
  sync(inputs: readonly WireInput[], now: number) {
    const present = new Set<string>()
    for (const input of inputs) {
      present.add(input.id)
      let wire = this.wires.get(input.id)
      if (!wire) {
        wire = {
          id: input.id,
          geometryKey: "",
          length: 1,
          arc: new Float64Array(SAMPLES),
          xs: new Float64Array(SAMPLES),
          ys: new Float64Array(SAMPLES),
          emitting: false,
          dim: false,
          nextEmit: now,
          count: 0,
          progress: new Float64Array(MAX_PER_WIRE),
        }
        this.wires.set(input.id, wire)
      }
      const key = `${input.x0}|${input.y0}|${input.x1}|${input.y1}|${input.mx}`
      if (key !== wire.geometryKey) {
        wire.geometryKey = key
        sample(wire, input)
      }
      wire.dim = input.dim === true
      if (input.running && !wire.emitting)
        wire.nextEmit = now + phase(input.id) * emitIntervalMs(wire.length)
      wire.emitting = input.running
    }
    for (const wire of this.wires.values()) if (!present.has(wire.id)) wire.emitting = false
  }

  /** Restarts the clock after the loop paused, so a long gap does not teleport pulses to the end. */
  resume(now: number) {
    this.last = now
    for (const wire of this.wires.values())
      if (wire.emitting) wire.nextEmit = Math.max(wire.nextEmit, now)
  }

  /**
   * Advances every pulse to `now` and emits the pulses due since the last step. A pulse emitted
   * between frames starts at its true age, so an irregular frame time never slows or bunches them.
   * Returns the pulses alive afterwards.
   */
  step(now: number): number {
    const last = this.last ?? now
    this.last = now
    const dt = Math.max(0, now - last)
    for (const wire of this.wires.values()) {
      // Move the pulses already in flight, then drop the ones that arrived.
      const advance = (PULSE_SPEED * dt) / 1000 / wire.length
      let kept = 0
      for (let i = 0; i < wire.count; i++) {
        const next = wire.progress[i]! + advance
        if (next < 1) wire.progress[kept++] = next
      }
      this.total -= wire.count - kept
      wire.count = kept
      if (wire.emitting) {
        const interval = emitIntervalMs(wire.length)
        while (wire.nextEmit <= now) {
          const age = ((now - wire.nextEmit) / 1000) * PULSE_SPEED
          const fraction = age / wire.length
          if (fraction < 1 && wire.count < MAX_PER_WIRE && this.total < MAX_TOTAL) {
            wire.progress[wire.count++] = fraction
            this.total++
          }
          wire.nextEmit += interval
        }
      }
    }
    // Wires that left the layout and finished their pulses go away.
    for (const [id, wire] of this.wires)
      if (wire.count === 0 && !wire.emitting) this.wires.delete(id)
    return this.total
  }

  /** Something is still moving or about to be emitted. */
  get active() {
    if (this.total > 0) return true
    for (const wire of this.wires.values()) if (wire.emitting) return true
    return false
  }

  /** Pulses alive now. */
  get size() {
    return this.total
  }

  /** Calls `visit(wireID, x, y, fraction, dim)` for every live pulse, with no allocation. */
  forEach(visit: (id: string, x: number, y: number, fraction: number, dim: boolean) => void) {
    for (const wire of this.wires.values())
      for (let i = 0; i < wire.count; i++) {
        const fraction = wire.progress[i]!
        const target = fraction * wire.length
        let index = 1
        while (index < SAMPLES - 1 && wire.arc[index]! < target) index++
        const span = wire.arc[index]! - wire.arc[index - 1]!
        const along = span > 0 ? (target - wire.arc[index - 1]!) / span : 0
        visit(
          wire.id,
          wire.xs[index - 1]! + (wire.xs[index]! - wire.xs[index - 1]!) * along,
          wire.ys[index - 1]! + (wire.ys[index]! - wire.ys[index - 1]!) * along,
          fraction,
          wire.dim,
        )
      }
  }

  /** Fractions of one wire's live pulses, for tests and tooling. */
  fractions(id: string): number[] {
    const wire = this.wires.get(id)
    return wire ? Array.from(wire.progress.subarray(0, wire.count)) : []
  }
}
