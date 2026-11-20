import { expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { git } from "./artifacts.ts"
import { RunnerStore } from "./store.ts"
import { PlanInput } from "./schema.ts"
import { settleVerification } from "../../test/runner/verification-driver.ts"
import {
  TaskRuntime,
  attemptCheck,
  cancelUnstartedPlan,
  cleanup,
  drive,
  driveWithTaskSourceLandings,
  expectNoSkillBody,
  failSecondSharedTask,
  fixture,
  integrateTaskSource,
  prepareAfterPlanDependency,
  runPlan,
  seedLegacySkillBody,
  skillBodyCanary,
  useRuntimeFixtureCleanup,
} from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

test("reconcile retries a conclusively unsent route-guard prompt on the same attempt", async () => {
  const f = fixture({ independent: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const original = f.host.prompt
  f.host.prompt = async () => {
    throw new Error("Worker prompt target is not the exact assigned session and route")
  }
  await f.runtime.command({ requestID: "run", planID: f.receipt.planID, action: "run" }, "owner")
  await drive(f.runtime, 2)
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(0)
  expect(
    f.store.effects(f.receipt.planID).find((effect) => effect.kind === "prompt"),
  ).toMatchObject({
    state: "failed",
    receipt: expect.stringContaining('"notSent":true'),
  })
  f.host.prompt = original
  await f.runtime.command(
    {
      requestID: "reconcile-route-guard",
      planID: f.receipt.planID,
      action: "reconcile",
    },
    "owner",
  )
  await drive(f.runtime, 8)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(f.store.attempts(f.receipt.planID)[0]).toMatchObject({
    id: attempt.id,
    session_id: attempt.session_id,
    workspace: attempt.workspace,
  })
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
})

test("lost host response reconciles a real accepted prompt without creating another worker", async () => {
  const f = fixture()
  const original = f.host.prompt
  f.host.prompt = async (input) => {
    await original(input)
    throw new Error("response lost")
  }
  await f.runtime.command({ requestID: "run", planID: f.receipt.planID, action: "run" }, "owner")
  await drive(f.runtime, 2)
  expect(f.store.effects(f.receipt.planID).find((e) => e.kind === "prompt")?.state).toBe(
    "completed",
  )
  expect(f.events.filter((e) => e.startsWith("prompt:"))).toHaveLength(1)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
})

test("lost prompt response after a committed worker turn reconciles through verification", async () => {
  const f = fixture({
    independent: true,
    delayed: false,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const { child } = await prepareAfterPlanDependency(f, "lost-committed-child-prompt")
  const original = f.host.prompt
  f.host.prompt = async (input) => {
    await original(input)
    throw new Error("committed prompt response lost")
  }

  await f.runtime.tick()
  const attempt = f.store.attempts(child.planID)[0]!
  const originalPrompt = attempt.message_id
  expect(f.store.plan(child.planID)?.state).toBe("blocked")
  expect(attempt.state).toBe("preparing")
  expect(git(attempt.workspace, ["rev-parse", "HEAD"])).not.toBe(attempt.base_commit)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(2)

  await f.runtime.tick()
  expect(f.store.effects(child.planID).find((effect) => effect.kind === "prompt")?.state).toBe(
    "completed",
  )
  await f.runtime.command(
    {
      requestID: "reconcile-lost-committed-child-prompt",
      planID: child.planID,
      action: "reconcile",
    },
    "owner",
  )
  await drive(f.runtime, 8)

  expect(f.store.plan(child.planID)?.state).toBe("accepted")
  expect(f.store.attempts(child.planID)).toHaveLength(1)
  expect(f.store.attempts(child.planID)[0]).toMatchObject({ id: attempt.id, state: "accepted" })
  expect(git(attempt.workspace, ["rev-parse", "HEAD"])).not.toBe(attempt.base_commit)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(2)
  expect(f.events.filter((event) => event === `prompt:${originalPrompt}`)).toHaveLength(1)
})

test("schema rejects cycles, foreign dependency IDs and duplicate nodes before persistence", () => {
  const f = fixture()
  expect(
    PlanInput.safeParse({
      ...f.input,
      dependencies: [{ prerequisite: f.tasks[1]!.id, successor: f.tasks[0]!.id }],
    }).success,
  ).toBe(false)
  expect(
    PlanInput.safeParse({ ...f.input, nodes: [f.input.nodes[0], f.input.nodes[0]] }).success,
  ).toBe(false)
  expect(
    PlanInput.safeParse({
      ...f.input,
      dependencies: [{ prerequisite: crypto.randomUUID(), successor: f.tasks[0]!.id }],
    }).success,
  ).toBe(false)
  expect(() =>
    f.runtime.store.submit(
      {
        ...f.input,
        requestID: "foreign",
        nodes: [{ taskID: crypto.randomUUID(), revision: 1 }],
        integrationOrder: [crypto.randomUUID()],
      },
      "owner",
    ),
  ).toThrow()
})

test("plan admission resolves partial task and combined overrides against project defaults", () => {
  const f = fixture({
    verificationTimeoutDefaults: { inactivityTimeoutMs: 600, hardTimeoutMs: 700 },
  })
  const contradictory = {
    ...f.input,
    requestID: "invalid-explicit-combined-timing",
    verification: [
      {
        id: "combined",
        command: "true",
        inactivityTimeoutMs: 800,
        hardTimeoutMs: 700,
      },
    ],
  }
  expect(PlanInput.safeParse(contradictory).success).toBe(true)
  expect(() => f.runtime.submitPlan(contradictory, "owner")).toThrow(
    "Combined verification check combined inactivity allowance exceeds the configured hard backstop",
  )
  const invalid = {
    ...f.input,
    requestID: "invalid-configured-combined-timing",
    verification: [
      {
        id: "combined",
        command: "true",
        inactivityTimeoutMs: 800,
      },
    ],
  }
  expect(PlanInput.safeParse(invalid).success).toBe(true)
  expect(() => f.runtime.submitPlan(invalid, "owner")).toThrow(
    "Combined verification check combined inactivity allowance exceeds the configured hard backstop",
  )
  const task = f.tasks[0]!
  const taskProposal = structuredClone(task.proposal)
  taskProposal.verification = [{ id: "content", command: "true", inactivityTimeoutMs: 800 }]
  const taskID = crypto.randomUUID()
  const taskPlanTask = f.repository.insert({
    ...task,
    id: taskID,
    proposal: taskProposal,
    provenance: { ...task.provenance, startingRevision: { kind: "git", commit: f.base } },
  })
  const invalidTaskTiming = {
    ...f.input,
    requestID: "invalid-configured-task-timing",
    nodes: [{ taskID: taskPlanTask.id, revision: 1 as const }],
    dependencies: [],
    integrationOrder: [taskPlanTask.id],
  }
  expect(() => f.runtime.submitPlan(invalidTaskTiming, "owner")).toThrow(
    "Task verification check content inactivity allowance exceeds the configured hard backstop",
  )
})

test("historical guessed token caps do not stop useful work and stopped attempts resume without resetting usage", async () => {
  const f = fixture()
  await f.runtime.command({ requestID: "run", planID: f.receipt.planID, action: "run" }, "owner")
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  const historicalPolicy = seedLegacySkillBody(f, attempt)
  const worker = f.sessions.get(attempt.session_id)!
  worker.tokens = 65941
  worker.outcome = "interrupted"
  f.store.move(f.receipt.planID, attempt.task_id, "EXHAUST", "Historical guessed token cap")
  f.store.atomic((db) => {
    db.query("UPDATE runner_attempts SET state='exhausted',token_count=65941 WHERE id=?").run(
      attempt.id,
    )
    db.query("UPDATE runner_plans SET state='blocked' WHERE id=?").run(f.receipt.planID)
  })
  const command = {
    requestID: "resume-existing",
    planID: f.receipt.planID,
    action: "resume",
    taskID: attempt.task_id,
    reason: "No model-derived budget is configured",
  }
  const receipt = await f.runtime.command(command, "owner")
  expect(await f.runtime.command(command, "owner")).toEqual(receipt)
  expect(f.store.attempts(f.receipt.planID)[0]!.token_count).toBe(65941)
  await driveWithTaskSourceLandings(f)
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID)[0]!.policy).toBe(historicalPolicy)
  const sameTask = f.store.attempts(f.receipt.planID).filter((a) => a.task_id === attempt.task_id)
  expect(sameTask).toHaveLength(1)
  expect(sameTask[0]!.session_id).toBe(attempt.session_id)
  expect(sameTask[0]!.token_count).toBe(65941)
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(2)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(3)
})

test("runtime retains the actual directory returned by the host worktree strategy", async () => {
  const f = fixture()
  const create = f.host.worktree
  f.host.worktree = async ({ directory, base }) => create({ directory: directory + "-2", base })
  await f.runtime.command({ requestID: "run", planID: f.receipt.planID, action: "run" }, "owner")
  await driveWithTaskSourceLandings(f)
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
  expect(
    f.store.attempts(f.receipt.planID).every((attempt) => attempt.workspace.endsWith("-2")),
  ).toBe(true)
  expect(f.store.effects(f.receipt.planID).some((effect) => effect.kind === "graph-worktree")).toBe(
    false,
  )
})

test("an explicitly cancelled worker can continue through its owner without replacing its worktree", async () => {
  const f = fixture()
  await f.runtime.command({ requestID: "run", planID: f.receipt.planID, action: "run" }, "owner")
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  await f.runtime.command(
    {
      requestID: "cancel",
      planID: f.receipt.planID,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)!.state).toBe("cancelled")
  await f.runtime.command(
    {
      requestID: "continue",
      planID: f.receipt.planID,
      action: "resume",
      taskID: attempt.task_id,
      reason: "Host location corrected",
    },
    "owner",
  )
  // Cancellation also stopped the queued successor; verify this task's continuation independently.
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)[0]!.workspace).toBe(attempt.workspace)
  expect(f.store.attempts(f.receipt.planID)[0]!.state).toBe("running")
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)
})

test.each(["dirty", "committed", "repeated"] as const)(
  "a same-plan dependent resumes authorized %s progress through its new input",
  async (progress) => {
    const f = fixture({ delayed: true })
    await runPlan(f)
    await f.runtime.tick()
    const first = f.store.attempts(f.receipt.planID)[0]!
    git(first.workspace, ["add", "a.txt"])
    git(first.workspace, [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Retain prerequisite implementation",
    ])
    f.completeWorker(first.session_id)
    await driveWithTaskSourceLandings(f, 8)
    const dependent = f.store.attempts(f.receipt.planID)[1]!
    expect(dependent.state).toBe("running")
    expect(
      f.store.latestTransition(f.receipt.planID, first.task_id, "TASK_INTEGRATION_RECORDED"),
    ).toBeDefined()
    if (progress === "committed") {
      git(dependent.workspace, ["add", "b.txt"])
      git(dependent.workspace, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "Retain dependent implementation",
      ])
    }
    const previousHead = git(dependent.workspace, ["rev-parse", "HEAD"])
    const previousPrompt = dependent.message_id
    const promptsBefore = f.events.filter((event) => event.startsWith("prompt:")).length
    await f.runtime.command(
      {
        requestID: `stop-dependent-${progress}`,
        planID: f.receipt.planID,
        action: "cancel",
      },
      "owner",
    )
    await drive(f.runtime, 2)
    expect(f.store.plan(f.receipt.planID)!.state).toBe("cancelled")
    await f.runtime.command(
      {
        requestID: `resume-dependent-${progress}`,
        planID: f.receipt.planID,
        action: "resume",
        taskID: dependent.task_id,
        attemptID: dependent.id,
        reason: "Continue this exact dependent after its prerequisite source landed",
      },
      "owner",
    )
    if (progress === "repeated") {
      expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(promptsBefore)
      await f.runtime.command(
        {
          requestID: "stop-repeated-before-prompt",
          planID: f.receipt.planID,
          action: "cancel",
        },
        "owner",
      )
      await drive(f.runtime, 2)
      await f.runtime.command(
        {
          requestID: "resume-repeated-after-second-stop",
          planID: f.receipt.planID,
          action: "resume",
          taskID: dependent.task_id,
          attemptID: dependent.id,
          reason: "Continue from the admitted prompt before both stops",
        },
        "owner",
      )
    }
    await drive(f.runtime, 4)
    const resumed = f.store.attempts(f.receipt.planID)[1]!
    expect(resumed).toMatchObject({
      id: dependent.id,
      session_id: dependent.session_id,
      workspace: dependent.workspace,
      base_commit: dependent.base_commit,
      state: "running",
    })
    expect(resumed.message_id).not.toBe(previousPrompt)
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(promptsBefore + 1)
    expect(git(resumed.workspace, ["rev-parse", "HEAD"])).toBe(previousHead)
    expect(readFileSync(join(resumed.workspace, "b.txt"), "utf8")).toBe("b")
  },
)

test("a cancelled afterPlans child resumes its retained committed attempt", async () => {
  const f = fixture({
    independent: true,
    delayed: true,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const { child } = await prepareAfterPlanDependency(f, "resume-committed-child")
  await f.runtime.tick()
  const attempt = f.store.attempts(child.planID)[0]!
  const originalPromptID = attempt.message_id
  const originalHead = git(attempt.workspace, ["rev-parse", "HEAD"])
  expect(originalHead).not.toBe(attempt.base_commit)
  expect(f.store.attempts(child.planID)).toHaveLength(1)

  await f.runtime.command(
    {
      requestID: "cancel-committed-child",
      planID: child.planID,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  await f.runtime.tick()
  expect(f.store.plan(child.planID)?.state).toBe("cancelled")
  expect(f.store.attempts(child.planID)[0]).toMatchObject({ id: attempt.id, state: "cancelled" })

  await f.runtime.command(
    {
      requestID: "resume-committed-child-attempt",
      planID: child.planID,
      action: "resume",
      taskID: attempt.task_id,
      reason: "Continue the committed work in its retained workspace",
    },
    "owner",
  )
  await f.runtime.tick()
  const resumed = f.store.attempts(child.planID)[0]!
  expect(resumed).toMatchObject({
    id: attempt.id,
    session_id: attempt.session_id,
    state: "running",
    base_commit: attempt.base_commit,
  })
  expect(git(resumed.workspace, ["rev-parse", "HEAD"])).toBe(originalHead)
  expect(git(resumed.workspace, ["rev-parse", "HEAD"])).not.toBe(resumed.base_commit)
  const promptIDs = f.events
    .filter((event) => event.startsWith("prompt:"))
    .map((event) => event.slice(7))
  expect(promptIDs).toHaveLength(3)
  expect(promptIDs.filter((id) => id === originalPromptID)).toHaveLength(1)
  expect(resumed.message_id).not.toBe(originalPromptID)

  f.completeWorker(resumed.session_id)
  await drive(f.runtime, 8)
  expect(f.store.plan(child.planID)?.state).toBe("accepted")
  expect(f.store.attempts(child.planID)).toHaveLength(1)
  expect(f.store.attempts(child.planID)[0]?.state).toBe("accepted")
  expect(
    f.events.filter((event) => event.startsWith("prompt:")).map((event) => event.slice(7)),
  ).toEqual(promptIDs)
})

test("retry requeues a cancelled unstarted successor in the admitted graph and waits for dependencies and scope", async () => {
  const f = fixture({ delayed: true })
  const planID = f.receipt.planID
  const predecessorID = f.tasks[0]!.id
  const successorID = f.tasks[1]!.id
  const originalGraph = {
    body: f.store.plan(planID)!.body,
    nodes: f.store.nodes(planID).map((node) => node.task_id),
    dependencies: f.store.atomic((db) =>
      db
        .query<{ prerequisite: string; successor: string }, [string]>(
          "SELECT prerequisite,successor FROM runner_dependencies WHERE plan_id=? ORDER BY rowid",
        )
        .all(planID),
    ),
  }
  await runPlan(f)
  await f.runtime.tick()
  const original = f.store.attempts(planID)[0]!
  expect(original.task_id).toBe(predecessorID)
  expect(f.store.attempts(planID)).toHaveLength(1)

  await f.runtime.command(
    {
      requestID: "cancel-running-graph",
      planID,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  await f.runtime.tick()
  expect(f.store.plan(planID)!.state).toBe("cancelled")
  expect(f.store.nodes(planID).map((node) => node.state)).toEqual(["cancelled", "cancelled"])

  await f.runtime.command(
    {
      requestID: "resume-original-predecessor",
      planID,
      action: "resume",
      taskID: predecessorID,
      reason: "Continue the admitted prerequisite",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(planID)!.state).toBe("running")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]).toMatchObject({
    id: original.id,
    session_id: original.session_id,
    number: original.number,
    state: "running",
  })

  const requeue = {
    requestID: "requeue-unstarted-successor",
    planID,
    action: "retry" as const,
    taskID: successorID,
    reason: "Restore the original dependent task",
  }
  const receipt = await f.runtime.command(requeue, "owner")
  expect(receipt).toMatchObject({ status: "requeued" })
  expect(f.store.plan(planID)!.state).toBe("running")
  expect(f.store.plan(planID)!.body).toBe(originalGraph.body)
  expect(f.store.nodes(planID).map((node) => node.task_id)).toEqual(originalGraph.nodes)
  expect(
    f.store.atomic((db) =>
      db
        .query<{ prerequisite: string; successor: string }, [string]>(
          "SELECT prerequisite,successor FROM runner_dependencies WHERE plan_id=? ORDER BY rowid",
        )
        .all(planID),
    ),
  ).toEqual(originalGraph.dependencies)
  expect(f.store.nodes(planID).find((node) => node.task_id === successorID)?.state).toBe("ready")
  expect(f.store.execution(successorID)?.waitingOn).toEqual([predecessorID])
  expect(
    f.store.attempts(planID).filter((attempt) => attempt.task_id === successorID),
  ).toHaveLength(0)

  const requeuedHistory = f.store.activity(planID, successorID).length
  const reopenedRepository = new TaskRepository(f.repository.path, f.repository.projectDirectory)
  const reopenedStore = new RunnerStore(reopenedRepository)
  const reopened = new TaskRuntime(reopenedStore, f.host, "project", undefined, {
    autoResumeInterrupted: false,
  })
  try {
    expect(await reopened.command(requeue, "owner")).toEqual(receipt)
    await expect(
      reopened.command({ ...requeue, reason: "Different recovery intent" }, "owner"),
    ).rejects.toThrow("identity conflict")
    await expect(reopened.command(requeue, "not-the-owner")).rejects.toThrow("identity conflict")
    expect(reopenedStore.activity(planID, successorID)).toHaveLength(requeuedHistory)
  } finally {
    await reopened.stop()
    reopenedRepository.close()
  }
  expect(f.store.activity(planID, successorID)).toHaveLength(requeuedHistory)

  const scopeBlocker = f.createTask("c", "c.txt", ["b.txt", "c.txt"])
  const blockerPlan = f.store.submit(
    f.inputFor([scopeBlocker], { requestID: "scope-blocker-plan" }),
    "owner",
  )
  await f.runtime.command(
    {
      requestID: "run-scope-blocker",
      planID: blockerPlan.planID,
      action: "run",
    },
    "owner",
  )
  await f.runtime.tick()
  const blockerAttempt = f.store.attempts(blockerPlan.planID)[0]!
  expect(f.sessions.get(blockerAttempt.session_id)?.busy).toBe(true)

  f.completeWorker(original.session_id)
  await settleVerification(f.runtime)
  expect(f.store.nodes(planID).find((node) => node.task_id === predecessorID)?.state).toBe(
    "accepted",
  )
  expect(f.store.execution(successorID)?.waitingOn).toEqual([predecessorID])
  expect(
    f.store.attempts(planID).filter((attempt) => attempt.task_id === successorID),
  ).toHaveLength(0)
  await integrateTaskSource(f, planID, predecessorID)
  expect(f.store.execution(successorID)?.waitingOn).toEqual([])

  f.completeWorker(blockerAttempt.session_id)
  await settleVerification(f.runtime)
  expect(f.store.plan(blockerPlan.planID)?.state).toBe("accepted")
  // Completion may already have dispatched the now-unblocked successor.

  await f.runtime.tick()
  const successorAttempts = f.store
    .attempts(planID)
    .filter((attempt) => attempt.task_id === successorID)
  expect(successorAttempts).toHaveLength(1)
  expect(successorAttempts[0]).toMatchObject({ number: 1, state: "running" })
  expect(successorAttempts[0]!.base_commit).toBe(f.store.attempts(planID)[0]!.artifact!)
  expect(
    f.store.attempts(planID).filter((attempt) => attempt.task_id === predecessorID),
  ).toHaveLength(1)
  expect(f.store.activity(planID, predecessorID).map((entry) => entry.event)).toContain("RESUME")
  expect(f.store.activity(planID, predecessorID).map((entry) => entry.event)).toContain("CANCEL")

  f.completeWorker(successorAttempts[0]!.session_id)
  await drive(f.runtime)
  expect(f.store.plan(planID)?.state).toBe("accepted")
})

test("requeued unstarted work can be cancelled again before normal dispatch", async () => {
  const f = fixture()
  const planID = f.receipt.planID
  const cancelled = await cancelUnstartedPlan(f)
  expect(cancelled.state).toBe("cancelled")
  const taskID = f.tasks[1]!.id
  const requeue = {
    requestID: "requeue-then-cancel",
    planID,
    action: "retry" as const,
    taskID,
    reason: "Restore, then stop before dispatch",
  }
  const receipt = await f.runtime.command(requeue, "owner")
  expect(receipt).toMatchObject({ status: "requeued" })
  expect(f.store.attempts(planID)).toHaveLength(0)
  await f.runtime.command(
    {
      requestID: "cancel-requeued-before-dispatch",
      planID,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(planID)!.state).toBe("cancelled")
  expect(f.store.nodes(planID).find((node) => node.task_id === taskID)?.state).toBe("cancelled")
  expect(f.store.attempts(planID)).toHaveLength(0)
  expect(f.events.some((event) => event.startsWith("create:") || event.startsWith("prompt:"))).toBe(
    false,
  )
})

test("unstarted retry selects an explicit newer baseline without replacing tasks or attempts", async () => {
  const f = fixture({ delayed: true })
  const planID = f.receipt.planID
  const stopped = await cancelUnstartedPlan(f)
  const original = JSON.parse(stopped.body)
  const tasksBefore = f.tasks.map((task) => f.repository.get(task.id))
  writeFileSync(join(f.root, "new-baseline.txt"), "new current source\n")
  git(f.root, ["add", "new-baseline.txt"])
  git(f.root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "new baseline",
  ])
  const baseCommit = git(f.root, ["rev-parse", "HEAD"])
  const input = {
    requestID: "refresh-unstarted-baseline",
    planID,
    action: "retry" as const,
    taskID: f.tasks[0]!.id,
    baseCommit,
    reason: "Continue the existing work on reviewed current source",
  }
  const receipt = await f.runtime.command(input, "owner")
  expect(receipt).toMatchObject({ status: "requeued" })
  expect(JSON.parse(f.store.plan(planID)!.body)).toEqual({ ...original, baseCommit })
  expect(f.store.plan(planID)!.revision).toBe(stopped.revision + 1)
  expect(f.tasks.map((task) => f.repository.get(task.id))).toEqual(tasksBefore)
  expect(f.store.attempts(planID)).toHaveLength(0)
  const version = f.store.plan(planID)!.version
  expect(await f.runtime.command(input, "owner")).toEqual(receipt)
  expect(f.store.plan(planID)!.version).toBe(version)
  await f.runtime.tick()
  expect(f.store.attempts(planID)[0]!.base_commit).toBe(baseCommit)
})

test("unstarted baseline selection rejects missing, unrelated and unlanded commits atomically", async () => {
  const f = fixture()
  const stopped = await cancelUnstartedPlan(f)
  const commitTree = (parents: string[]) =>
    git(f.root, [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit-tree",
      `${f.base}^{tree}`,
      ...parents,
      "-m",
      "unlanded source",
    ])
  const before = f.store.plan(stopped.id)
  const history = f.store.activity(stopped.id, f.tasks[0]!.id)
  for (const baseCommit of ["f".repeat(40), commitTree([]), commitTree(["-p", f.base])]) {
    await expect(
      f.runtime.command(
        {
          requestID: `invalid-baseline-${baseCommit}`,
          planID: stopped.id,
          action: "retry",
          taskID: f.tasks[0]!.id,
          baseCommit,
          reason: "Refresh unstarted source",
        },
        "owner",
      ),
    ).rejects.toThrow()
    expect(f.store.plan(stopped.id)).toEqual(before)
    expect(f.store.activity(stopped.id, f.tasks[0]!.id)).toEqual(history)
    expect(f.store.attempts(stopped.id)).toHaveLength(0)
  }
})

test("unstarted baseline selection cannot rewrite a plan with a prior worker", async () => {
  const f = fixture({ delayed: true })
  await runPlan(f)
  await f.runtime.tick()
  await f.runtime.command(
    {
      requestID: "cancel-prior-worker-baseline",
      planID: f.receipt.planID,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  await f.runtime.tick()
  const before = f.store.plan(f.receipt.planID)!
  const attempts = f.store.attempts(before.id)
  expect(attempts).toHaveLength(1)
  expect(before.state).toBe("cancelled")
  expect(before.artifact).toBeNull()
  await expect(
    f.runtime.command(
      {
        requestID: "reject-rewriting-prior-worker-baseline",
        planID: before.id,
        action: "retry",
        taskID: f.tasks[1]!.id,
        baseCommit: "f".repeat(40),
        reason: "Do not rewrite execution history",
      },
      "owner",
    ),
  ).rejects.toThrow("prior attempts")
  expect(f.store.plan(before.id)).toEqual(before)
  expect(f.store.attempts(before.id)).toEqual(attempts)
})

test("unstarted recovery rejects unauthorized, missing, archived and foreign owners without writes", async () => {
  for (const denial of ["unauthorized", "missing", "archived", "foreign"] as const) {
    const f = fixture()
    const stopped = await cancelUnstartedPlan(f)
    const planID = stopped.id
    const taskID = f.tasks[1]!.id
    const beforePlan = f.store.plan(planID)!
    const beforeNode = f.store.nodes(planID).find((node) => node.task_id === taskID)!
    const beforeHistory = f.store.activity(planID, taskID)
    const recovery = {
      requestID: `denied-recovery-${denial}`,
      planID,
      action: "retry" as const,
      taskID,
      reason: "Attempt a denied recovery",
    }
    if (denial === "missing") f.sessions.delete("owner")
    if (denial === "archived") f.sessions.get("owner")!.archived = true
    if (denial === "foreign") f.sessions.get("owner")!.projectID = "another-project"

    await expect(
      f.runtime.command(recovery, denial === "unauthorized" ? "not-the-owner" : "owner"),
    ).rejects.toThrow("A live Architect session of this project must command the plan")
    expect(f.store.plan(planID)).toEqual(beforePlan)
    expect(f.store.nodes(planID).find((node) => node.task_id === taskID)).toEqual(beforeNode)
    expect(f.store.activity(planID, taskID)).toEqual(beforeHistory)
    expect(f.store.attempts(planID)).toHaveLength(0)
    expect(
      f.store.atomic(
        (db) =>
          db
            .query<{ count: number }, [string, string]>(
              "SELECT count(*) AS count FROM runner_commands WHERE project_directory=? AND request_id=?",
            )
            .get(f.store.repository.projectDirectory, recovery.requestID)!.count,
      ),
    ).toBe(0)
    expect(
      f.events.some((event) => event.startsWith("create:") || event.startsWith("prompt:")),
    ).toBe(false)
  }
})

test("unstarted recovery re-reads the plan after owner lookup races with reassignment", async () => {
  const f = fixture()
  const stopped = await cancelUnstartedPlan(f)
  const planID = stopped.id
  const taskID = f.tasks[1]!.id
  f.sessions.set("new-owner", { ...f.sessions.get("owner")!, id: "new-owner" })
  const recovery = {
    requestID: "racing-unstarted-recovery",
    planID,
    action: "retry" as const,
    taskID,
    reason: "Recover only if ownership remains current",
  }
  const beforeHistory = f.store.activity(planID, taskID)
  const originalSession = f.host.session
  let announceLookup!: () => void
  let releaseLookup!: () => void
  let gated = false
  const lookupStarted = new Promise<void>((resolve) => (announceLookup = resolve))
  const lookupGate = new Promise<void>((resolve) => (releaseLookup = resolve))
  f.host.session = async (id, options) => {
    if (id === "owner" && !gated) {
      gated = true
      announceLookup()
      await lookupGate
    }
    return originalSession(id, options)
  }

  const pendingRecovery = f.runtime.command(recovery, "owner")
  await lookupStarted
  await f.runtime.command(
    {
      requestID: "reassign-during-unstarted-recovery",
      planID,
      action: "reassign",
      targetSessionID: "new-owner",
      reason: "Explicitly change the plan owner",
    },
    "new-owner",
  )
  releaseLookup()
  // The reassignment moved the plan between the runtime's read and its transaction. Any live
  // Architect may command the plan, so the command is re-read and applied once.
  await expect(pendingRecovery).resolves.toMatchObject({ status: "requeued" })

  expect(f.store.plan(planID)).toMatchObject({ owner: "owner", state: "running" })
  expect(f.store.nodes(planID).find((node) => node.task_id === taskID)?.state).not.toBe("cancelled")
  expect(f.store.activity(planID, taskID).length).toBeGreaterThan(beforeHistory.length)
  expect(
    f.store.atomic(
      (db) =>
        db
          .query<{ count: number }, [string, string]>(
            "SELECT count(*) AS count FROM runner_commands WHERE project_directory=? AND request_id=?",
          )
          .get(f.store.repository.projectDirectory, recovery.requestID)!.count,
    ),
  ).toBe(1)
})

test("unstarted recovery rejects invalid node/plan states and unreconciled effects", async () => {
  const queued = fixture()
  await runPlan(queued)
  const queuedPlan = queued.store.plan(queued.receipt.planID)!
  const queuedTask = queued.tasks[1]!.id
  await expect(
    queued.runtime.command(
      {
        requestID: "retry-still-queued-node",
        planID: queuedPlan.id,
        action: "retry",
        taskID: queuedTask,
        reason: "Do not recover a non-cancelled node",
      },
      "owner",
    ),
  ).rejects.toThrow("Only an exhausted or cancelled, stopped attempt can resume")
  expect(queued.store.nodes(queuedPlan.id).find((node) => node.task_id === queuedTask)?.state).toBe(
    "queued",
  )
  expect(queued.store.attempts(queuedPlan.id)).toHaveLength(0)

  const integrated = fixture()
  const integratedPlan = await cancelUnstartedPlan(integrated)
  integrated.store.atomic((db) =>
    db.query("UPDATE runner_plans SET state='integrated' WHERE id=?").run(integratedPlan.id),
  )
  const integratedNode = integrated.store
    .nodes(integratedPlan.id)
    .find((node) => node.task_id === integrated.tasks[1]!.id)!
  const integratedHistory = integrated.store.activity(integratedPlan.id, integratedNode.task_id)
  await expect(
    integrated.runtime.command(
      {
        requestID: "retry-integrated-plan",
        planID: integratedPlan.id,
        action: "retry",
        taskID: integratedNode.task_id,
        reason: "Do not revive an integrated plan",
      },
      "owner",
    ),
  ).rejects.toThrow("Plan is integrated; retry is not available. Available: none.")
  expect(
    integrated.store
      .nodes(integratedPlan.id)
      .find((node) => node.task_id === integratedNode.task_id),
  ).toEqual(integratedNode)
  expect(integrated.store.activity(integratedPlan.id, integratedNode.task_id)).toEqual(
    integratedHistory,
  )
  expect(integrated.store.attempts(integratedPlan.id)).toHaveLength(0)

  const unresolved = fixture()
  const unresolvedPlan = await cancelUnstartedPlan(unresolved)
  const unresolvedTask = unresolved.tasks[1]!.id
  unresolved.store.atomic((db) =>
    db
      .query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'intended',?,NULL,0)")
      .run(
        crypto.randomUUID(),
        unresolvedPlan.id,
        unresolvedTask,
        null,
        "recovery-test-effect",
        "{}",
      ),
  )
  const unresolvedNode = unresolved.store
    .nodes(unresolvedPlan.id)
    .find((node) => node.task_id === unresolvedTask)!
  const unresolvedHistory = unresolved.store.activity(unresolvedPlan.id, unresolvedTask)
  await expect(
    unresolved.runtime.command(
      {
        requestID: "retry-with-unresolved-effect",
        planID: unresolvedPlan.id,
        action: "retry",
        taskID: unresolvedTask,
        reason: "Reconcile the outstanding effect first",
      },
      "owner",
    ),
  ).rejects.toThrow("Reconcile uncertain effects first")
  expect(
    unresolved.store.nodes(unresolvedPlan.id).find((node) => node.task_id === unresolvedTask),
  ).toEqual(unresolvedNode)
  expect(unresolved.store.activity(unresolvedPlan.id, unresolvedTask)).toEqual(unresolvedHistory)
  expect(unresolved.store.attempts(unresolvedPlan.id)).toHaveLength(0)
  expect(
    unresolved.store.effects(unresolvedPlan.id).some((effect) => effect.state === "intended"),
  ).toBe(true)
})

test("serial shared children commit in the current checkout without creating worktrees", async () => {
  const f = fixture({ shared: true })
  f.host.worktree = async () => {
    throw new Error("Serial tasks must not allocate worktrees")
  }
  await f.runtime.command({ requestID: "run", planID: f.receipt.planID, action: "run" }, "owner")
  await driveWithTaskSourceLandings(f)
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID).every((attempt) => attempt.workspace === f.root)).toBe(
    true,
  )
  expect(f.store.effects(f.receipt.planID).some((effect) => effect.kind.includes("worktree"))).toBe(
    false,
  )
  expect(git(f.root, ["show", "HEAD:a.txt"])).toBe("a")
  expect(git(f.root, ["show", "HEAD:b.txt"])).toBe("b")
})

test("explicit retry starts a fresh native child and retains the old attempt and usage", async () => {
  const f = fixture({ shared: true })
  await f.runtime.command({ requestID: "run", planID: f.receipt.planID, action: "run" }, "owner")
  await f.runtime.tick()
  const old = f.store.attempts(f.receipt.planID)[0]!
  seedLegacySkillBody(f, old)
  f.store.atomic((db) =>
    db.query("UPDATE runner_attempts SET token_count=65941 WHERE id=?").run(old.id),
  )
  await f.runtime.command(
    {
      requestID: "cancel",
      planID: f.receipt.planID,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  const command = {
    requestID: "fresh-retry",
    planID: f.receipt.planID,
    action: "retry",
    taskID: old.task_id,
    reason: "Use concise task fetch in a fresh child",
    workspaceMode: "shared",
    baseCommit: f.base,
  }
  const receipt = await f.runtime.command(command, "owner")
  expect(await f.runtime.command(command, "owner")).toEqual(receipt)
  await f.runtime.tick()
  const attempts = f.store.attempts(f.receipt.planID)
  expect(attempts).toHaveLength(2)
  expect(attempts[0]!.token_count).toBe(65941)
  expect(attempts[0]!.state).toBe("cancelled")
  expect(attempts[0]!.policy).toContain(skillBodyCanary)
  expectNoSkillBody(attempts[1]!.policy)
  expect(attempts[1]!.session_id).not.toBe(old.session_id)
  expect(attempts[1]!.workspace).toBe(f.root)
})

test("a shared node's first attempt starts at reviewed HEAD, not an older accepted predecessor", async () => {
  const f = fixture({ shared: true })
  let reviewedHead = ""
  const move = f.store.move.bind(f.store)
  f.store.move = (planID, taskID, event, reason) => {
    const result = move(planID, taskID, event, reason)
    if (taskID === f.tasks[0]!.id && event === "ACCEPT") {
      writeFileSync(join(f.root, "reviewer-fix.txt"), "approved\n")
      git(f.root, ["add", "reviewer-fix.txt"])
      git(f.root, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "Reviewed repair between shared nodes",
      ])
      reviewedHead = git(f.root, ["rev-parse", "HEAD"])
    }
    return result
  }
  await f.runtime.command({ requestID: "run", planID: f.receipt.planID, action: "run" }, "owner")
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  const predecessor = f.store.attempts(f.receipt.planID)[0]!
  f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project", undefined, {
    autoResumeInterrupted: false,
  })
  cleanup.push(() => reopened.stop())
  await driveWithTaskSourceLandings(f, 16, f.receipt.planID, reopened)
  const predecessorArtifact = f.store.attempts(f.receipt.planID)[0]!.artifact
  expect(reviewedHead).not.toBe("")
  expect(reviewedHead).not.toBe(predecessorArtifact)
  const next = f.store
    .attempts(f.receipt.planID)
    .find((attempt) => attempt.task_id === f.tasks[1]!.id)!
  expect(next.base_commit).toBe(reviewedHead)
  expect(JSON.parse(next.policy).source).toBe(reviewedHead)
  expect(next.state).toBe("accepted")
  expect(git(f.root, ["diff", "--name-only", `${next.base_commit}..${next.artifact}`])).toBe(
    "b.txt",
  )
  expect(git(f.root, ["show", `${next.artifact}:reviewer-fix.txt`])).toBe("approved")
  expect(f.store.attempts(f.receipt.planID)[0]).toMatchObject({
    id: predecessor.id,
    artifact: predecessorArtifact,
    base_commit: f.base,
    state: "accepted",
  })
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
})

test("an explicit corrected shared baseline wins across reopen and excludes reviewed scope changes", async () => {
  let wakes = 0
  const f = fixture({ shared: true, wrongFirstB: true, wakeScheduler: () => wakes++ })
  const { predecessor, failed } = await failSecondSharedTask(f)
  const predecessorArtifact = predecessor.artifact
  const failedArtifact = failed.artifact
  if (!predecessorArtifact || !failedArtifact) throw new Error("Expected Git artifacts")
  expect(failed.token_count).toBe(65941)
  expect(failed.tool_count).toBe(17)
  expect(failed.cost).toBe(1.25)

  writeFileSync(join(f.root, "reviewer-fix.txt"), "approved\n")
  git(f.root, ["add", "reviewer-fix.txt"])
  git(f.root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Reviewer correction",
  ])
  const correctedBaseline = git(f.root, ["rev-parse", "HEAD"])
  expect(correctedBaseline).not.toBe(failedArtifact)
  expect(git(f.root, ["show", `${correctedBaseline}:reviewer-fix.txt`])).toBe("approved")

  const wakesBeforeRetry = wakes
  const retry = await f.runtime.command(
    {
      requestID: "retry-corrected-baseline",
      planID: f.receipt.planID,
      action: "retry",
      taskID: f.tasks[1]!.id,
      reason: "Start from the reviewed shared baseline",
      workspaceMode: "shared",
      baseCommit: correctedBaseline,
    },
    "owner",
  )
  expect(retry).toMatchObject({ status: "retrying" })
  expect(wakes).toBe(wakesBeforeRetry + 1)
  expect(
    f.store.latestTransition<{ attemptID: string; source: string; explicitBaseline: boolean }>(
      f.receipt.planID,
      f.tasks[1]!.id,
      "WORKSPACE_SELECTED",
    ),
  ).toMatchObject({ source: correctedBaseline, explicitBaseline: true })
  expect(
    f.store.latestTransition<{
      attemptID: string
      selectedBaseline: string | null
      reason: string
      usageRetained: boolean
      budget: null
    }>(f.receipt.planID, f.tasks[1]!.id, "RETRY_REQUESTED"),
  ).toEqual({
    attemptID: failed.id,
    reason: "Start from the reviewed shared baseline",
    usageRetained: true,
    budget: null,
    selectedBaseline: correctedBaseline,
  })

  // A fresh runtime must recover the selected source from durable retry history.
  f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project", undefined, {
    autoResumeInterrupted: false,
  })
  try {
    await drive(reopened)
  } finally {
    reopened.stop()
  }

  const retriedAttempts = f.store
    .attempts(f.receipt.planID)
    .filter((attempt) => attempt.task_id === f.tasks[1]!.id)
  expect(retriedAttempts).toHaveLength(2)
  const retried = retriedAttempts[1]!
  const retriedArtifact = retried.artifact
  if (!retriedArtifact) throw new Error("Expected retry artifact")
  expect(retried.base_commit).toBe(correctedBaseline)
  expect(JSON.parse(retried.policy).source).toBe(correctedBaseline)
  expect(retried.workspace).toBe(f.root)
  expect(retried.state).toBe("accepted")
  expect(retriedAttempts[0]).toMatchObject({
    id: failed.id,
    state: "failed",
    base_commit: predecessorArtifact,
    artifact: failedArtifact,
    token_count: 65941,
    tool_count: 17,
    cost: 1.25,
  })
  expect(f.store.nodes(f.receipt.planID)[1]!.state).toBe("accepted")
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
  expect(git(f.root, ["diff", "--name-only", `${correctedBaseline}..${retriedArtifact}`])).toBe(
    "b.txt",
  )
  expect(git(f.root, ["show", `${retriedArtifact}:reviewer-fix.txt`])).toBe("approved")

  const failedCheck = attemptCheck(f, f.tasks[1]!.id, failed.id)
  const retriedCheck = attemptCheck(f, f.tasks[1]!.id, retried.id)
  expect(failedCheck.artifact).toBe(failedArtifact)
  expect(failedCheck.exitCode).not.toBe(0)
  expect(retriedCheck.artifact).toBe(retriedArtifact)
  expect(retriedCheck.inputIdentity).toBe(retriedArtifact)
  expect(retriedCheck.exitCode).toBe(0)
  const checks = f.store
    .effects(f.receipt.planID)
    .filter((effect) => effect.task_id === f.tasks[1]!.id && effect.kind === "verify:content")
  expect(checks.map((effect) => effect.id)).toHaveLength(2)
  expect(new Set(checks.map((effect) => effect.attempt_id)).size).toBe(2)
  const combined = f.store
    .effects(f.receipt.planID)
    .find((effect) => effect.kind === "graph-verify:combined")!
  expect(JSON.parse(combined.receipt!).check.artifact).toBe(retriedArtifact)
})

test("retry without a newly selected baseline continues from the failed artifact and retains history", async () => {
  const f = fixture({ shared: true, wrongFirstB: true })
  const { predecessor, failed } = await failSecondSharedTask(f)
  const predecessorArtifact = predecessor.artifact
  const failedArtifact = failed.artifact
  if (!predecessorArtifact || !failedArtifact) throw new Error("Expected Git artifacts")
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(failedArtifact)

  await f.runtime.command(
    {
      requestID: "retry-existing-baseline",
      planID: f.receipt.planID,
      action: "retry",
      taskID: f.tasks[1]!.id,
      reason: "Continue the existing shared attempt",
      workspaceMode: "shared",
    },
    "owner",
  )
  expect(
    f.store.latestTransition<{ attemptID: string; selectedBaseline: string | null }>(
      f.receipt.planID,
      f.tasks[1]!.id,
      "RETRY_REQUESTED",
    ),
  ).toMatchObject({ attemptID: failed.id, selectedBaseline: null })
  await drive(f.runtime)

  const retriedAttempts = f.store
    .attempts(f.receipt.planID)
    .filter((attempt) => attempt.task_id === f.tasks[1]!.id)
  expect(retriedAttempts).toHaveLength(2)
  const retried = retriedAttempts[1]!
  const retriedArtifact = retried.artifact
  if (!retriedArtifact) throw new Error("Expected retry artifact")
  expect(retried.base_commit).toBe(failedArtifact)
  expect(JSON.parse(retried.policy).source).toBe(failedArtifact)
  expect(retried.state).toBe("accepted")
  expect(retriedAttempts[0]).toMatchObject({
    id: failed.id,
    state: "failed",
    base_commit: predecessorArtifact,
    artifact: failedArtifact,
    token_count: 65941,
    tool_count: 17,
    cost: 1.25,
  })
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")

  const failedCheck = attemptCheck(f, f.tasks[1]!.id, failed.id)
  const retriedCheck = attemptCheck(f, f.tasks[1]!.id, retried.id)
  expect(failedCheck.artifact).toBe(failedArtifact)
  expect(failedCheck.exitCode).not.toBe(0)
  expect(retriedArtifact).not.toBe(failedArtifact)
  expect(retriedCheck.artifact).toBe(retriedArtifact)
  expect(retriedCheck.inputIdentity).toBe(retriedArtifact)
  expect(retriedCheck.exitCode).toBe(0)
  const combined = f.store
    .effects(f.receipt.planID)
    .find((effect) => effect.kind === "graph-verify:combined")!
  expect(JSON.parse(combined.receipt!).check.artifact).toBe(retriedArtifact)
})
