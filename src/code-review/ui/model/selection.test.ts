import { describe, expect, test } from "bun:test"
import type { CodeViewLineSelection } from "@pierre/diffs"
import { fromLineSelection } from "./selection.ts"

const sel = (range: Record<string, unknown>) =>
  ({ id: "src/a.ts", range }) as unknown as CodeViewLineSelection

describe("fromLineSelection", () => {
  test("null is undefined", () => {
    expect(fromLineSelection(null)).toBeUndefined()
  })
  test("deletions map to base, additions to head", () => {
    expect(fromLineSelection(sel({ start: 2, end: 4, side: "deletions" }))).toEqual({
      path: "src/a.ts",
      side: "base",
      startLine: 2,
      endLine: 4,
    })
    expect(fromLineSelection(sel({ start: 2, end: 4, side: "additions" }))?.side).toBe("head")
  })
  test("reversed ranges are sorted", () => {
    const out = fromLineSelection(
      sel({ start: 9, end: 3, side: "additions", endSide: "additions" }),
    )
    expect([out?.startLine, out?.endLine]).toEqual([3, 9])
  })
  test("cross-side range is rejected", () => {
    expect(
      fromLineSelection(sel({ start: 1, end: 2, side: "additions", endSide: "deletions" })),
    ).toBeUndefined()
  })
  test("uses endSide when side is absent", () => {
    expect(fromLineSelection(sel({ start: 1, end: 1, endSide: "deletions" }))?.side).toBe("base")
  })
})
