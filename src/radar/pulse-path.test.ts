import { expect, test } from "bun:test"
import {
  MAX_PER_WIRE,
  PULSE_SPEED,
  WirePath,
  crossingMs,
  pulsesOn,
  spacingPx,
} from "./pulse-path.ts"

const straight = (length: number) =>
  new WirePath({ x0: 0, y0: 0, x1: length, y1: 0, mx: length / 2 })

test("a straight wire is its own length and carries two to four pulses, spaced 56 to 120 px", () => {
  for (const length of [150, 300, 420]) {
    expect(straight(length).length).toBeCloseTo(length, 0)
    expect(pulsesOn(length)).toBeGreaterThanOrEqual(2)
    expect(pulsesOn(length)).toBeLessThanOrEqual(4)
    expect(spacingPx(length)).toBeGreaterThanOrEqual(56)
    expect(spacingPx(length)).toBeLessThanOrEqual(120)
  }
  // A very short wire still carries one; a very long one is capped.
  expect(pulsesOn(30)).toBe(1)
  expect(pulsesOn(5_000)).toBe(MAX_PER_WIRE)
})

test("every wire is crossed at one speed: duration is length over PULSE_SPEED", () => {
  expect(crossingMs(300)).toBeCloseTo((300 / PULSE_SPEED) * 1000, 6)
  expect(crossingMs(600) / crossingMs(300)).toBeCloseTo(2, 6)
})

test("points run from source to destination, evenly spaced in arc length", () => {
  const path = new WirePath({ x0: 10, y0: 20, x1: 310, y1: 220, mx: 160 })
  const points = path.points(9)
  expect(points).toHaveLength(18)
  expect([points[0], points[1]]).toEqual([10, 20])
  expect(points[16]).toBeCloseTo(310, 6)
  expect(points[17]).toBeCloseTo(220, 6)
  const step = (k: number) =>
    Math.hypot(points[2 * k + 2]! - points[2 * k]!, points[2 * k + 3]! - points[2 * k + 1]!)
  const mean = path.length / 8
  for (let k = 0; k < 8; k++) expect(Math.abs(step(k) - mean)).toBeLessThan(mean * 0.25)
})
