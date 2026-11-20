import { expect, test } from "bun:test"
import { DEMOS } from "../../src/demos"
import { fitScale, frameStyle, plateHeight, scaledBox } from "../../src/lib/demo-fit"

const widths = [120, 250, 300, 354, 367, 420, 460, 515, 650, 960]

test("the scaled iframe's box equals the plate's content box within 1px", () => {
  for (const def of Object.values(DEMOS))
    for (const width of widths) {
      const box = scaledBox(width, def.size)
      expect(Math.abs(box.width - width)).toBeLessThan(1)
      expect(Math.abs(box.height - plateHeight(width, def.size))).toBeLessThan(1)
    }
})

test("a zero-width plate does not scale", () => {
  expect(fitScale(0, { width: 420, height: 560 })).toBe(0)
})

test("the iframe style gives every length a unit (Preact leaves numbers unitless)", () => {
  for (const def of Object.values(DEMOS)) {
    const style = frameStyle(def.size, 0.8)
    expect(style.width).toBe(`${def.size.width}px`)
    expect(style.height).toBe(`${def.size.height}px`)
    expect(style.transform).toBe("scale(0.8)")
    expect(style.pointerEvents).toBe("none")
  }
})
