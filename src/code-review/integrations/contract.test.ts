import { expect, test } from "bun:test"
import { CodeReviewIntegrationSchema, CodeReviewIntegrations } from "./contract.ts"

test("integration contract publishes the shared typed read operations", () => {
  expect(CodeReviewIntegrations.id).toBe("lazers.codeReviewIntegrations")
  expect(Object.keys(CodeReviewIntegrations.methods)).toEqual(["list", "resolve"])
})

test("integration records separate source identity from a shared target batch", () => {
  const taskID = "70cc1c08-0530-43ad-aad2-70b934243dbd"
  const otherTaskID = "55b5ee45-1613-48bd-b686-7a6144a8cc2e"
  const integration = {
    id: "2a603907-c884-40ae-b2e8-99be1958a646",
    target: {
      id: "a7c23d01-c09f-4bca-aefd-0c9b537bd571",
      projectID: "project",
      taskIDs: [taskID, otherTaskID],
      branch: "feature/review-batch",
      baseBranch: "main",
      baseRevision: "a".repeat(40),
      pullRequest: null,
      createdAt: 1,
      updatedAt: 2,
    },
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
    lineage: "proven" as const,
    batch: { batchID: "babfb88e-a5a9-4952-af95-2615c9395610", taskIDs: [taskID, otherTaskID] },
    createdAt: 3,
  }
  expect(CodeReviewIntegrationSchema.parse(integration)).toEqual(integration)
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
