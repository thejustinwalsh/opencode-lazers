import { allPlans } from "./store-plans.fixture.ts"
import { expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { git } from "./artifacts.ts"
import type { RunnerCheckReceipt } from "./artifacts.ts"
import { getTaskDetail } from "../tasks/stream-query.ts"
import {
  TaskRuntime,
  acceptAndIntegratePlan,
  acceptPlan,
  drive,
  fixture,
  includeArtifact,
  prepareAfterPlanDependency,
  recordPlanIntegration,
  runPlan,
  useRuntimeFixtureCleanup,
} from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

test("priority orders conflicting plans without rejecting their overlapping scopes", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    taskFiles: [{ name: "a", path: "src/a.txt", scope: ["src/**"] }],
  })
  const b = f.createTask("b", "src/b.txt", ["src/**"])
  const later = f.store.submit(
    { ...f.inputFor([b], { requestID: "priority-b" }), priority: 10 },
    "owner",
  )
  await runPlan(f, f.receipt.planID, "priority-run-a")
  await runPlan(f, later.planID, "priority-run-b")
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(0)
  const attempt = f.store.attempts(later.planID)[0]!
  expect(attempt).toBeDefined()
  expect(
    allPlans(f.store).flatMap((plan) => f.store.attempts(plan.id).map((row) => row.task_id)),
  ).toEqual([b.id])
  expect(f.sessions.get(attempt.session_id)?.busy).toBe(true)
  const updated = await f.runtime.command(
    {
      requestID: "priority-live",
      planID: later.planID,
      action: "schedule",
      priority: 0,
      reason: "Let another plan take precedence after this worker finishes",
    },
    "owner",
  )
  expect(updated).toMatchObject({ status: "scheduled" })
  expect(f.store.attempts(later.planID)).toHaveLength(1)
  expect(f.sessions.get(attempt.session_id)?.busy).toBe(true)
})

test("runtime dispatch breaks submission ties by plan order and shared ordinal order", async () => {
  const f = fixture({
    shared: true,
    independent: true,
    delayed: true,
    taskFiles: [
      { name: "first", path: "first.ts" },
      { name: "second", path: "second.ts" },
    ],
  })
  const laterTask = f.createTask("later", "later.ts")
  const later = f.store.submit(
    { ...f.inputFor([laterTask], { requestID: "tied-submission" }), priority: 0 },
    "owner",
  )
  await runPlan(f, f.receipt.planID, "run-tied-first")
  await runPlan(f, later.planID, "run-tied-later")

  await f.runtime.tick()
  const actual = allPlans(f.store).flatMap((plan) =>
    f.store.attempts(plan.id).map((attempt) => attempt.task_id),
  )
  expect(actual).toEqual([f.tasks[0]!.id])
})

test("afterPlans dispatches from combined integration while prerequisite cleanup is still pending", async () => {
  for (const childPriority of [10, 0]) {
    const f = fixture({
      independent: true,
      delayed: true,
      commit: true,
      taskFiles: [{ name: "a", path: "a.txt" }],
    })
    const parentID = f.receipt.planID
    // A child that ranks below its prerequisite still dispatches once the prerequisite integrates.
    if (childPriority === 0)
      f.store.atomic((db) =>
        db
          .query("UPDATE runner_plans SET body=json_set(body,'$.priority',1) WHERE id=?")
          .run(parentID),
      )
    const childTask = f.createTask("b", "b.txt")
    const child = f.store.submit(
      {
        ...f.inputFor([childTask], { requestID: `dependent-${childPriority}` }),
        afterPlans: [parentID],
        priority: childPriority,
      },
      "owner",
    )
    await runPlan(f, child.planID, `run-child-${childPriority}`)
    const accepted = await acceptPlan(f, parentID)
    expect(await getTaskDetail(f.repository, { taskID: childTask.id })).toMatchObject({
      recordedState: "queued",
      execution: {
        state: "blocked",
        reason: expect.stringContaining(`[${parentID}] is accepted`),
        waitingOnPlans: [expect.objectContaining({ planID: parentID, state: "accepted" })],
      },
    })
    const sentinel = join(accepted.attempt.workspace, "keep-owned-worktree.txt")
    writeFileSync(sentinel, "still owned")
    includeArtifact(f, accepted.plan.artifact!)
    await recordPlanIntegration(f, parentID, { recordTaskLanding: true })
    expect(f.store.plan(parentID)!.state).toBe("cleaning")
    const observations: { parentState: string; workspace: string; source: string }[] = []
    const originalPrompt = f.host.prompt
    f.host.prompt = async (input) => {
      const parent = f.store.plan(parentID)!
      expect(existsSync(accepted.attempt.workspace)).toBe(true)
      expect(readFileSync(sentinel, "utf8")).toBe("still owned")
      expect(input.directory).not.toBe(accepted.attempt.workspace)
      expect(readFileSync(join(input.directory, "a.txt"), "utf8")).toBe("a")
      observations.push({
        parentState: parent.state,
        workspace: input.directory,
        source: git(input.directory, ["rev-parse", "HEAD"]),
      })
      await originalPrompt(input)
    }

    await f.runtime.tick()
    expect(observations).toHaveLength(1)
    expect(observations[0]!.parentState).toBe("cleanup-blocked")
    expect(observations[0]!.source).toBe(accepted.plan.artifact!)
    expect(f.store.plan(parentID)!.state).toBe("cleanup-blocked")
    const childAttempt = f.store.attempts(child.planID)[0]!
    expect(childAttempt.workspace).toBe(observations[0]!.workspace)
    expect(childAttempt.workspace).not.toBe(accepted.attempt.workspace)
    expect(childAttempt.base_commit).toBe(accepted.plan.artifact!)
    expect(childAttempt.task_id).toBe(childTask.id)
  }
})

test("task dependencies dispatch only after durable source integration and use its fresh descendant baseline", async () => {
  const f = fixture({ delayed: true, commit: true })
  await runPlan(f)
  await f.runtime.tick()
  const prerequisiteTaskID = f.store.nodes(f.receipt.planID)[0]!.task_id
  const firstAttempt = f.store.attempts(f.receipt.planID)[0]!
  f.completeWorker(firstAttempt.session_id)
  await drive(f.runtime, 6)

  const predecessor = f.store.nodes(f.receipt.planID)[0]!
  expect(f.store.nodes(f.receipt.planID)[0]!.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(f.store.execution(f.tasks[1]!.id)?.waitingOn).toEqual([prerequisiteTaskID])

  const artifact = predecessor.artifact!
  includeArtifact(f, artifact)
  const landingVersion = f.store.plan(f.receipt.planID)!.version
  await f.runtime.command(
    {
      requestID: "land-task-prerequisite",
      planID: f.receipt.planID,
      action: "integrated",
      taskID: predecessor.task_id,
      artifact,
      targetBranch: "main",
      reason: "Review and land the accepted prerequisite task source",
    },
    "owner",
  )
  git(f.root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "Newer integrated baseline",
  ])
  const baseline = git(f.root, ["rev-parse", "HEAD"])
  expect(baseline).not.toBe(artifact)

  // A receipt alone is not authority: moving the reviewed branch behind its
  // recorded integration head invalidates the fresh ancestry proof.
  git(f.root, ["update-ref", "refs/heads/main", f.base])
  const promptsBefore = f.events.filter((event) => event.startsWith("prompt:")).length
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("prompt:")).length).toBe(promptsBefore)
  git(f.root, ["update-ref", "refs/heads/main", baseline])

  const originalPrompt = f.host.prompt
  f.host.prompt = async (input) => {
    const dependent = f.store
      .attempts(f.receipt.planID)
      .find((attempt) => attempt.task_id === f.tasks[1]!.id)
    expect(dependent?.base_commit).toBe(baseline)
    expect(git(input.directory, ["rev-parse", "HEAD"])).toBe(baseline)
    expect(readFileSync(join(input.directory, "a.txt"), "utf8")).toBe("a")
    await originalPrompt(input)
  }
  await f.runtime.tick()

  const attempts = f.store.attempts(f.receipt.planID)
  expect(attempts).toHaveLength(2)
  expect(attempts[1]?.task_id).toBe(f.tasks[1]!.id)
  expect(attempts[1]?.base_commit).toBe(baseline)
})

test("cancelling a child during session creation prevents prompt intent and preserves owned resources", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const { child, accepted } = await prepareAfterPlanDependency(f, "cancel-session")
  const sentinel = join(accepted.attempt.workspace, "keep-owned-worktree.txt")
  writeFileSync(sentinel, "still owned")
  const originalCreate = f.host.create
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  f.host.create = async (input) => {
    enter()
    await blocked
    await originalCreate(input)
  }

  const preparation = f.runtime.tick()
  await entered
  await f.runtime.command(
    {
      requestID: "cancel-child-during-session-create",
      planID: child.planID,
      action: "cancel",
    },
    "owner",
  )
  release()
  await preparation

  const attempt = f.store.attempts(child.planID)[0]!
  expect(f.store.plan(child.planID)?.state).toBe("cancelling")
  expect(attempt.state).toBe("preparing")
  expect(f.store.effects(child.planID).find((effect) => effect.kind === "session")?.state).toBe(
    "completed",
  )
  expect(f.store.effects(child.planID).some((effect) => effect.kind === "prompt")).toBe(false)
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(2)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  expect(existsSync(attempt.workspace)).toBe(true)
  expect(f.sessions.has(attempt.session_id)).toBe(true)
  expect(readFileSync(sentinel, "utf8")).toBe("still owned")

  await f.runtime.tick()
  expect(f.store.plan(child.planID)?.state).toBe("cancelled")
  expect(f.store.attempts(child.planID)).toHaveLength(1)
  // Cleanup now runs after the plan loop in the same tick, so the settled, clean worktree may
  // already be retired; what must hold is that it was never removed while the cancel was pending.
})

test("afterPlans invalidation during retained preparation reconciliation blocks the later prompt", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const { parentID, child, accepted } = await prepareAfterPlanDependency(
    f,
    "cancel-reconcile",
    10,
    true,
  )
  const sentinel = join(accepted.attempt.workspace, "keep-owned-worktree.txt")
  writeFileSync(sentinel, "still owned")
  const originalCreate = f.host.create
  let createCalls = 0
  f.host.create = async (input) => {
    createCalls++
    await originalCreate(input)
    throw new Error("session creation reply lost")
  }
  await f.runtime.tick()
  const attempt = f.store.attempts(child.planID)[0]!
  expect(f.store.plan(parentID)?.state).toBe("cleanup-blocked")
  expect(f.store.plan(child.planID)?.state).toBe("blocked")
  expect(attempt.state).toBe("preparing")
  expect(f.store.effects(child.planID).find((effect) => effect.kind === "session")?.state).toBe(
    "uncertain",
  )
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)

  const originalSession = f.host.session
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  f.host.session = async (id, options) => {
    if (id === attempt.session_id && !options?.messages) {
      enter()
      await blocked
    }
    return originalSession(id, options)
  }
  const reconciliation = f.runtime.tick()
  await entered
  // Model a legacy cleanup-blocked snapshot after a newer durable cancellation
  // invalidation while the retained effect is read.
  f.store.atomic((db) => {
    db.query(
      "UPDATE runner_plans SET state='cleanup-blocked',reason=?,version=version+1 WHERE id=?",
    ).run("Legacy cleanup snapshot after cancellation", parentID)
    f.store.record(parentID, null, "CANCEL_REQUESTED", {
      caller: "owner",
      phase: "retained-preparation-reconciliation",
    })
  })
  release()
  await reconciliation
  expect(f.store.effects(child.planID).find((effect) => effect.kind === "session")?.state).toBe(
    "completed",
  )
  expect(createCalls).toBe(1)

  await f.runtime.command(
    {
      requestID: "resume-retained-child",
      planID: child.planID,
      action: "reconcile",
    },
    "owner",
  )
  await f.runtime.tick()

  expect(f.store.attempts(child.planID)).toHaveLength(1)
  expect(f.store.attempts(child.planID)[0]?.state).toBe("preparing")
  expect(f.store.effects(child.planID).some((effect) => effect.kind === "prompt")).toBe(false)
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(2)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  expect(existsSync(attempt.workspace)).toBe(true)
  expect(f.sessions.has(attempt.session_id)).toBe(true)
  expect(readFileSync(sentinel, "utf8")).toBe("still owned")
})

test("afterPlans dispatches after genuine combined-check recovery while preserving failed receipts", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    commit: true,
    requireVerifierPreparation: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const parentID = f.receipt.planID
  const childTask = f.createTask("b", "b.txt")
  const child = f.store.submit(
    {
      ...f.inputFor([childTask], { requestID: "recovered-child" }),
      afterPlans: [parentID],
      priority: 10,
    },
    "owner",
  )
  await runPlan(f, child.planID, "run-recovered-child")
  await runPlan(f, parentID, "run-recovered-parent")
  await f.runtime.tick()
  const parentAttempt = f.store.attempts(parentID)[0]!
  f.completeWorker(parentAttempt.session_id)
  await drive(f.runtime, 6)

  expect(f.store.plan(parentID)?.state).toBe("blocked")
  expect(f.store.attempts(child.planID)).toHaveLength(0)
  const failedReceipt = f.store
    .effects(parentID)
    .find((effect) => effect.kind === "graph-verify:combined")!
  expect(JSON.parse(failedReceipt.receipt!).check.exitCode).not.toBe(0)
  const failedReceiptSnapshot = [failedReceipt.id, failedReceipt.state, failedReceipt.receipt]

  writeFileSync(join(dirname(f.repository.path), "verifier-ready"), "repaired environment")
  await f.runtime.command(
    {
      requestID: "reconcile-genuine-parent",
      planID: parentID,
      action: "reconcile",
    },
    "owner",
  )
  await drive(f.runtime, 6)
  const accepted = f.store.plan(parentID)!
  expect(accepted.state).toBe("accepted")
  const recoveredArtifact = accepted.artifact
  if (!recoveredArtifact) throw new Error("Expected genuine combined acceptance artifact")
  const acceptedTransition = f.store.latestTransition<{
    artifact: string
    checks: RunnerCheckReceipt[]
  }>(parentID, null, "PLAN_ACCEPTED")!
  expect(acceptedTransition.artifact).toBe(recoveredArtifact)
  expect(acceptedTransition.checks.every((check) => check.exitCode === 0)).toBe(true)
  expect(f.store.effects(parentID).find((effect) => effect.id === failedReceipt.id)).toMatchObject({
    id: failedReceiptSnapshot[0],
    state: failedReceiptSnapshot[1],
    receipt: failedReceiptSnapshot[2],
  })

  includeArtifact(f, recoveredArtifact)
  await recordPlanIntegration(f, parentID)
  const parentSentinel = join(parentAttempt.workspace, "keep-owned-worktree.txt")
  writeFileSync(parentSentinel, "still owned")
  await f.runtime.tick()

  expect(f.store.plan(parentID)?.state).toBe("cleanup-blocked")
  const childAttempt = f.store.attempts(child.planID)[0]!
  expect(childAttempt.state).toBe("running")
  expect(childAttempt.base_commit).toBe(recoveredArtifact)
  expect(readFileSync(join(childAttempt.workspace, "a.txt"), "utf8")).toBe("a")
  expect(readFileSync(parentSentinel, "utf8")).toBe("still owned")
  expect(f.events.some((event) => event.startsWith("prompt:"))).toBe(true)
  expect(f.store.effects(parentID).find((effect) => effect.id === failedReceipt.id)).toMatchObject({
    id: failedReceiptSnapshot[0],
    state: failedReceiptSnapshot[1],
    receipt: failedReceiptSnapshot[2],
  })
})

test("afterPlans rejects task-only, missing, malformed, mismatched and foreign integration evidence", async () => {
  for (const invalidation of [
    "missing",
    "task-only",
    "malformed",
    "artifact-mismatch",
    "foreign-prerequisite",
  ] as const) {
    const f = fixture({
      independent: true,
      delayed: true,
      commit: true,
      taskFiles: [{ name: "a", path: "a.txt" }],
    })
    const parentID = f.receipt.planID
    const childTask = f.createTask("b", "b.txt")
    const child = f.store.submit(
      {
        ...f.inputFor([childTask], { requestID: `invalid-${invalidation}` }),
        afterPlans: [parentID],
        priority: 10,
      },
      "owner",
    )
    await runPlan(f, child.planID, `run-invalid-${invalidation}`)
    const accepted = await acceptPlan(f, parentID)
    includeArtifact(f, accepted.plan.artifact!)

    if (invalidation === "task-only") {
      const node = f.store.nodes(parentID)[0]!
      await f.runtime.command(
        {
          requestID: `task-only-${parentID}`,
          planID: parentID,
          action: "integrated",
          taskID: node.task_id,
          artifact: node.artifact!,
          targetBranch: "main",
          reason: "Record task landing without combined plan integration",
        },
        "owner",
      )
    } else await recordPlanIntegration(f, parentID)

    f.store.atomic((db) => {
      if (invalidation === "missing")
        db.query(
          "DELETE FROM runner_transitions WHERE plan_id=? AND task_id IS NULL AND event='INTEGRATION_RECORDED'",
        ).run(parentID)
      if (invalidation === "malformed" || invalidation === "artifact-mismatch") {
        const receipt = db
          .query<{ id: number; payload: string }, [string]>(
            "SELECT id,payload FROM runner_transitions WHERE plan_id=? AND task_id IS NULL AND event='INTEGRATION_RECORDED' ORDER BY id DESC LIMIT 1",
          )
          .get(parentID)
        if (receipt && invalidation === "malformed")
          db.query("UPDATE runner_transitions SET payload=? WHERE id=?").run("{broken", receipt.id)
        else if (receipt) {
          const payload = JSON.parse(receipt.payload) as Record<string, unknown>
          payload.artifact = f.base
          db.query("UPDATE runner_transitions SET payload=? WHERE id=?").run(
            JSON.stringify(payload),
            receipt.id,
          )
        }
      }
      if (invalidation === "foreign-prerequisite") {
        const body = JSON.parse(f.store.plan(child.planID)!.body) as Record<string, unknown>
        body.afterPlans = [crypto.randomUUID()]
        db.query("UPDATE runner_plans SET body=? WHERE id=?").run(
          JSON.stringify(body),
          child.planID,
        )
      }
      // A lifecycle label cannot stand in for a combined integration receipt.
      db.query("UPDATE runner_plans SET state='integrated' WHERE id=?").run(parentID)
    })
    const promptsBefore = f.events.filter((event) => event.startsWith("prompt:")).length
    await f.runtime.tick()
    expect(f.store.attempts(child.planID)).toHaveLength(0)
    expect(f.events.filter((event) => event.startsWith("prompt:")).length).toBe(promptsBefore)
  }
})

test("afterPlans requires the integrated change in selected HEAD; the recorded integration head is only an observation", async () => {
  for (const missingSource of ["integration-head", "artifact"] as const) {
    const f = fixture({
      independent: true,
      delayed: true,
      commit: true,
      taskFiles: [{ name: "a", path: "a.txt" }],
    })
    const parentID = f.receipt.planID
    const childTask = f.createTask("b", "b.txt")
    const child = f.store.submit(
      {
        ...f.inputFor([childTask], { requestID: `missing-${missingSource}` }),
        afterPlans: [parentID],
        priority: 10,
      },
      "owner",
    )
    await runPlan(f, child.planID, `run-missing-${missingSource}`)
    const accepted = await acceptPlan(f, parentID)
    includeArtifact(f, accepted.plan.artifact!)
    if (missingSource === "integration-head") {
      writeFileSync(join(f.root, "after-integration.txt"), "later baseline\n")
      git(f.root, ["add", "after-integration.txt"])
      git(f.root, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "later selected baseline",
      ])
    }
    await recordPlanIntegration(f, parentID)
    git(f.root, [
      "reset",
      "--hard",
      missingSource === "artifact" ? f.base : accepted.plan.artifact!,
    ])
    f.store.atomic((db) =>
      db.query("UPDATE runner_plans SET state='integrated' WHERE id=?").run(parentID),
    )

    await expect(f.runtime.tick()).resolves.toBeUndefined()
    if (missingSource === "artifact") {
      expect(f.store.attempts(child.planID)).toHaveLength(0)
      expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
    } else {
      // The change is contained in the selected HEAD (here by ancestry), so a recorded
      // landing SHA that is not itself in HEAD is history, not proof.
      expect(f.store.attempts(child.planID)).toHaveLength(1)
    }
  }
})

test("valid afterPlans integration does not bypass shared-checkout admission", async () => {
  const f = fixture({
    shared: true,
    independent: true,
    delayed: true,
    commit: true,
    startOnly: true,
    taskFiles: [
      { name: "a", path: "a.txt" },
      { name: "b", path: "b.txt" },
      { name: "c", path: "c.txt" },
    ],
  })
  const prerequisite = f.store.submit(
    f.inputFor([f.tasks[0]!], { requestID: "shared-parent" }),
    "owner",
  )
  const blocker = f.store.submit(
    f.inputFor([f.tasks[1]!], { requestID: "shared-blocker" }),
    "owner",
  )
  const dependent = f.store.submit(
    {
      ...f.inputFor([f.tasks[2]!], { requestID: "shared-dependent" }),
      afterPlans: [prerequisite.planID],
    },
    "owner",
  )
  await acceptAndIntegratePlan(f, prerequisite.planID)
  await runPlan(f, blocker.planID, "run-shared-blocker")
  await runPlan(f, dependent.planID, "run-shared-dependent")
  await f.runtime.tick()
  expect(f.store.attempts(blocker.planID)).toHaveLength(1)
  expect(f.store.attempts(dependent.planID)).toHaveLength(0)
})

test("cross-plan dependencies wait for integration and dispatch from the integrated source", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const b = f.createTask("b", "b.txt")
  const dependent = f.store.submit(
    {
      ...f.inputFor([b], { requestID: "dependent-b" }),
      afterPlans: [f.receipt.planID],
      priority: 10,
    },
    "owner",
  )
  await runPlan(f, dependent.planID, "dependency-run-b")
  await runPlan(f, f.receipt.planID, "dependency-run-a")
  await f.runtime.tick()
  expect(f.store.attempts(dependent.planID)).toHaveLength(0)
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  worker.busy = false
  worker.outcome = "succeeded"
  worker.turn = { inputID: attempt.message_id, state: "completed" }
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
  expect(f.store.attempts(dependent.planID)).toHaveLength(0)
  const accepted = f.store.plan(f.receipt.planID)!
  git(f.root, ["merge", "--ff-only", accepted.artifact!])
  await f.runtime.command(
    {
      requestID: "dependency-integrated",
      planID: accepted.id,
      action: "integrated",
      artifact: accepted.artifact!,
      targetBranch: "main",
      reason: "Reviewed the result and merged it",
    },
    "owner",
  )
  await drive(f.runtime)
  expect(f.store.plan(accepted.id)!.reason).toBeNull()
  expect(f.store.plan(accepted.id)!.state).toBe("integrated")
  const next = f.store.attempts(dependent.planID)[0]!
  expect(next.base_commit).toBe(accepted.artifact!)
  expect(readFileSync(join(next.workspace, "a.txt"), "utf8")).toBe("a")
})

test("schedule updates are versioned, retry-safe and reject dependency cycles or foreign plans", async () => {
  const f = fixture({ startOnly: true, independent: true })
  const a = f.store.submit(f.inputFor([f.tasks[0]!], { requestID: "schedule-a" }), "owner")
  const b = f.store.submit(
    { ...f.inputFor([f.tasks[1]!], { requestID: "schedule-b" }), afterPlans: [a.planID] },
    "owner",
  )
  const original = f.store.plan(a.planID)!
  await expect(
    f.runtime.command(
      {
        requestID: "schedule-cycle",
        planID: a.planID,
        action: "schedule",
        afterPlans: [b.planID],
        reason: "Invalid cycle",
      },
      "owner",
    ),
  ).rejects.toThrow("cycle")
  await expect(
    f.runtime.command(
      {
        requestID: "schedule-foreign",
        planID: a.planID,
        action: "schedule",
        afterPlans: [crypto.randomUUID()],
        reason: "Unknown project plan",
      },
      "owner",
    ),
  ).rejects.toThrow("foreign")
  expect(f.store.plan(a.planID)!.body).toBe(original.body)
  const command = {
    requestID: "schedule-valid",
    planID: b.planID,
    action: "schedule",
    priority: 5,
    afterPlans: [],
    baseCommit: f.base,
    reason: "Independent work can start immediately",
  }
  const first = await f.runtime.command(command, "owner")
  expect(await f.runtime.command(command, "owner")).toEqual(first)
  expect(f.store.plan(b.planID)!.revision).toBe(2)
  const history = f.store.atomic((db) =>
    db
      .query<{ body: string }, [string]>(
        "SELECT body FROM runner_plan_revisions WHERE plan_id=? ORDER BY revision",
      )
      .all(b.planID),
  )
  expect(history).toHaveLength(2)
  expect(JSON.parse(history[0]!.body).afterPlans).toEqual([a.planID])
  expect(JSON.parse(history[1]!.body)).toMatchObject({ priority: 5, afterPlans: [] })
})

test("a cancelled prerequisite drops its edge once, survives restart and leaves transitive dependents waiting on their own prerequisite", async () => {
  const f = fixture({ delayed: true, shared: true })
  const parentTask = f.createTask("parent")
  const parent = f.store.submit(f.inputFor([parentTask], { requestID: "cancel-root" }), "owner")
  await f.runtime.command(
    {
      requestID: "wait-root",
      action: "schedule",
      planID: f.receipt.planID,
      afterPlans: [parent.planID],
      reason: "Requires parent feature",
    },
    "owner",
  )
  const leafTask = f.createTask("leaf")
  const leaf = f.store.submit(
    { ...f.inputFor([leafTask], { requestID: "cancel-leaf" }), afterPlans: [f.receipt.planID] },
    "owner",
  )
  await runPlan(f)
  await runPlan(f, leaf.planID, "run-leaf")
  await f.runtime.command(
    {
      requestID: "cancel-parent",
      action: "cancel",
      planID: parent.planID,
      reason: "Feature intentionally cancelled",
    },
    "owner",
  )
  await drive(f.runtime, 3)
  // The cancelled edge is dropped from the dependent, which is not held.
  expect(JSON.parse(f.store.plan(f.receipt.planID)!.body).afterPlans).toEqual([])
  expect(f.store.plan(f.receipt.planID)).toMatchObject({ state: "running", reason: null })
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  // The transitive dependent still waits on its own, unfinished prerequisite.
  expect(JSON.parse(f.store.plan(leaf.planID)!.body).afterPlans).toEqual([f.receipt.planID])
  expect(f.store.plan(leaf.planID)!.state).toBe("running")
  expect(f.store.attempts(leaf.planID)).toHaveLength(0)
  const records = () =>
    f.store.atomic(
      (db) =>
        db
          .query<{ n: number }, [string]>(
            "SELECT count(*) AS n FROM runner_transitions WHERE plan_id=? AND event='DEPENDENCY_EDGE_DROPPED'",
          )
          .get(f.receipt.planID)!.n,
    )
  expect(records()).toBe(1)
  await f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project", undefined, {
    autoResumeInterrupted: false,
  })
  try {
    await drive(reopened, 3)
    expect(records()).toBe(1)
    expect(f.store.plan(parent.planID)!.state).toBe("cancelled")
    expect(f.store.attempts(leaf.planID)).toHaveLength(0)
  } finally {
    await reopened.stop()
  }
})

test("cancelled same-plan prerequisites no longer hold their descendants", async () => {
  const original = fixture({
    startOnly: true,
    delayed: true,
    independent: true,
    taskFiles: [
      { name: "a", path: "a.txt" },
      { name: "b", path: "b.txt" },
      { name: "c", path: "c.txt" },
    ],
  })
  const f = {
    ...original,
    receipt: original.store.submit(
      {
        ...original.input,
        dependencies: [{ prerequisite: original.tasks[0]!.id, successor: original.tasks[1]!.id }],
      },
      "owner",
    ),
  }
  await runPlan(f)
  f.store.move(f.receipt.planID, f.tasks[0]!.id, "CANCEL")
  await f.runtime.tick()
  expect(f.store.nodes(f.receipt.planID).map((node) => node.state)).toEqual([
    "cancelled",
    "running",
    "running",
  ])
  expect(f.store.plan(f.receipt.planID)!.state).toBe("running")
  expect(
    f.store
      .attempts(f.receipt.planID)
      .map((attempt) => attempt.task_id)
      .sort(),
  ).toEqual([f.tasks[1]!.id, f.tasks[2]!.id].sort())
})
