import { expect, test } from "bun:test"
import {
  LABEL_CHAR_PX,
  endPadding,
  labelRightEdge,
  laneCountText,
  markRightEdge,
} from "../../src/trajectory-panel/panel-layout.ts"

test("at fit zoom the last ruler label and the last mark end inside the panel", () => {
  const labels = ["0", "5m", "10m", "15m", "20m", "25m"]
  const pad = endPadding(labels)
  // Half the widest label plus 8 px.
  expect(pad).toBe(Math.ceil((3 * LABEL_CHAR_PX) / 2) + 8)
  for (const trackPx of [240, 464, 600]) {
    // The panel's inner width at fit zoom is the track plus the reserved end padding.
    const inner = trackPx + pad
    // The axis ends at the last event, so the last mark and the last tick sit at 100 %.
    for (const label of labels)
      expect(labelRightEdge(100, label, trackPx)).toBeLessThanOrEqual(inner - 8)
    expect(markRightEdge(100, trackPx)).toBeLessThanOrEqual(inner - 8)
    // A span ending at the axis end is the same.
    expect(markRightEdge(60, trackPx, 40)).toBeLessThanOrEqual(inner - 8)
  }
  // Without the padding the label would spill past the track.
  expect(labelRightEdge(100, "25m", 464)).toBeGreaterThan(464)
})

test("the padding follows the widest label", () => {
  expect(endPadding(["0", "5m"])).toBeLessThan(endPadding(["0", "1h30m"]))
  expect(endPadding([])).toBe(8)
})

test("a lane drawn from a partial window says its count is what is loaded", () => {
  expect(laneCountText(66, false)).toBe("66")
  expect(laneCountText(66, true, 330)).toBe("66 of 330")
  expect(laneCountText(4, true)).toBe("4 loaded")
  // A recorded total below the loaded count is not a total to show.
  expect(laneCountText(66, true, 10)).toBe("66 loaded")
})
