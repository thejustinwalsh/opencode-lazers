import { expect, test } from "bun:test"
import { encodeProjectID } from "../../tasks/links.ts"
import {
  CodeReviewAnchorLocationSchema,
  CodeReviewAnchorSchema,
  CodeReviewCommentSchema,
  CodeReviewDiscussions,
  CodeReviewDraftSchema,
  CodeReviewRangeSchema,
  CodeReviewReferenceSchema,
  CodeReviewSymbolIdentitySchema,
  CodeReviewThreadSchema,
} from "./contract.ts"
import type {
  CodeReviewAnchor,
  CodeReviewAnchorLocation,
  CodeReviewComment,
  CodeReviewDraft,
  CodeReviewRange,
  CodeReviewReference,
  CodeReviewSymbolIdentity,
  CodeReviewThread,
} from "./contract.ts"
import type { CodeReviewSourceIdentity } from "../contract.ts"

const threadID = "2a603907-c884-40ae-b2e8-99be1958a646"
const comparisonID = "a".repeat(64)
const source: CodeReviewSourceIdentity = {
  version: 1,
  projectID: "project",
  taskID: "70cc1c08-0530-43ad-aad2-70b934243dbd",
  planID: "1c0b584b-bb1b-4eac-8044-ea4d54676179",
  attemptID: "724f0384-9018-49e4-8fbe-7e5e999a9db1",
  comparisonID,
  mode: "attempt",
  side: "head",
  path: "src/example.ts",
  revision: "b".repeat(40),
}
const range: CodeReviewRange = { startLine: 3, endLine: 3, startCol: 0, endCol: 4 }
const reference: CodeReviewReference = {
  kind: "code-review",
  threadID,
  comparisonID,
  source,
  range,
  taskReference: "LZ-284",
  href: `.lazers/tasks/${encodeProjectID(source.projectID)}/LZ-284?review=${threadID}&comparison=${comparisonID}`,
  label: "src/example.ts:3",
}

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
  expect(CodeReviewRangeSchema.parse(range)).toEqual(range)
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

test("discussion schemas type anchors, threads, comments, drafts and relocation results", () => {
  const symbol: CodeReviewSymbolIdentity = {
    id: "function:example",
    name: "example",
    kind: "function",
    startLine: 2,
    endLine: 4,
  }
  expect(CodeReviewSymbolIdentitySchema.parse(symbol)).toEqual(symbol)

  const anchor: CodeReviewAnchor = CodeReviewAnchorSchema.parse({
    id: threadID,
    source,
    range,
    excerpt: "function example() {}",
    symbol,
    createdAt: 1,
  })
  const thread: CodeReviewThread = CodeReviewThreadSchema.parse({
    id: threadID,
    projectID: source.projectID,
    taskID: source.taskID,
    anchor,
    state: "open",
    revision: 1,
    correctionTaskID: null,
    createdAt: 1,
    updatedAt: 1,
  })
  const comment: CodeReviewComment = CodeReviewCommentSchema.parse({
    id: "55b5ee45-1613-48bd-b686-7a6144a8cc2e",
    threadID,
    body: "Please clarify this branch.",
    authorSessionID: "ses-review",
    createdAt: 2,
  })
  const draft: CodeReviewDraft = CodeReviewDraftSchema.parse({
    session: { status: "available", sessionID: "ses-architect" },
    reference,
    quote: "function example() {}",
    note: "Review the selected branch.",
  })
  const location: CodeReviewAnchorLocation = CodeReviewAnchorLocationSchema.parse({
    status: "located",
    source,
    range,
  })

  expect(thread.anchor).toEqual(anchor)
  expect(comment.threadID).toBe(thread.id)
  expect(draft.reference).toEqual(reference)
  expect(location).toEqual({ status: "located", source, range })
})
