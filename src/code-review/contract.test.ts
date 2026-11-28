import { expect, test } from "bun:test"
import {
  CodeReview,
  CodeReviewResolveInputSchema,
  CodeReviewSourceIdentitySchema,
  CodeReviewStructuralInputSchema,
  CODE_REVIEW_CONTRACT_VERSION,
} from "./contract.ts"
import { CodeReviewDiscussions } from "./discussions/contract.ts"
import { CodeReviewIntegrations } from "./integrations/contract.ts"

const identity = {
  version: CODE_REVIEW_CONTRACT_VERSION,
  projectID: "project",
  taskID: "70cc1c08-0530-43ad-aad2-70b934243dbd",
  planID: "1c0b584b-bb1b-4eac-8044-ea4d54676179",
  attemptID: "724f0384-9018-49e4-8fbe-7e5e999a9db1",
  comparisonID: "a".repeat(64),
  mode: "attempt",
  side: "head",
  path: "src/code-review/contract.ts",
  revision: "b".repeat(40),
} as const

test("source identities pin project, task, comparison, side, path and content revision", () => {
  expect(CodeReviewSourceIdentitySchema.parse(identity)).toEqual(identity)
  for (const path of ["/etc/passwd", "../secrets", "src/../../secrets", "src\\secret.ts", ""])
    expect(CodeReviewSourceIdentitySchema.safeParse({ ...identity, path }).success).toBe(false)
  expect(
    CodeReviewSourceIdentitySchema.safeParse({ ...identity, revision: "current" }).success,
  ).toBe(false)
})

test("mode-specific comparison coordinates are explicit and strict", () => {
  expect(() =>
    CodeReviewResolveInputSchema.parse({
      sessionID: "ses-1",
      taskID: identity.taskID,
      mode: "attempt",
    }),
  ).toThrow("attemptID")
  expect(() =>
    CodeReviewResolveInputSchema.parse({
      sessionID: "ses-1",
      taskID: identity.taskID,
      mode: "since",
      baseAttemptID: identity.attemptID,
    }),
  ).toThrow("headAttemptID")
  expect(
    CodeReviewResolveInputSchema.parse({
      sessionID: "ses-1",
      taskID: identity.taskID,
      mode: "plan",
      planID: identity.planID,
    }).mode,
  ).toBe("plan")
  expect(
    CodeReviewResolveInputSchema.safeParse({
      sessionID: "ses-1",
      taskID: identity.taskID,
      mode: "plan",
      planID: identity.planID,
      workspace: "/resurrect/me",
    }).success,
  ).toBe(false)
})

test("reviewed since inputs and structural selections are pinned and strict", () => {
  expect(
    CodeReviewResolveInputSchema.parse({
      sessionID: "ses-1",
      taskID: identity.taskID,
      mode: "since",
      baseComparisonID: "a".repeat(64),
      headAttemptID: identity.attemptID,
    }),
  ).toMatchObject({ baseComparisonID: "a".repeat(64), headAttemptID: identity.attemptID })
  expect(() =>
    CodeReviewResolveInputSchema.parse({
      sessionID: "ses-1",
      taskID: identity.taskID,
      mode: "since",
      baseComparisonID: "a".repeat(64),
      baseAttemptID: identity.attemptID,
      headAttemptID: identity.attemptID,
    }),
  ).toThrow("one since-review baseline form")

  expect(
    CodeReviewStructuralInputSchema.parse({
      sessionID: "ses-1",
      comparisonID: "a".repeat(64),
      path: "src/new.ts",
      previousPath: "src/old.ts",
      headSide: "head",
      baseSide: "base",
    }),
  ).toMatchObject({ path: "src/new.ts", previousPath: "src/old.ts" })
  expect(
    CodeReviewStructuralInputSchema.safeParse({
      sessionID: "ses-1",
      comparisonID: "a".repeat(64),
      path: "../new.ts",
    }).success,
  ).toBe(false)
})

test("shared review consumer RPC contracts publish the agreed operation names", () => {
  expect(CodeReview.id).toBe("lazers.codeReview")
  expect(Object.keys(CodeReview.methods)).toEqual([
    "resolve",
    "history",
    "shape",
    "source",
    "structural",
    "markReviewed",
    "reviewed",
  ])
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
  expect(CodeReviewIntegrations.id).toBe("lazers.codeReviewIntegrations")
  expect(Object.keys(CodeReviewIntegrations.methods)).toEqual(["list", "resolve"])
})
