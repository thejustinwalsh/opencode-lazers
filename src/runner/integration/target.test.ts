import { expect, test } from "bun:test"
import { CodeReviewResolver } from "../../code-review/comparisons/resolver.ts"
import { CodeReviewIntegrationStore } from "../../code-review/integrations/store.ts"
import { CodeReviewIntegrationTargetStore } from "../../code-review/integrations/target-store.ts"
import { drive, fixture, runPlan, useRuntimeFixtureCleanup } from "../runtime.fixture.ts"
import { git } from "../artifacts.ts"

useRuntimeFixtureCleanup()

function commitWithFile(
  directory: string,
  parent: string,
  path: string,
  content: string,
  message: string,
) {
  const blob = git(directory, ["hash-object", "-w", "--stdin"], content)
  const entries = git(directory, ["ls-tree", parent])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [mode, type, objectID, entryPath] = line.split(/[\t ]/, 4)
      return {
        mode: mode!,
        type: type!,
        objectID: entryPath === path ? blob : objectID!,
        path: entryPath!,
      }
    })
  if (!entries.some((entry) => entry.path === path))
    entries.push({ mode: "100644", type: "blob", objectID: blob, path })
  const tree = git(
    directory,
    ["mktree"],
    entries
      .map((entry) => `${entry.mode} ${entry.type} ${entry.objectID}\t${entry.path}`)
      .join("\n"),
  )
  return git(directory, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit-tree",
    tree,
    "-p",
    parent,
    "-m",
    message,
  ])
}

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
    reason: "Bind this accepted task to the reviewed feature branch.",
  }
  const targetResult = (await f.runtime.command(target, "owner")) as {
    status: string
    target: { id: string; taskIDs: string[] }
  }
  expect(targetResult.status).toBe("integration-target-recorded")
  expect(targetResult.target.taskIDs).toEqual([node.task_id])

  const targetAfter = commitWithFile(
    f.root,
    node.artifact!,
    "a.txt",
    "target resolution\n",
    "Resolve the landed task on the target",
  )
  git(f.root, ["update-ref", "refs/heads/feature/review", targetAfter])
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

  const futureTask = f.createTask("future", "future.txt")
  await f.runtime.command(
    {
      ...target,
      requestID: "publish-target-pr",
      expectedTargetHead: targetAfter,
      targetTaskIDs: [node.task_id, futureTask.id],
      targetPullRequest: {
        id: "pr-18",
        number: 18,
        url: "https://example.invalid/pull/18",
        title: "Published after first landing",
      },
      reason: "Publish PR metadata and extend the selected task group.",
    },
    "owner",
  )

  const integrationStore = new CodeReviewIntegrationStore(f.repository)
  const integration = integrationStore.integration(node.task_id, receipt.integrationIDs[0]!)!
  expect(integration).toMatchObject({
    target: {
      id: targetResult.target.id,
      branch: "feature/review",
      baseBranch: "main",
      baseRevision: f.base,
      pullRequest: {
        id: "pr-18",
        number: 18,
        url: "https://example.invalid/pull/18",
        title: "Published after first landing",
      },
    },
    sourceBaseRevision: attempt.base_commit,
    sourceArtifactRevision: node.artifact,
    sourceWorkspaceID: attempt.workspace,
    targetBeforeRevision: f.base,
    targetAfterRevision: targetAfter,
    landedCommits: [node.artifact, targetAfter],
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
  expect(window.text).toBe("target resolution\n")

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
  expect(reopened.text).toBe("target resolution\n")
  const originalAttemptComparison = await resolver.resolve(
    {
      sessionID: "owner",
      taskID: node.task_id,
      mode: "attempt",
      attemptID: attempt.id,
    },
    new AbortController().signal,
  )
  const originalAttemptSource = resolver.sourceIdentity(originalAttemptComparison, "head", "a.txt")
  const originalAttemptWindow = await resolver.sourceWindow(
    { sessionID: "owner", source: originalAttemptSource, startLine: 1, endLine: 1 },
    new AbortController().signal,
  )
  expect(originalAttemptWindow.text).toBe("a")
  const integratedSource = resolver.sourceIdentity(comparison, "head", "a.txt")
  const integratedWindow = await resolver.sourceWindow(
    { sessionID: "owner", source: integratedSource, startLine: 1, endLine: 1 },
    new AbortController().signal,
  )
  expect(integratedWindow.text).toBe("target resolution\n")
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

test("a managed shared batch spans plans and records each task's real source lineage", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const firstPlanID = f.receipt.planID
  const secondTask = f.createTask("b", "b.txt")
  const secondPlan = f.store.submit(
    { ...f.inputFor([secondTask], { requestID: "cross-plan-batch-plan" }), dependencies: [] },
    "owner",
  )

  const accepted: Array<{
    planID: string
    taskID: string
    artifact: string
    attemptID: string
    workspace: string
  }> = []
  for (const planID of [firstPlanID, secondPlan.planID]) {
    await runPlan(f, planID, `run-cross-plan-${planID}`)
    await drive(f.runtime, 3)
    const attempt = f.store.attempts(planID)[0]!
    f.completeWorker(attempt.session_id)
    await drive(f.runtime, 6)
    const node = f.store.nodes(planID)[0]!
    expect(node.state).toBe("accepted")
    accepted.push({
      planID,
      taskID: node.task_id,
      artifact: node.artifact!,
      attemptID: attempt.id,
      workspace: attempt.workspace,
    })
  }

  git(f.root, ["branch", "feature/cross-plan", f.base])
  await f.runtime.command(
    {
      requestID: "select-cross-plan-target",
      planID: firstPlanID,
      action: "integration-target",
      targetBranch: "feature/cross-plan",
      expectedTargetHead: f.base,
      targetBaseBranch: "main",
      targetBaseRevision: f.base,
      targetTaskIDs: accepted.map((source) => source.taskID),
      reason: "Bind accepted tasks from both plans to one target.",
    },
    "owner",
  )

  const mergedTree = git(f.root, [
    "merge-tree",
    "--write-tree",
    accepted[0]!.artifact,
    accepted[1]!.artifact,
  ]).split("\n")[0]!
  const head = git(f.root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit-tree",
    mergedTree,
    "-p",
    accepted[0]!.artifact,
    "-p",
    accepted[1]!.artifact,
    "-m",
    "Land accepted tasks from separate plans",
  ])
  git(f.root, ["update-ref", "refs/heads/feature/cross-plan", head])

  const receipt = (await f.runtime.command(
    {
      requestID: "record-cross-plan-batch",
      planID: firstPlanID,
      action: "integrated",
      taskID: accepted[0]!.taskID,
      batchTaskIDs: accepted.map((source) => source.taskID),
      artifact: accepted[0]!.artifact,
      targetBranch: "feature/cross-plan",
      expectedTargetHead: head,
      reason: "Record one reviewed landing range for both plans.",
    },
    "owner",
  )) as { integrationIDs: string[] }

  const store = new CodeReviewIntegrationStore(f.repository)
  const records = accepted.map((source) =>
    store.integration(source.taskID, store.integrations(source.taskID, 10).integrations[0]!.id)!,
  )
  expect(receipt.integrationIDs).toHaveLength(2)
  expect(records.map((record) => [record.taskID, record.planID, record.attemptID])).toEqual(
    accepted.map((source) => [source.taskID, source.planID, source.attemptID]),
  )
  expect(records.map((record) => record.sourceWorkspaceID)).toEqual(
    accepted.map((source) => source.workspace),
  )
  expect(records.map((record) => record.targetBeforeRevision)).toEqual([f.base, f.base])
  expect(records.map((record) => record.targetAfterRevision)).toEqual([head, head])
  expect(records[0]!.batch).toEqual(records[1]!.batch)
  expect(
    f.store
      .activity(firstPlanID, accepted[0]!.taskID)
      .some((row) => row.event === "TASK_INTEGRATION_RECORDED"),
  ).toBe(true)
  expect(
    f.store
      .activity(secondPlan.planID, accepted[1]!.taskID)
      .some((row) => row.event === "TASK_INTEGRATION_RECORDED"),
  ).toBe(true)
})

test("dependent task dispatch proves and starts from the managed target, not canonical main", async () => {
  const f = fixture({
    delayed: true,
    commit: true,
    taskFiles: [
      { name: "a", path: "a.txt" },
      { name: "b", path: "b.txt" },
    ],
  })
  const planID = f.receipt.planID
  await runPlan(f)
  await drive(f.runtime, 3)
  const firstAttempt = f.store.attempts(planID)[0]!
  f.completeWorker(firstAttempt.session_id)
  await drive(f.runtime, 6)
  const nodes = f.store.nodes(planID)
  expect(nodes[0]?.state).toBe("accepted")
  expect(f.store.attempts(planID)).toHaveLength(1)

  git(f.root, ["branch", "feature/dependent", f.base])
  await f.runtime.command(
    {
      requestID: "select-dependent-target",
      planID,
      action: "integration-target",
      targetBranch: "feature/dependent",
      expectedTargetHead: f.base,
      targetBaseBranch: "main",
      targetBaseRevision: f.base,
      targetTaskIDs: [nodes[0]!.task_id],
      reason: "Bind the prerequisite to the reviewed feature target.",
    },
    "owner",
  )
  const resolvedHead = commitWithFile(
    f.root,
    nodes[0]!.artifact!,
    "a.txt",
    "resolved on target\n",
    "Resolve the prerequisite on the target",
  )
  git(f.root, ["update-ref", "refs/heads/feature/dependent", resolvedHead])
  await f.runtime.command(
    {
      requestID: "integrate-dependent-prerequisite",
      planID,
      action: "integrated",
      taskID: nodes[0]!.task_id,
      artifact: nodes[0]!.artifact!,
      targetBranch: "feature/dependent",
      expectedTargetHead: resolvedHead,
      reason: "Record the landed prerequisite on the selected target.",
    },
    "owner",
  )

  await f.runtime.tick()
  expect(f.store.attempts(planID)).toHaveLength(1)
  await f.runtime.command(
    {
      requestID: "extend-dependent-target",
      planID,
      action: "integration-target",
      targetBranch: "feature/dependent",
      expectedTargetHead: resolvedHead,
      targetBaseBranch: "main",
      targetBaseRevision: f.base,
      targetTaskIDs: nodes.map((node) => node.task_id),
      reason: "Explicitly add the dependent task to the same target.",
    },
    "owner",
  )

  let dependentPrompt = false
  const originalPrompt = f.host.prompt
  f.host.prompt = async (input) => {
    const dependent = f.store
      .attempts(planID)
      .find((attempt) => attempt.task_id === nodes[1]!.task_id)
    if (dependent) {
      dependentPrompt = true
      expect(dependent.base_commit).toBe(resolvedHead)
      expect(git(input.directory, ["rev-parse", "HEAD"])).toBe(resolvedHead)
      expect(git(input.directory, ["show", "HEAD:a.txt"])).toBe("resolved on target")
    }
    await originalPrompt(input)
  }
  await f.runtime.tick()
  await drive(f.runtime, 3)
  expect(dependentPrompt).toBe(true)
  expect(f.store.attempts(planID)).toHaveLength(2)
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(f.base)

  const secondAttempt = f.store.attempts(planID)[1]!
  f.completeWorker(secondAttempt.session_id)
  await drive(f.runtime, 6)
  const dependentNode = f.store.node(planID, nodes[1]!.task_id)!
  expect(dependentNode.state).toBe("accepted")
  git(f.root, ["update-ref", "refs/heads/feature/dependent", dependentNode.artifact!])
  await f.runtime.command(
    {
      requestID: "integrate-dependent-task",
      planID,
      action: "integrated",
      taskID: dependentNode.task_id,
      artifact: dependentNode.artifact!,
      targetBranch: "feature/dependent",
      expectedTargetHead: dependentNode.artifact!,
      reason: "Extend the same target with the dependent task.",
    },
    "owner",
  )
  const integration = new CodeReviewIntegrationStore(f.repository).integrations(
    dependentNode.task_id,
    10,
  ).integrations[0]!
  expect(integration.targetBeforeRevision).toBe(resolvedHead)
  expect(integration.targetAfterRevision).toBe(dependentNode.artifact)
  expect(integration.target?.branch).toBe("feature/dependent")
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(f.base)
})

test("reviewed target rewrites reconcile without replacing old lineage before a later landing", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const firstPlanID = f.receipt.planID
  const secondTask = f.createTask("b", "b.txt")
  const secondPlan = f.store.submit(
    { ...f.inputFor([secondTask], { requestID: "rewrite-followup-plan" }), dependencies: [] },
    "owner",
  )

  const accepted: Array<{
    planID: string
    taskID: string
    artifact: string
    attemptID: string
  }> = []
  for (const planID of [firstPlanID, secondPlan.planID]) {
    await runPlan(f, planID, `run-rewrite-${planID}`)
    await drive(f.runtime, 3)
    const attempt = f.store.attempts(planID)[0]!
    f.completeWorker(attempt.session_id)
    await drive(f.runtime, 6)
    const node = f.store.nodes(planID)[0]!
    accepted.push({
      planID,
      taskID: node.task_id,
      artifact: node.artifact!,
      attemptID: attempt.id,
    })
  }

  const branch = "feature/rewritten"
  const pullRequest = {
    id: "pr-rewritten",
    number: 29,
    url: "https://example.invalid/pull/29",
    title: "Rebased feature",
  }
  git(f.root, ["branch", branch, f.base])
  const targetSetup = {
    action: "integration-target" as const,
    targetBranch: branch,
    targetBaseBranch: "main",
    targetBaseRevision: f.base,
    targetTaskIDs: [accepted[0]!.taskID],
    reason: "Bind the first accepted task to the reviewed PR.",
  }
  const setup = (await f.runtime.command(
    {
      ...targetSetup,
      requestID: "select-rewrite-target",
      planID: firstPlanID,
      expectedTargetHead: f.base,
      targetPullRequest: pullRequest,
    },
    "owner",
  )) as { target: { id: string } }
  git(f.root, ["update-ref", `refs/heads/${branch}`, accepted[0]!.artifact])
  const firstHead = accepted[0]!.artifact
  await f.runtime.command(
    {
      requestID: "integrate-before-rewrite",
      planID: firstPlanID,
      action: "integrated",
      taskID: accepted[0]!.taskID,
      artifact: accepted[0]!.artifact,
      targetBranch: branch,
      expectedTargetHead: firstHead,
      reason: "Record the first target landing.",
    },
    "owner",
  )
  const integrationStore = new CodeReviewIntegrationStore(f.repository)
  const firstIntegration = integrationStore.integrations(accepted[0]!.taskID, 10).integrations[0]!
  const firstRange = {
    before: firstIntegration.targetBeforeRevision,
    after: firstIntegration.targetAfterRevision,
    commits: firstIntegration.landedCommits,
  }

  const sourceTree = git(f.root, ["rev-parse", `${accepted[0]!.artifact}^{tree}`])
  const rewrittenHead = git(f.root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit-tree",
    sourceTree,
    "-p",
    f.base,
    "-m",
    "Rebase the target onto its reviewed base",
  ])
  git(f.root, ["update-ref", `refs/heads/${branch}`, rewrittenHead])
  await expect(
    f.runtime.command(
      {
        ...targetSetup,
        requestID: "reject-unacknowledged-rewrite",
        planID: firstPlanID,
        expectedTargetHead: rewrittenHead,
      },
      "owner",
    ),
  ).rejects.toThrow("stale")
  const reconciled = (await f.runtime.command(
    {
      ...targetSetup,
      requestID: "reconcile-reviewed-rewrite",
      planID: firstPlanID,
      expectedTargetHead: firstHead,
      reconcileTargetHead: true,
      reason: "Acknowledge the reviewed rebase without claiming its intervening range.",
    },
    "owner",
  )) as { status: string; target: { id: string; pullRequest: unknown }; observedHead: string }
  expect(reconciled.status).toBe("integration-target-reconciled")
  expect(reconciled.observedHead).toBe(rewrittenHead)
  expect(reconciled.target.id).toBe(setup.target.id)
  expect(reconciled.target.pullRequest).toEqual(pullRequest)
  await expect(
    f.runtime.command(
      {
        ...targetSetup,
        requestID: "reject-stale-rewrite-reconciliation",
        planID: firstPlanID,
        expectedTargetHead: firstHead,
        reconcileTargetHead: true,
      },
      "owner",
    ),
  ).rejects.toThrow("preserve the recorded project")

  const rereadFirst = integrationStore.integration(accepted[0]!.taskID, firstIntegration.id)!
  expect(rereadFirst).toMatchObject({
    target: { id: setup.target.id, pullRequest },
    targetBeforeRevision: firstRange.before,
    targetAfterRevision: firstRange.after,
    landedCommits: firstRange.commits,
  })

  await f.runtime.command(
    {
      ...targetSetup,
      requestID: "extend-reconciled-target",
      planID: secondPlan.planID,
      expectedTargetHead: rewrittenHead,
      targetTaskIDs: accepted.map((source) => source.taskID),
      reason: "Add the second accepted task to the same reviewed target.",
    },
    "owner",
  )
  const mergedTree = git(f.root, [
    "merge-tree",
    "--write-tree",
    rewrittenHead,
    accepted[1]!.artifact,
  ]).split("\n")[0]!
  const nextHead = git(f.root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit-tree",
    mergedTree,
    "-p",
    rewrittenHead,
    "-p",
    accepted[1]!.artifact,
    "-m",
    "Land the next task after target reconciliation",
  ])
  git(f.root, ["update-ref", `refs/heads/${branch}`, nextHead])
  await f.runtime.command(
    {
      requestID: "integrate-after-rewrite",
      planID: secondPlan.planID,
      action: "integrated",
      taskID: accepted[1]!.taskID,
      artifact: accepted[1]!.artifact,
      targetBranch: branch,
      expectedTargetHead: nextHead,
      reason: "Record the next actual landing on the reconciled target.",
    },
    "owner",
  )
  const secondIntegration = integrationStore.integrations(accepted[1]!.taskID, 10).integrations[0]!
  expect(secondIntegration).toMatchObject({
    target: { id: setup.target.id, pullRequest },
    targetBeforeRevision: rewrittenHead,
    targetAfterRevision: nextHead,
  })
})

test("ambiguous accepted attempt identity refuses guessing and accepts an exact selection", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const planID = f.receipt.planID
  await runPlan(f)
  await drive(f.runtime, 3)
  const attempt = f.store.attempts(planID)[0]!
  f.completeWorker(attempt.session_id)
  await drive(f.runtime, 6)
  const node = f.store.nodes(planID)[0]!

  const duplicateAttemptID = crypto.randomUUID()
  f.store.atomic((db) =>
    db
      .query(
        `INSERT INTO runner_attempts(
           id,plan_id,project_directory,task_id,number,session_id,message_id,workspace,
           base_commit,artifact,policy,state,started_at,token_count,tool_count,retry_count,cost
         )
         SELECT ?,plan_id,project_directory,task_id,number+1,?,?,workspace,base_commit,artifact,
                policy,state,started_at+1,token_count,tool_count,retry_count,cost
         FROM runner_attempts WHERE id=?`,
      )
      .run(duplicateAttemptID, crypto.randomUUID(), crypto.randomUUID(), attempt.id),
  )
  git(f.root, ["branch", "feature/ambiguous", f.base])
  await f.runtime.command(
    {
      requestID: "select-ambiguous-target",
      planID,
      action: "integration-target",
      targetBranch: "feature/ambiguous",
      expectedTargetHead: f.base,
      targetBaseBranch: "main",
      targetBaseRevision: f.base,
      targetTaskIDs: [node.task_id],
      reason: "Bind the accepted task before recording it.",
    },
    "owner",
  )
  git(f.root, ["update-ref", "refs/heads/feature/ambiguous", node.artifact!])
  const integrated = {
    requestID: "reject-ambiguous-source",
    planID,
    action: "integrated" as const,
    taskID: node.task_id,
    artifact: node.artifact!,
    targetBranch: "feature/ambiguous",
    expectedTargetHead: node.artifact!,
    reason: "Record the task on its selected target.",
  }
  await expect(f.runtime.command(integrated, "owner")).rejects.toThrow(
    "multiple matching attempts; specify integrationAttempts",
  )

  const receipt = (await f.runtime.command(
    {
      ...integrated,
      requestID: "select-exact-source-attempt",
      integrationAttempts: [{ taskID: node.task_id, attemptID: attempt.id }],
    },
    "owner",
  )) as { integrationIDs: string[] }
  const integration = new CodeReviewIntegrationStore(f.repository).integration(
    node.task_id,
    receipt.integrationIDs[0]!,
  )!
  expect(integration.attemptID).toBe(attempt.id)
  expect(integration.sourceWorkspaceID).toBe(attempt.workspace)
})
