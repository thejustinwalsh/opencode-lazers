import { expect, test } from "bun:test"
import { clampSplit, splitFromPointer } from "./panel-layout.ts"

test("split geometry subtracts the live wrapped header and separator", () => {
  for (const header of [44, 96, 128]) {
    const height = 640
    const separator = 6
    const available = height - header - separator
    const pointer = 120 + header + available * 0.48
    expect(splitFromPointer(48, 120, height, header, separator, pointer)).toBeCloseTo(48)
  }
})

test("multiple pointer moves and short panes stay within the usable split range", () => {
  const moves = [120, 220, 400, 275, 90]
  const values = moves.map((pointer) => splitFromPointer(48, 20, 420, 76, 6, pointer))
  expect(values[0]).toBe(20)
  expect(values.at(-1)).toBe(20)
  expect(values[2]).toBeGreaterThan(values[1]!)
  expect(values[3]).toBeLessThan(values[2]!)
  expect(clampSplit(48)).toBe(48)
  expect(splitFromPointer(48, 0, 80, 90, 6, 50)).toBe(48)
})
