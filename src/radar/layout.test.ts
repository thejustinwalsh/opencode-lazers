import { expect, test } from "bun:test"
import { clampSplit, splitFromPointer } from "./layout.ts"

test("Radar split uses live wrapped-header geometry and explicit percentage bounds", () => {
  for (const headerHeight of [40, 84, 126]) {
    const rootTop = 24
    const rootHeight = 620
    const separator = 6
    const usable = rootHeight - headerHeight - separator
    const pointer = rootTop + headerHeight + usable * 0.55
    expect(splitFromPointer(55, rootTop, rootHeight, headerHeight, separator, pointer)).toBeCloseTo(
      55,
    )
  }
  expect(clampSplit(55)).toBe(55)
  expect(splitFromPointer(55, 0, 70, 90, 6, 40)).toBe(55)
})

test("multiple pointer moves, short panels, and boundary keys stay in range", () => {
  const moves = [100, 190, 330, 270, 25]
  const values = moves.map((pointer) => splitFromPointer(55, 12, 400, 88, 6, pointer))
  expect(values[0]).toBe(20)
  expect(values[2]).toBeGreaterThan(values[1]!)
  expect(values[3]).toBeLessThan(values[2]!)
  expect(values.at(-1)).toBe(20)
  expect(clampSplit(100)).toBe(80)
  expect(clampSplit(-1)).toBe(20)
})
