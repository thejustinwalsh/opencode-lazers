import { expect, test } from "bun:test"
import {
  DETAILS_DEFAULT_SIZE,
  bodyHeight,
  clampSize,
  dragState,
  keyboardState,
  maxBodyHeight,
  sizeFromLegacySplit,
  storedState,
} from "./details-pane.ts"

test("size clamps to a 72 px body that leaves 120 px above", () => {
  expect(clampSize(0.01, 600)).toBeCloseTo(72 / 600)
  expect(clampSize(0.99, 600)).toBeCloseTo(480 / 600)
  expect(clampSize(0.45, 600)).toBe(0.45)
  expect(maxBodyHeight(150)).toBe(72)
  expect(clampSize(Number.NaN, 600)).toBe(DETAILS_DEFAULT_SIZE)
  expect(bodyHeight(0.45, 600)).toBe(270)
})

test("dragging up opens, dragging below 72 px collapses and keeps the size", () => {
  const closed = { open: false, size: 0.3 }
  const up = dragState(closed, { pointerY: 300, containerTop: 0, containerHeight: 600 })
  expect(up.open).toBe(true)
  expect(up.size).toBeCloseTo((600 - 300 - 32) / 600)
  const down = dragState(up, { pointerY: 600 - 32 - 71, containerTop: 0, containerHeight: 600 })
  expect(down).toEqual({ open: false, size: up.size })
  const edge = dragState(up, { pointerY: 600 - 32 - 72, containerTop: 0, containerHeight: 600 })
  expect(edge.open).toBe(true)
})

test("keyboard steps by 5 %, Enter toggles, Down at the minimum collapses", () => {
  const open = { open: true, size: 0.45 }
  expect(keyboardState(open, "ArrowUp", 600)?.size).toBeCloseTo(0.5)
  expect(keyboardState(open, "ArrowDown", 600)?.size).toBeCloseTo(0.4)
  expect(keyboardState(open, "Enter", 600)).toEqual({ open: false, size: 0.45 })
  expect(keyboardState({ open: false, size: 0.45 }, "ArrowUp", 600)).toEqual(open)
  expect(keyboardState({ open: false, size: 0.45 }, "ArrowDown", 600)?.open).toBe(false)
  expect(keyboardState({ open: true, size: 0.13 }, "ArrowDown", 600)?.open).toBe(false)
  expect(keyboardState(open, "a", 600)).toBeUndefined()
})

test("stored state defaults closed at 0.45 and migrates a legacy split", () => {
  expect(storedState({})).toEqual({ open: false, size: 0.45 })
  expect(storedState({ open: true, size: 0.6 })).toEqual({ open: true, size: 0.6 })
  expect(storedState({ size: 5 }).size).toBe(0.45)
  expect(sizeFromLegacySplit(60)).toBeCloseTo(0.4)
  expect(sizeFromLegacySplit(undefined)).toBeUndefined()
})
