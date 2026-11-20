import { expect, test } from "bun:test"
import {
  COMFORT_PX,
  MAX_PLOT_PX,
  clampScroll,
  maxZoom,
  panBy,
  shortestFeature,
  stepZoom,
  wheelZoomFactor,
  zoomAbout,
} from "../../src/trajectory-panel/viewport.ts"

const fit = 800

test("zoom about a point keeps the time under the pointer fixed", () => {
  for (const anchor of [0, 100, 400, 800]) {
    const view = { zoom: 2, scrollLeft: 300 }
    const before = (view.scrollLeft + anchor) / (fit * view.zoom)
    const next = zoomAbout(view, 6, anchor, fit, 64)
    expect(next.zoom).toBe(6)
    expect((next.scrollLeft + anchor) / (fit * next.zoom)).toBeCloseTo(before, 10)
  }
})

test("zooming out to fit scrolls back to the start", () => {
  expect(zoomAbout({ zoom: 4, scrollLeft: 900 }, 1, 400, fit, 64)).toEqual({
    zoom: 1,
    scrollLeft: 0,
  })
})

test("zoom is clamped between fit and the data-derived maximum", () => {
  expect(zoomAbout({ zoom: 1, scrollLeft: 0 }, 0.2, 0, fit, 8).zoom).toBe(1)
  expect(zoomAbout({ zoom: 1, scrollLeft: 0 }, 500, 0, fit, 8).zoom).toBe(8)
  expect(stepZoom(1, -1, 8)).toBe(1)
  expect(stepZoom(5, 1, 8)).toBe(8)
  expect(stepZoom(2, 1, 8)).toBe(4)
  expect(stepZoom(4, -1, 8)).toBe(2)
})

test("scroll never leaves the track", () => {
  expect(clampScroll(-10, 4, fit)).toBe(0)
  expect(clampScroll(99_999, 4, fit)).toBe(fit * 3)
  expect(clampScroll(50, 1, fit)).toBe(0)
  expect(panBy({ zoom: 2, scrollLeft: 700 }, 500, fit).scrollLeft).toBe(fit)
})

test("the maximum zoom makes the shortest feature comfortably wide", () => {
  // A 0.5% feature on an 800 px track is 4 px at fit.
  const zoom = maxZoom(0.5, fit)
  expect(zoom).toBeCloseTo(COMFORT_PX / 4, 10)
  expect(maxZoom(null, fit)).toBe(1)
  expect(maxZoom(50, fit)).toBe(1)
  expect(maxZoom(0.5, 0)).toBe(1)
  // A vanishing feature is bounded by the layout limit, not left unbounded.
  expect(maxZoom(1e-9, fit) * fit).toBeLessThanOrEqual(MAX_PLOT_PX)
})

test("shortest feature uses span widths and distinct neighbouring positions", () => {
  expect(shortestFeature([0, 2, 0.5], [10, 10, 12, 20])).toBe(0.5)
  expect(shortestFeature([], [5, 5.25, 9])).toBe(0.25)
  expect(shortestFeature([0], [3, 3])).toBeNull()
})

test("wheel zoom factor is symmetric, bounded and line-mode aware", () => {
  expect(wheelZoomFactor(-3) * wheelZoomFactor(3)).toBeCloseTo(1, 10)
  expect(wheelZoomFactor(-3)).toBeGreaterThan(1)
  expect(wheelZoomFactor(-10_000)).toBe(wheelZoomFactor(-40))
  expect(wheelZoomFactor(-1, 1)).toBeCloseTo(wheelZoomFactor(-16), 10)
})
