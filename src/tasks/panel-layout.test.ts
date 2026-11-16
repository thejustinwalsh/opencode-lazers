import { expect, test } from "bun:test"
import {
  SPLIT_DEFAULT,
  clampSplit,
  contentSplit,
  splitFromPointer,
  splitWasAdjusted,
} from "./panel-layout.ts"

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

test("a sparse list fits its content and a full list keeps the default share", () => {
  // Two rows and one heading need 92px of a 600px pane: the list takes 16%, clamped to 20%.
  expect(contentSplit({ rows: 2, headings: 1, extra: 0, available: 600 })).toBe(20)
  // Six rows, one heading and padding need 236px of 600px.
  expect(contentSplit({ rows: 6, headings: 1, extra: 16, available: 600 })).toBe(40)
  expect(contentSplit({ rows: 40, headings: 3, extra: 16, available: 600 })).toBe(SPLIT_DEFAULT)
  expect(contentSplit({ rows: 4, headings: 0, extra: 0, available: 0 })).toBe(SPLIT_DEFAULT)
  expect(contentSplit({ rows: 4, headings: 0, extra: 0, available: Number.NaN })).toBe(
    SPLIT_DEFAULT,
  )
})

test("an explicit resize is never replaced by the content-aware default", () => {
  expect(splitWasAdjusted({ split: SPLIT_DEFAULT })).toBe(false)
  expect(splitWasAdjusted({ split: 61 })).toBe(true)
  expect(splitWasAdjusted({ split: SPLIT_DEFAULT, splitAdjusted: true })).toBe(true)
  expect(splitWasAdjusted({ split: 61, splitAdjusted: false })).toBe(false)
})
