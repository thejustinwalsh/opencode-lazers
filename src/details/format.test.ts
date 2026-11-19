import { expect, test } from "bun:test"
import { callsText, compactCount, durationText } from "./format.ts"

test("durations read at their natural unit, with days and no zero tail", () => {
  expect(
    [25, 4_200, 18_400, 287_000, 2_880_000, 3_720_000, 10_800_000, 158_400_000, 172_800_000].map(
      durationText,
    ),
  ).toEqual(["25ms", "4.2s", "18s", "4m 47s", "48m", "1h 02m", "3h", "1d 20h", "2d"])
})

test("compact counts", () => {
  expect([950, 20_300, 16_000_000, 1_200_000_000].map(compactCount)).toEqual([
    "950",
    "20.3k",
    "16M",
    "1.2B",
  ])
})

test("calls text drops a zero or missing file count", () => {
  expect([callsText(17, 5), callsText(1, 1), callsText(3, 0), callsText(3)]).toEqual([
    "17 · 5 files",
    "1 · 1 file",
    "3",
    "3",
  ])
})
