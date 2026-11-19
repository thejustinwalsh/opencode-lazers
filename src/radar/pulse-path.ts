/**
 * The Flow view's pulse model as pure functions. A running wire carries a few pulses that each
 * travel the whole wire from source to destination at one speed (px/s, the same on every wire),
 * spaced evenly; the wire's own length sets how many. Nothing here touches the DOM or a clock.
 */

/** Travel speed, px per second, on every wire. */
export const PULSE_SPEED = 90
/** Most pulses on one wire, and in the whole view. */
export const MAX_PER_WIRE = 5
export const MAX_TOTAL = 60
const MIN_SPACING = 56
const MAX_SPACING = 120
/** Samples along a wire's curve for arc-length lookup. */
const SAMPLES = 32

/** A wire as the layout describes it: a cubic from (x0, y0) to (x1, y1) with its control column mx. */
export type WireGeometry = { x0: number; y0: number; x1: number; y1: number; mx: number }
export type WireInput = WireGeometry & { id: string; running: boolean; dim?: boolean }

export const geometryKey = (g: WireGeometry) => `${g.x0}|${g.y0}|${g.x1}|${g.y1}|${g.mx}`

const cubic = (t: number, a: number, b: number, c: number, d: number) => {
  const u = 1 - t
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d
}

/** Spacing between pulses on a wire: 56 to 120 px, a third of the wire between. */
export const spacingPx = (length: number) =>
  Math.min(MAX_SPACING, Math.max(MIN_SPACING, length / 3))

/** Pulses on a wire this long at once: two to four on a normal wire, one on a very short one. */
export const pulsesOn = (length: number) =>
  Math.max(1, Math.min(MAX_PER_WIRE, Math.floor(length / spacingPx(length))))

/** Milliseconds one pulse takes to cross a wire this long. */
export const crossingMs = (length: number) => (length * 1000) / PULSE_SPEED

/** A wire sampled once: its length and a way to read points evenly spaced in arc length. */
export class WirePath {
  readonly length: number
  private readonly arc = new Float64Array(SAMPLES)
  private readonly xs = new Float64Array(SAMPLES)
  private readonly ys = new Float64Array(SAMPLES)

  constructor(g: WireGeometry) {
    let length = 0
    for (let i = 0; i < SAMPLES; i++) {
      const t = i / (SAMPLES - 1)
      this.xs[i] = cubic(t, g.x0, g.mx, g.mx, g.x1)
      this.ys[i] = cubic(t, g.y0, g.y0, g.y1, g.y1)
      if (i > 0) length += Math.hypot(this.xs[i]! - this.xs[i - 1]!, this.ys[i]! - this.ys[i - 1]!)
      this.arc[i] = length
    }
    this.length = Math.max(1, length)
  }

  /** The point at `fraction` (0 to 1) of the wire's length. */
  at(fraction: number): [number, number] {
    const target = Math.min(1, Math.max(0, fraction)) * this.length
    let index = 1
    while (index < SAMPLES - 1 && this.arc[index]! < target) index++
    const span = this.arc[index]! - this.arc[index - 1]!
    const along = span > 0 ? (target - this.arc[index - 1]!) / span : 0
    return [
      this.xs[index - 1]! + (this.xs[index]! - this.xs[index - 1]!) * along,
      this.ys[index - 1]! + (this.ys[index]! - this.ys[index - 1]!) * along,
    ]
  }

  /** `count` x/y pairs from source to destination, evenly spaced in arc length. */
  points(count: number): number[] {
    const out: number[] = []
    for (let k = 0; k < count; k++) out.push(...this.at(k / (count - 1)))
    return out
  }
}
