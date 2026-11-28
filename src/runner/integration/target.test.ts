import { expect, test } from "bun:test"
import { CodeReviewResolver } from "../../code-review/comparisons/resolver.ts"
import { CodeReviewIntegrationStore } from "../../code-review/integrations/store.ts"
import { CodeReviewIntegrationTargetStore } from "../../code-review/integrations/target-store.ts"
import { drive, fixture, runPlan, useRuntimeFixtureCleanup } from "../runtime.fixture.ts"
import { git } from "../artifacts.ts"

useRuntimeFixtureCleanup()

test("a selected feature target records its exact range and retained integrated source", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const planID = f.receipt.planID
  await f.runtime.command({ requestID: "run", planID, action: "run" }, "owner")
  await drive(f.runtime, 2)
  const attempt = f.store.attempts(planID)[0]!
  f.completeWorker(attempt.session_id)
  await drive(f.runtime, 3)
  const node = f.store.nodes(planID)[0]!
  expect(node.state).toBe("accepted")
  const checkedOutBranch = git(f.root, ["branch", "--show-current"])
  git(f.root, ["branch", "feature/review", f.base])

  const target = {
    requestID: "select-feature-target",
    planID,
    action: "integration-target" as const,
    targetBranch: "feature/review",
    expectedTargetHead: f.base,
    targetBaseBranch: "main",
    targetBaseRevision: f.base,
    targetTaskIDs: [node.task_id],
    targetPullRequest: {
      id: "pr-17",
      number: 17,
      url: "https://example.invalid/pull/17",
      title: "Feature review",
    },
    reason: "Bind this accepted task to the reviewed feature branch.",
  }
  const targetResult = (await f.runtime.command(target, "owner")) as {
    status: string
    target: { id: string; taskIDs: string[] }
  }
  expect(targetResult.status).toBe("integration-target-recorded")
  expect(targetResult.target.taskIDs).toEqual([node.task_id])

  git(f.root, ["update-ref", "refs/heads/feature/review", node.artifact!])
  const targetAfter = git(f.root, ["rev-parse", "refs/heads/feature/review"])
  await expect(
    f.runtime.command(
      { ...target, requestID: "stale-target-update", expectedTargetHead: targetAfter },
      "owner",
    ),
  ).rejects.toThrow("Integration target is stale")

  const integrated = {
    requestID: "record-feature-landing",
    planID,
    action: "integrated" as const,
    taskID: node.task_id,
    artifact: node.artifact!,
    targetBranch: "feature/review",
    expectedTargetHead: targetAfter,
    reason: "The accepted artifact is reviewed on the selected PR target.",
  }
  await expect(
    f.runtime.command(
      { ...integrated, requestID: "stale-target-head", expectedTargetHead: f.base },
      "owner",
    ),
  ).rejects.toThrow("Expected target head is stale")
  const receipt = (await f.runtime.command(integrated, "owner")) as {
    integrationIDs: string[]
  }
  expect(receipt.integrationIDs).toHaveLength(1)
  expect(await f.runtime.command(integrated, "owner")).toEqual(receipt)
  expect(git(f.root, ["branch", "--show-current"])).toBe(checkedOutBranch)
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(f.base)

  const integrationStore = new CodeReviewIntegrationStore(f.repository)
  const integration = integrationStore.integration(node.task_id, receipt.integrationIDs[0]!)!
  expect(integration).toMatchObject({
    target: {
      id: targetResult.target.id,
      branch: "feature/review",
      baseBranch: "main",
      baseRevision: f.base,
      pullRequest: target.targetPullRequest,
    },
    sourceBaseRevision: attempt.base_commit,
    sourceArtifactRevision: node.artifact,
    sourceWorkspaceID: attempt.workspace,
    targetBeforeRevision: f.base,
    targetAfterRevision: targetAfter,
    landedCommits: [node.artifact],
    lineage: "proven",
  })
  expect(
    new CodeReviewIntegrationTargetStore(f.repository).targetByBranch("feature/review"),
  ).toMatchObject({ observedHead: targetAfter })

  const comparisonID = integrationStore.comparisonID(integration.id)!
  const resolver = new CodeReviewResolver(f.repository, f.store, f.runtime.projectID)
  const comparison = resolver.store.comparison(comparisonID)!
  const source = resolver.sourceIdentity(comparison, "head", "a.txt")
  const window = await resolver.sourceWindow(
    { sessionID: "owner", source, startLine: 1, endLine: 1 },
    new AbortController().signal,
  )
  expect(window.text).toBe("a")

  const planArtifact = f.store.plan(planID)!.artifact!
  await f.runtime.command(
    {
      requestID: "record-target-plan-integration",
      planID,
      action: "integrated",
      artifact: planArtifact,
      targetBranch: "feature/review",
      expectedTargetHead: targetAfter,
      reason: "Confirm the accepted plan on its selected target.",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(planID)!.state).toBe("integrated")
  expect(await f.host.worktrees()).toEqual([f.root])
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(f.base)

  git(f.root, ["update-ref", "-d", "refs/heads/feature/review"])
  git(f.root, ["reflog", "expire", "--expire=now", "--all"])
  git(f.root, ["gc", "--prune=now"])
  const reopened = await resolver.sourceWindow(
    { sessionID: "owner", source, startLine: 1, endLine: 1 },
    new AbortController().signal,
  )
  expect(reopened.text).toBe("a")
})

test("a batch records one actual target range for each accepted task without claiming file authorship", async () => {
  const f = fixture({ independent: true, delayed: true })
  const planID = f.receipt.planID
  await runPlan(f)
  await f.runtime.tick()
  const attempts = f.store.attempts(planID)
  expect(attempts).toHaveLength(2)
  for (const attempt of attempts) f.completeWorker(attempt.session_id)
  await drive(f.runtime, 6)
  const nodes = f.store.nodes(planID)
  expect(nodes.every((node) => node.state === "accepted" && node.artifact)).toBe(true)
  git(f.root, ["branch", "feature/batch", f.base])

  await f.runtime.command(
    {
      requestID: "select-batch-target",
      planID,
      action: "integration-target",
      targetBranch: "feature/batch",
      expectedTargetHead: f.base,
      targetBaseBranch: "main",
      targetBaseRevision: f.base,
      targetTaskIDs: nodes.map((node) => node.task_id),
      reason: "Bind both selected tasks to one feature branch.",
    },
    "owner",
  )
  const mergedTree = git(f.root, [
    "merge-tree",
    "--write-tree",
    nodes[0]!.artifact!,
    nodes[1]!.artifact!,
  ]).split("\n")[0]!
  const head = git(f.root, [
    "commit-tree",
    mergedTree,
    "-p",
    nodes[0]!.artifact!,
    "-p",
    nodes[1]!.artifact!,
    "-m",
    "Land selected tasks",
  ])
  git(f.root, ["update-ref", "refs/heads/feature/batch", head])
  const first = nodes[0]!
  const batchTaskIDs = nodes.map((node) => node.task_id)
  const receipt = (await f.runtime.command(
    {
      requestID: "record-batch-target-range",
      planID,
      action: "integrated",
      taskID: first.task_id,
      batchTaskIDs,
      artifact: first.artifact!,
      targetBranch: "feature/batch",
      expectedTargetHead: head,
      reason: "Record the shared reviewed landing range.",
    },
    "owner",
  )) as { integrationIDs: string[] }
  expect(receipt.integrationIDs).toHaveLength(2)

  const store = new CodeReviewIntegrationStore(f.repository)
  const records = nodes.map((node) =>
    store.integration(node.task_id, store.integrations(node.task_id, 10).integrations[0]!.id)!,
  )
  expect(records.map((record) => record.taskID).sort()).toEqual([...batchTaskIDs].sort())
  expect(records[0]!.batch).toMatchObject({
    taskIDs: [...batchTaskIDs].sort(),
  })
  expect(records[1]!.batch).toEqual(records[0]!.batch)
  expect(records[0]!.targetBeforeRevision).toBe(f.base)
  expect(records[1]!.targetBeforeRevision).toBe(f.base)
  expect(records[0]!.targetAfterRevision).toBe(head)
  expect(records[1]!.targetAfterRevision).toBe(head)
  expect(records[0]!.landedCommits).toEqual(records[1]!.landedCommits)

  const comparisonID = store.comparisonID(records[0]!.id)!
  const comparison = new CodeReviewResolver(
    f.repository,
    f.store,
    f.runtime.projectID,
  ).store.comparison(comparisonID)!
  const changedFiles = f.repository.read((db) =>
    db
      .query<{ path: string }, [string, string]>(
        `SELECT path FROM code_review_files
         WHERE project_directory=? AND comparison_id=? AND side='head' AND changed=1
         ORDER BY path`,
      )
      .all(f.root, comparisonID)
      .map((row) => row.path),
  )
  expect(changedFiles).toEqual(["a.txt", "b.txt"])
  expect(comparison.planContext).toBeNull()
})
