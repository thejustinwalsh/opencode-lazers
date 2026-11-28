import { describe, expect, test } from "bun:test"
import { composerParts, ownsReviewLink, parseReviewLink, reviewHref } from "./anchor.ts"
import type { ReviewAnchor, ReviewRequest, ReviewTarget } from "./anchor.ts"
import { encodeProjectID } from "../../../tasks/links.ts"

const ID = (n: number) => `${n}`.repeat(8) + "-1111-4111-8111-" + `${n}`.repeat(12)
const CMP = "b".repeat(64)
const REF = "PX-12"
const PROJECT = "/Users/me/Projects/café"

const requests: ReviewRequest[] = [
  { mode: "task" },
  { mode: "live", attemptID: ID(1) },
  { mode: "plan", planID: ID(2) },
  { mode: "attempt", attemptID: ID(3) },
  { mode: "since", baseAttemptID: ID(4), headAttemptID: ID(5) },
]

describe("review link round trip", () => {
  for (const request of requests)
    test(request.mode, () => {
      const target: ReviewTarget = {
        projectID: PROJECT,
        reference: REF,
        request,
        comparisonID: CMP,
        path: "src/dir with space/ünï ✓.ts",
        side: "base",
        startLine: 3,
        endLine: 9,
      }
      const href = reviewHref(target)
      expect(ownsReviewLink(href)).toBe(true)
      expect(parseReviewLink(href)).toEqual(target)
    })

  test("minimal target round trips", () => {
    const target: ReviewTarget = { projectID: PROJECT, reference: REF, request: { mode: "task" } }
    expect(parseReviewLink(reviewHref(target))).toEqual(target)
  })

  test("single line gets equal start and end", () => {
    const parsed = parseReviewLink(
      reviewHref({ projectID: PROJECT, reference: REF, request: { mode: "task" }, startLine: 4 }),
    )
    expect([parsed?.startLine, parsed?.endLine]).toEqual([4, 4])
  })

  test("reviewHref rejects a bad reference", () => {
    expect(() =>
      reviewHref({ projectID: PROJECT, reference: "nope", request: { mode: "task" } }),
    ).toThrow()
  })
})

describe("parseReviewLink rejects", () => {
  const prefix = `.lazers/review/${encodeProjectID(PROJECT)}/${REF}`
  test("foreign href", () => {
    expect(parseReviewLink("https://x.dev")).toBeUndefined()
  })
  test("malformed project id", () => {
    expect(parseReviewLink(`.lazers/review/zz/${REF}?m=task`)).toBeUndefined()
    expect(parseReviewLink(`.lazers/review/abc/${REF}?m=task`)).toBeUndefined()
    expect(parseReviewLink(`.lazers/review/${REF}?m=task`)).toBeUndefined()
  })
  test("bad reference", () => {
    expect(parseReviewLink(`.lazers/review/${encodeProjectID(PROJECT)}/bad?m=task`)).toBeUndefined()
  })
  test("unknown or missing mode", () => {
    expect(parseReviewLink(`${prefix}?m=bogus`)).toBeUndefined()
    expect(parseReviewLink(prefix)).toBeUndefined()
  })
  test("non-uuid ids are dropped", () => {
    const parsed = parseReviewLink(`${prefix}?m=attempt&a=not-a-uuid&pl=${ID(2)}`)
    expect(parsed?.request).toEqual({ mode: "attempt", planID: ID(2) })
  })
  test("bad comparison id and side dropped", () => {
    const parsed = parseReviewLink(`${prefix}?m=task&c=short&s=middle`)
    expect(parsed?.comparisonID).toBeUndefined()
    expect(parsed?.side).toBeUndefined()
  })
  test("bad line ranges dropped", () => {
    for (const l of ["5-3", "0-4", "a-b", "7", "1-"]) {
      const parsed = parseReviewLink(`${prefix}?m=task&l=${l}`)
      expect(parsed).toBeDefined()
      expect(parsed?.startLine).toBeUndefined()
      expect(parsed?.endLine).toBeUndefined()
    }
  })
})

describe("composerParts", () => {
  const anchor: ReviewAnchor = {
    source: {
      version: 1,
      projectID: PROJECT,
      taskID: ID(1),
      planID: null,
      attemptID: null,
      comparisonID: CMP,
      mode: "task",
      side: "base",
      path: "src/a.ts",
      revision: "c".repeat(40),
    },
    baseRevision: "d".repeat(40),
    headRevision: "e".repeat(40),
    snapshotID: null,
    startLine: 4,
    endLine: 6,
    excerpt: "const a = 1\n  return a\n}",
    createdAt: 0,
  }
  const input = {
    anchor,
    intent: "ask" as const,
    reference: REF,
    title: "Some title",
    origin: "lazers-review",
    href: ".lazers/review/x/PX-12?m=task",
    id: "note-1",
  }

  test("quote text equals excerpt exactly", () => {
    expect(composerParts(input).quote.text).toBe(anchor.excerpt)
  })

  test("note subject pins comparison, side, path, revision and span", () => {
    const { note } = composerParts(input)
    expect(note.subject).toContain(CMP)
    expect(note.subject).toContain("base side of src/a.ts")
    expect(note.subject).toContain("c".repeat(40))
    expect(note.subject).toContain("lines 4–6")
    expect(note.subject).toContain(REF)
    expect(note.href).toBe(input.href)
  })

  test("ids derive from given id", () => {
    const { quote, note } = composerParts(input)
    expect(quote.commentID).toBe("note-1:quote")
    expect(note.commentID).toBe("note-1:note")
  })

  test("single line span", () => {
    const parts = composerParts({ ...input, anchor: { ...anchor, endLine: 4 } })
    expect(parts.note.subject).toContain("line 4")
    expect(parts.note.subject).not.toContain("lines 4")
  })

  test("fix and ask differ", () => {
    const ask = composerParts(input).note
    const fix = composerParts({ ...input, intent: "fix" }).note
    expect(ask.subtitle).not.toBe(fix.subtitle)
    expect(ask.icon).not.toBe(fix.icon)
    expect(ask.subject).not.toBe(fix.subject)
  })
})
