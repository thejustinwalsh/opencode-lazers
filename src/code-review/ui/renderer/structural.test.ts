import { describe, expect, test } from "bun:test"
import type { StructuralDiff } from "../../structural/contract.ts"
import { lineCounts, pierreRegions, toLineDiff, toPierreDiff, tokenRuns } from "./structural.ts"

const tok = (start: number, end: number) => ({ start, end, highlight: "normal" as const })

const diff = (partial: Partial<StructuralDiff>): StructuralDiff => ({
  path: "a.ts",
  engineVersion: "0.71.0",
  status: "changed",
  language: "typescript",
  engine: "difftastic",
  alignedLines: [],
  hunks: [],
  ...partial,
})

describe("tokenRuns", () => {
  test("adjacent tokens merge into one run", () => {
    expect(tokenRuns([tok(0, 3), tok(3, 5)], "abcde")).toEqual([{ start: 0, end: 5 }])
  })

  test("tokens separated only by blanks merge", () => {
    expect(tokenRuns([tok(0, 3), tok(5, 8)], "abc \t def")).toEqual([{ start: 0, end: 8 }])
  })

  test("tokens separated by a non-blank gap stay two runs", () => {
    expect(tokenRuns([tok(0, 3), tok(4, 7)], "abc.def")).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ])
  })

  test("unsorted and overlapping tokens merge", () => {
    expect(tokenRuns([tok(4, 8), tok(0, 6)], "abcdefghij")).toEqual([{ start: 0, end: 8 }])
  })
})

const baseText = "one\ntwo\nthree\n"
const headText = "one\nTWO\nthree\n"

describe("toPierreDiff", () => {
  test("modified file carries 0-based intra-line ranges", () => {
    const built = toPierreDiff(
      diff({
        alignedLines: [
          [1, 1],
          [2, 2],
          [3, 3],
        ],
        hunks: [
          [{ base: { line: 2, tokens: [tok(0, 3)] }, head: { line: 2, tokens: [tok(0, 3)] } }],
        ],
      }),
      { base: baseText, head: headText },
    )
    expect(built.type).toBe("change")
    expect(built.intraLineRanges).toBeDefined()
    expect(built.intraLineRanges?.additions?.[1]).toEqual([{ start: 0, end: 3 }])
    expect(built.intraLineRanges?.deletions?.[1]).toEqual([{ start: 0, end: 3 }])
    expect(built.intraLineRanges?.additions?.[2]).toBeUndefined()
  })

  test("created file is type new with no intra-line ranges", () => {
    const text = "a\nb\n"
    const built = toPierreDiff(
      diff({
        status: "created",
        alignedLines: [
          [null, 1],
          [null, 2],
        ],
        hunks: [[{ head: { line: 1, tokens: [tok(0, 1)] } }]],
      }),
      { base: null, head: text },
    )
    expect(built.type).toBe("new")
    const ranges = built.intraLineRanges
    expect(Object.keys(ranges?.additions ?? {})).toHaveLength(0)
    expect(Object.keys(ranges?.deletions ?? {})).toHaveLength(0)
    expect(lineCounts(built)).toEqual({ added: 2, removed: 0 })
  })

  test("deleted file is type deleted", () => {
    const built = toPierreDiff(
      diff({
        status: "deleted",
        alignedLines: [
          [1, null],
          [2, null],
        ],
        hunks: [[{ base: { line: 1, tokens: [tok(0, 1)] } }]],
      }),
      { base: "a\nb\n", head: null },
    )
    expect(built.type).toBe("deleted")
    expect(Object.keys(built.intraLineRanges?.deletions ?? {})).toHaveLength(0)
    expect(lineCounts(built)).toEqual({ added: 0, removed: 2 })
  })
})

describe("toLineDiff", () => {
  test("null base is new", () => {
    expect(toLineDiff("a.ts", undefined, { base: null, head: "x\n" }).type).toBe("new")
  })
  test("null head is deleted", () => {
    expect(toLineDiff("a.ts", undefined, { base: "x\n", head: null }).type).toBe("deleted")
  })
  test("both present is change", () => {
    const built = toLineDiff("a.ts", undefined, { base: baseText, head: headText })
    expect(built.type).toBe("change")
    expect(lineCounts(built)).toEqual({ added: 1, removed: 1 })
  })
})

describe("regions and counts", () => {
  const lines = (n: number, edit: Set<number>, prefix: string) =>
    Array.from({ length: n }, (_, i) => (edit.has(i + 1) ? `${prefix}${i + 1}` : `l${i + 1}`)).join(
      "\n",
    ) + "\n"
  const base = lines(30, new Set([5, 25]), "old")
  const head = lines(30, new Set([5, 25]), "new")
  const built = toLineDiff("a.ts", undefined, { base, head })

  test("two separate hunks give two regions on the additions side", () => {
    expect(pierreRegions(built)).toEqual([
      { side: "additions", line: 5, endLine: 5 },
      { side: "additions", line: 25, endLine: 25 },
    ])
  })

  test("counts sum change blocks", () => {
    expect(lineCounts(built)).toEqual({ added: 2, removed: 2 })
  })

  test("a pure deletion yields a deletions region", () => {
    const regions = pierreRegions(
      toLineDiff("a.ts", undefined, { base: "a\nb\nc\n", head: "a\nc\n" }),
    )
    expect(regions).toEqual([{ side: "deletions", line: 2, endLine: 2 }])
  })
})
