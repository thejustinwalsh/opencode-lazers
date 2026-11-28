import { expect, test } from "bun:test"
import { CodeReviewDiscussions, CodeReviewRangeSchema } from "./contract.ts"

test("discussion contract publishes the shared operations and UTF-16 ranges", () => {
  expect(CodeReviewDiscussions.id).toBe("lazers.codeReviewDiscussions")
  expect(Object.keys(CodeReviewDiscussions.methods)).toEqual([
    "createThread",
    "getThread",
    "appendComment",
    "setThreadState",
    "prepareDraft",
    "locateThread",
    "linkCorrection",
  ])
  expect(
    CodeReviewRangeSchema.parse({
      startLine: 3,
      endLine: 3,
      startCol: 4,
      endCol: 5,
    }),
  ).toEqual({ startLine: 3, endLine: 3, startCol: 4, endCol: 5 })
  expect(
    CodeReviewRangeSchema.safeParse({
      startLine: 3,
      endLine: 3,
      startCol: 5,
      endCol: 5,
    }).success,
  ).toBe(false)
})
