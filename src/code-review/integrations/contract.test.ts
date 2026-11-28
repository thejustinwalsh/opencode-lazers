import { expect, test } from "bun:test"
import { CodeReviewComparisonSchema } from "../contract.ts"
import {
  CodeReviewIntegrationPullRequestSchema,
  CodeReviewIntegrationSchema,
  CodeReviewIntegrationTargetSchema,
  CodeReviewIntegratedComparisonSchema,
  CodeReviewIntegrations,
  CodeReviewIntegrationsListInputSchema,
  CodeReviewIntegrationsListOutputSchema,
} from "./contract.ts"
import type {
  CodeReviewIntegration,
  CodeReviewIntegratedComparison,
  CodeReviewIntegrationPullRequest,
  CodeReviewIntegrationTarget,
} from "./contract.ts"

const taskID = "70cc1c08-0530-43ad-aad2-70b934243dbd"
const otherTaskID = "55b5ee45-1613-48bd-b686-7a6144a8cc2e"
const integrationID = "2a603907-c884-40ae-b2e8-99be1958a646"

test("integration contract publishes the shared typed read operations", () => {
  expect(CodeReviewIntegrations.id).toBe("lazers.codeReviewIntegrations")
  expect(Object.keys(CodeReviewIntegrations.methods)).toEqual(["list", "resolve"])
})

test("integration schemas retain target, source, batch and comparison identities", () => {
  const pullRequest: CodeReviewIntegrationPullRequest =
    CodeReviewIntegrationPullRequestSchema.parse({
      id: "pr-42",
      number: 42,
      url: "https://example.invalid/pull/42",
      title: "Review batch",
    })
  const target: CodeReviewIntegrationTarget = CodeReviewIntegrationTargetSchema.parse({
    id: "a7c23d01-c09f-4bca-aefd-0c9b537bd571",
    projectID: "project",
    taskIDs: [taskID, otherTaskID],
    branch: "feature/review-batch",
    baseBranch: "main",
    baseRevision: "a".repeat(40),
    pullRequest,
    createdAt: 1,
    updatedAt: 2,
  })
  const integration: CodeReviewIntegration = CodeReviewIntegrationSchema.parse({
    id: integrationID,
    target,
    taskID,
    planID: null,
    attemptID: null,
    sourceBaseRevision: "a".repeat(40),
    sourceArtifactRevision: "b".repeat(40),
    sourceWorkspaceID: "native-worktree-42",
    targetBeforeRevision: "c".repeat(40),
    targetAfterRevision: "d".repeat(40),
    landedCommits: ["d".repeat(40)],
    proofID: "proof-42",
    lineage: "proven",
    batch: { batchID: "babfb88e-a5a9-4952-af95-2615c9395610", taskIDs: [taskID, otherTaskID] },
    createdAt: 3,
  })
  const comparison = CodeReviewComparisonSchema.parse({
    identity: {
      version: 1,
      comparisonID: "e".repeat(64),
      projectID: "project",
      taskID,
      planID: null,
      attemptID: null,
      mode: "attempt",
      baseRevision: "a".repeat(40),
      headRevision: "b".repeat(40),
      snapshotID: null,
      capturedAt: null,
      attribution: "committed",
    },
    available: true,
    unavailableReason: null,
    fileCount: 1,
    changedCount: 1,
    sides: ["base", "head"],
    sourceName: "codeReview.files",
    taskReference: "LZ-284",
    taskTitle: "Add review integration contracts",
    planContext: null,
  })
  const integrated: CodeReviewIntegratedComparison = CodeReviewIntegratedComparisonSchema.parse({
    comparison,
    integration,
  })
  const cursor = { createdAt: integration.createdAt, integrationID: integration.id }
  const listInput = CodeReviewIntegrationsListInputSchema.parse({
    sessionID: "ses-review",
    taskID,
    limit: 25,
    cursor,
  })
  const listOutput = CodeReviewIntegrationsListOutputSchema.parse({
    integrations: [integration],
    nextCursor: cursor,
  })

  expect(integrated).toEqual({ comparison, integration })
  expect(listInput.cursor).toEqual(cursor)
  expect(listOutput.integrations[0]?.target?.pullRequest).toEqual(pullRequest)
  expect(
    CodeReviewIntegrationSchema.safeParse({
      ...integration,
      batch: {
        ...integration.batch,
        taskIDs: [taskID, "624fc8bb-57b7-4b3d-a708-f9d44d5ec0c8"],
      },
    }).success,
  ).toBe(false)
})
