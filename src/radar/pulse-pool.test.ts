import { expect, test } from "bun:test"
import {
  MAX_PER_WIRE,
  MAX_TOTAL,
  PULSE_SPEED,
  PulsePool,
  emitIntervalMs,
  spacingPx,
} from "./pulse-pool.ts"
import type { WireInput } from "./pulse-pool.ts"

const wire = (id: string, change: Partial<WireInput> = {}): WireInput => ({
  id,
  x0: 0,
  y0: 0,
  x1: 300,
  y1: 0,
  mx: 150,
  running: true,
  ...change,
})

/** Steps the pool on a fixed frame time and returns every progress sample it saw. */
function run(pool: PulsePool, from: number, to: number, frame: number, id = "a") {
  const seen: number[][] = []
  for (let now = from; now <= to; now += frame) {
    pool.step(now)
    seen.push(pool.fractions(id))
  }
  return seen
}

test("a straight wire is its own length and the cadence keeps two to four pulses on it", () => {
  for (const length of [80, 150, 300, 420]) {
    const pool = new PulsePool()
    pool.sync([wire("a", { x1: length })], 0)
    pool.step(0)
    let max = 0
    let min = Infinity
    // After the first pulse has crossed, count pulses on the wire at every frame.
    for (let now = 0; now < 30_000; now += 16) {
      pool.step(now)
      if (now > (length / PULSE_SPEED) * 1000 + 1_000) {
        max = Math.max(max, pool.size)
        min = Math.min(min, pool.size)
      }
    }
    expect(max).toBeLessThanOrEqual(5)
    expect(min).toBeGreaterThanOrEqual(1)
    expect(spacingPx(length)).toBeGreaterThanOrEqual(56)
    expect(spacingPx(length)).toBeLessThanOrEqual(120)
  }
  // Same speed on every wire: the interval is spacing over one constant speed.
  expect(emitIntervalMs(300)).toBeCloseTo((spacingPx(300) / PULSE_SPEED) * 1000, 6)
})

test("every pulse travels the whole wire and is removed only on arrival", () => {
  const pool = new PulsePool()
  pool.sync([wire("a")], 0)
  const seen = run(pool, 0, 8_000, 16)
  // Track one pulse by following the fraction that starts nearest zero: fractions only grow
  // until they leave, and a pulse that leaves was past 0.99 the frame before.
  let previous: number[] = []
  for (const frame of seen) {
    const sorted = [...frame].sort((a, b) => b - a)
    const before = [...previous].sort((a, b) => b - a)
    // The oldest pulse either advanced or, if it vanished, had nearly arrived.
    if (before.length && (sorted.length < before.length || sorted[0]! < before[0]!))
      expect(before[0]!).toBeGreaterThan(1 - (PULSE_SPEED * 0.016 * 2) / 300)
    previous = frame
  }
  // Steady speed: after one second a pulse has moved PULSE_SPEED px of 300.
  const single = new PulsePool()
  single.sync([wire("a")], 0)
  let now = 0
  while (single.fractions("a").length === 0) single.step((now += 10))
  const start = single.fractions("a")[0]!
  single.step(now + 1_000)
  expect(single.fractions("a")[0]! - start).toBeCloseTo(PULSE_SPEED / 300, 3)
})

test("emission is a pure function of time: irregular frames give the same pulses", () => {
  const frames = (times: number[]) => {
    const pool = new PulsePool()
    pool.sync([wire("a")], 0)
    for (const time of times) pool.step(time)
    return pool.fractions("a").sort()
  }
  const regular = Array.from({ length: 501 }, (_, i) => i * 20)
  const irregular = [0, 3, 700, 701, 1_900, 2_000, 2_650, 4_001, 4_002, 7_777, 9_999, 10_000]
  const a = frames([...regular])
  const b = frames(irregular.concat(10_000))
  expect(b.length).toBe(a.length)
  b.forEach((value, index) => expect(value).toBeCloseTo(a[index]!, 6))
})

test("a layout change keeps each pulse's fraction and a re-render never resets them", () => {
  const pool = new PulsePool()
  pool.sync([wire("a")], 0)
  for (let now = 0; now <= 2_500; now += 16) pool.step(now)
  const before = pool.fractions("a")
  expect(before.length).toBeGreaterThan(0)
  // Longer wire, moved endpoints: same fractions.
  pool.sync([wire("a", { x1: 480, y1: 90, mx: 240 })], 2_500)
  expect(pool.fractions("a")).toEqual(before)
  // The same input again (a re-render) is a no-op for pulses in flight.
  pool.sync([wire("a", { x1: 480, y1: 90, mx: 240 })], 2_500)
  expect(pool.fractions("a")).toEqual(before)
  // Positions follow the new path: the front pulse's x is its fraction of the new length.
  const xs: number[] = []
  pool.forEach((_id, x, _y, fraction) => xs.push(x / fraction))
  for (const ratio of xs) expect(ratio).toBeGreaterThan(300)
})

test("a wire that stops running or leaves the layout finishes its pulses, then goes away", () => {
  const pool = new PulsePool()
  pool.sync([wire("a")], 0)
  for (let now = 0; now <= 2_000; now += 16) pool.step(now)
  const inFlight = pool.size
  expect(inFlight).toBeGreaterThan(0)
  pool.sync([wire("a", { running: false })], 2_000)
  expect(pool.fractions("a")).toHaveLength(inFlight)
  // Nothing new is emitted, yet every pulse reaches the end rather than vanishing.
  let maxSeen = inFlight
  for (let now = 2_016; now <= 8_000; now += 16) {
    pool.step(now)
    maxSeen = Math.max(maxSeen, pool.size)
  }
  expect(maxSeen).toBe(inFlight)
  expect(pool.size).toBe(0)
  expect(pool.active).toBe(false)
  // A wire missing from the next layout is treated the same way.
  const gone = new PulsePool()
  gone.sync([wire("b")], 0)
  for (let now = 0; now <= 1_500; now += 16) gone.step(now)
  gone.sync([], 1_500)
  const count = gone.size
  expect(count).toBeGreaterThan(0)
  gone.step(1_516)
  expect(gone.size).toBe(count)
})

test("pulses are capped per wire and in total", () => {
  const pool = new PulsePool()
  pool.sync([wire("a", { x1: 3_000 })], 0)
  for (let now = 0; now <= 60_000; now += 16) {
    pool.step(now)
    expect(pool.fractions("a").length).toBeLessThanOrEqual(MAX_PER_WIRE)
  }
  const many = new PulsePool()
  many.sync(
    Array.from({ length: 40 }, (_, index) => wire(`w${index}`, { x1: 2_000 })),
    0,
  )
  for (let now = 0; now <= 120_000; now += 50) {
    many.step(now)
    expect(many.size).toBeLessThanOrEqual(MAX_TOTAL)
  }
})

test("resume restarts the clock so a hidden stretch does not teleport pulses", () => {
  const pool = new PulsePool()
  pool.sync([wire("a")], 0)
  for (let now = 0; now <= 2_000; now += 16) pool.step(now)
  const before = pool.fractions("a")
  pool.resume(60_000)
  pool.step(60_016)
  const after = pool.fractions("a").sort((a, b) => b - a)
  const oldest = [...before].sort((a, b) => b - a)
  // The pulses that were in flight moved by one frame, not by the minute spent hidden.
  for (let i = 0; i < oldest.length; i++) expect(after[i]! - oldest[i]!).toBeLessThan(0.02)
})
