import { expect, test } from "bun:test"
import { encodeProjectID } from "../../tasks/links.ts"
import {
  CodeReviewDiscussions,
  CodeReviewRangeSchema,
  CodeReviewReferenceSchema,
} from "./contract.ts"

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

test("discussion references carry a pinned task route rather than an arbitrary URL", () => {
  const threadID = "2a603907-c884-40ae-b2e8-99be1958a646"
  const comparisonID = "a".repeat(64)
  const reference = {
    kind: "code-review" as const,
    threadID,
    comparisonID,
    source: {
      version: 1 as const,
      projectID: "project",
      taskID: "70cc1c08-0530-43ad-aad2-70b934243dbd",
      planID: "1c0b584b-bb1b-4eac-8044-ea4d54676179",
      attemptID: "724f0384-9018-49e4-8fbe-7e5e999a9db1",
      comparisonID,
      mode: "attempt" as const,
      side: "head" as const,
      path: "src/example.ts",
      revision: "b".repeat(40),
    },
    range: { startLine: 3, endLine: 3, startCol: 0, endCol: 4 },
    taskReference: "LZ-284",
    href: `.lazers/tasks/${encodeProjectID("project")}/LZ-284?review=${threadID}&comparison=${comparisonID}`,
    label: "src/example.ts:3",
  }
  expect(CodeReviewReferenceSchema.parse(reference)).toEqual(reference)
  expect(
    CodeReviewReferenceSchema.safeParse({
      ...reference,
      href: "https://example.invalid/review",
    }).success,
  ).toBe(false)
  expect(
    CodeReviewReferenceSchema.safeParse({
      ...reference,
      comparisonID: "c".repeat(64),
    }).success,
  ).toBe(false)
})
