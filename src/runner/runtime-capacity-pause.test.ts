import { VerificationReview } from "./verification-review.ts"
import { expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { effectivePause, setPause } from "../projects/pause.ts"
import { inspectPlan } from "./inspection.ts"
import type { CompactPlanDetail } from "./inspection.ts"
import {
  TaskRuntime,
  acceptPlan,
  capacityLimit,
  drive,
  fixture,
  includeArtifact,
  integrateTaskSource,
  recordPlanIntegration,
  registeredKey,
  runPlan,
  submitTakeover,
  takeoverFixture,
  useRuntimeFixtureCleanup,
} from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

test("dispatch pause lets active work finish and unpause admits the next task", async () => {
  const f = fixture({ delayed: true, shared: true, commit: true })
  await runPlan(f)
  await f.runtime.tick()
  const first = f.store.attempts(f.receipt.planID)[0]!
  await f.runtime.command(
    {
      requestID: "pause",
      action: "pause",
      planID: f.receipt.planID,
      reason: "Wait for coordination",
    },
    "owner",
  )
  expect(f.store.dispatchPause(f.receipt.planID)).toEqual({
    reason: "Wait for coordination",
    untilPlans: [],
  })
  expect(f.sessions.get(first.session_id)!.busy).toBe(true)
  f.completeWorker(first.session_id)
  await drive(f.runtime, 4)
  expect(f.store.nodes(f.receipt.planID)[0]!.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(f.events.some((event) => event.startsWith("interrupt:"))).toBe(false)
  await integrateTaskSource(f, f.receipt.planID, first.task_id)
  await drive(f.runtime, 2)
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  await f.runtime.command(
    {
      requestID: "unpause",
      action: "unpause",
      planID: f.receipt.planID,
    },
    "owner",
  )
  await drive(f.runtime, 2)
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(2)
  expect(f.store.dispatchPause(f.receipt.planID)).toBeUndefined()
})

test("dispatch pause survives restart and automatically clears only after recorded integration", async () => {
  const f = fixture({ delayed: true, commit: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const dependency = f.receipt.planID
  const childTask = f.createTask("b")
  const child = f.store.submit(f.inputFor([childTask], { requestID: "paused-child" }), "owner")
  await f.runtime.command(
    {
      requestID: "pause-child",
      action: "pause",
      planID: child.planID,
      reason: "Coordinate after prerequisite",
      resumeAfterPlans: [dependency],
    },
    "owner",
  )
  await runPlan(f, child.planID, "run-paused-child")
  const accepted = await acceptPlan(f, dependency)
  expect(f.store.attempts(child.planID)).toHaveLength(0)
  await f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project", undefined, {
    autoResumeInterrupted: false,
  })
  try {
    await drive(reopened, 2)
    expect(f.store.dispatchPause(child.planID)?.untilPlans).toEqual([dependency])
    expect(f.store.attempts(child.planID)).toHaveLength(0)
    includeArtifact(f, accepted.plan.artifact!)
    await recordPlanIntegration({ ...f, runtime: reopened }, dependency)
    await drive(reopened, 3)
    expect(f.store.dispatchPause(child.planID)).toBeUndefined()
    expect(f.store.attempts(child.planID)).toHaveLength(1)
  } finally {
    await reopened.stop()
  }
})

test("pause conditions cannot silently wait on cancellation or create a coordination cycle", async () => {
  const f = fixture({ delayed: true, shared: true })
  const prerequisiteTask = f.createTask("prerequisite")
  const prerequisite = f.store.submit(
    f.inputFor([prerequisiteTask], { requestID: "paused-prerequisite" }),
    "owner",
  )
  await f.runtime.command(
    {
      requestID: "pause-with-condition",
      action: "pause",
      planID: f.receipt.planID,
      resumeAfterPlans: [prerequisite.planID],
    },
    "owner",
  )
  await expect(
    f.runtime.command(
      {
        requestID: "cycle",
        action: "pause",
        planID: prerequisite.planID,
        resumeAfterPlans: [f.receipt.planID],
      },
      "owner",
    ),
  ).rejects.toThrow("cycle")
  await runPlan(f)
  await f.runtime.command(
    {
      requestID: "cancel-condition",
      action: "cancel",
      planID: prerequisite.planID,
    },
    "owner",
  )
  await drive(f.runtime, 3)
  // The cancelled prerequisite is dropped from the pause condition and the plan stays running.
  expect(f.store.dispatchPause(f.receipt.planID)?.untilPlans ?? []).not.toContain(
    prerequisite.planID,
  )
  await f.runtime.command(
    {
      requestID: "clear-pause",
      action: "unpause",
      planID: f.receipt.planID,
    },
    "owner",
  )
  await drive(f.runtime, 2)
  expect(f.store.plan(f.receipt.planID)!.state).toBe("running")
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
})

test("pause does not invalidate a verification that is already in flight", async () => {
  const f = fixture({
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
    checkCommand: 'sleep 0.1; test "$(cat a.txt)" = a',
  })
  await runPlan(f)
  await f.runtime.tick()
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)[0]!.state).toBe("verifying")
  await f.runtime.command(
    {
      requestID: "pause-checking",
      action: "pause",
      planID: f.receipt.planID,
      reason: "Hold next dispatch only",
    },
    "owner",
  )
  await drive(f.runtime)
  expect(f.store.nodes(f.receipt.planID)[0]!.state).toBe("accepted")
  expect(f.store.plan(f.receipt.planID)!.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
})

test.each(["initial", "detailed", "unknown"] as const)(
  "a definitively deleted worker at %s read can be cancelled and retried without losing retained work",
  async (disappearsAt) => {
    const f = fixture({ delayed: true })
    await runPlan(f)
    await f.runtime.tick()
    const attempt = f.store.attempts(f.receipt.planID)[0]!
    const retained = join(attempt.workspace, "retained-notes.txt")
    writeFileSync(retained, "useful partial work\n")
    if (disappearsAt === "initial" || disappearsAt === "unknown") {
      if (disappearsAt === "unknown")
        f.repository.atomic((db) =>
          db.query("UPDATE runner_attempts SET state='unknown' WHERE id=?").run(attempt.id),
        )
      f.sessions.delete(attempt.session_id)
    } else {
      const worker = f.sessions.get(attempt.session_id)!
      worker.busy = false
      worker.outcome = "succeeded"
      worker.turn = { inputID: attempt.message_id, state: "completed" }
      const read = f.host.session
      f.host.session = async (id, options) => {
        if (id === attempt.session_id && options?.messages) {
          f.sessions.delete(id)
          return null
        }
        return read(id, options)
      }
    }
    await f.runtime.command(
      {
        requestID: "cancel-deleted-worker",
        planID: f.receipt.planID,
        action: "cancel",
      },
      "owner",
    )
    await f.runtime.tick()
    expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelled")
    expect(f.store.attempts(f.receipt.planID)[0]).toMatchObject({
      id: attempt.id,
      state: "cancelled",
      workspace: attempt.workspace,
    })
    expect(readFileSync(retained, "utf8")).toBe("useful partial work\n")
    expect(f.events).not.toContain(`stop:${attempt.session_id}`)
    // A cleanup tick must preserve the dirty checkout without blocking retry.
    await f.runtime.tick()
    expect(
      f.store.effects(f.receipt.planID).find((effect) => effect.kind === "worktree-remove")?.state,
    ).toBe("held")
    await f.runtime.command(
      {
        requestID: "retry-deleted-worker",
        planID: f.receipt.planID,
        action: "retry",
        taskID: attempt.task_id,
        attemptID: attempt.id,
        reason: "Continue after native worker deletion; retain the old checkout for review",
      },
      "owner",
    )
    await f.runtime.tick()
    const attempts = f.store.attempts(f.receipt.planID).filter((a) => a.task_id === attempt.task_id)
    expect(attempts).toHaveLength(2)
    expect(attempts[1]!.session_id).not.toBe(attempt.session_id)
    expect(readFileSync(retained, "utf8")).toBe("useful partial work\n")
  },
)

test("worker lookup failure preserves cancellation without starving independent dispatch", async () => {
  const f = fixture({ independent: true, delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  const read = f.host.session
  f.host.session = async (id, options) => {
    if (id === attempt.session_id) throw new Error("Native worker lookup temporarily unavailable")
    return read(id, options)
  }
  await f.runtime.command(
    {
      requestID: "cancel-temporarily-unobserved-worker",
      planID: f.receipt.planID,
      action: "cancel",
    },
    "owner",
  )
  const independent = f.createTask("independent", "other/independent.txt")
  const next = f.store.submit(f.inputFor([independent], { requestID: "independent" }), "owner")
  await runPlan(f, next.planID, "run-independent")
  await f.runtime.tick()
  expect(f.store.attempts(next.planID)[0]?.state).toBe("running")
  await f.runtime.tick()
  const activity = f.store.detail(f.receipt.planID).activity as { event: string; payload: string }[]
  const failures = activity.filter((row) => row.event === "PLAN_STEP_FAILED")
  expect(failures).toHaveLength(1)
  expect(JSON.parse(failures[0]!.payload)).toEqual({
    error: "Native worker lookup temporarily unavailable",
  })
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
  expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelling")
  f.host.session = read
  f.sessions.delete(attempt.session_id)
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelled")
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("cancelled")
})

test("a project pause holds new dispatch only there; running work is verified; unpause dispatches again", async () => {
  const f = fixture({ delayed: true, shared: true, commit: true })
  const key = await registeredKey(f)
  // Another project's pause does not touch this one.
  setPause(
    f.repository,
    { kind: "project", key: "github.com/other/project" },
    {
      paused: true,
      reason: "Elsewhere",
      by: "owner",
    },
  )
  await runPlan(f)
  await f.runtime.tick()
  const first = f.store.attempts(f.receipt.planID)[0]!
  expect(first).toBeDefined()
  setPause(f.repository, { kind: "project", key }, { paused: true, reason: "Rebuild", by: "owner" })
  expect(f.sessions.get(first.session_id)!.busy).toBe(true)
  f.completeWorker(first.session_id)
  await drive(f.runtime, 5)
  expect(f.store.nodes(f.receipt.planID)[0]!.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(f.events.some((event) => event.startsWith("interrupt:"))).toBe(false)
  await integrateTaskSource(f, f.receipt.planID, first.task_id)
  await drive(f.runtime, 5)
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(effectivePause(f.repository, f.receipt.planID)).toMatchObject({
    level: "project",
    reason: "Rebuild",
  })
  setPause(f.repository, { kind: "project", key }, { paused: false, reason: "", by: "owner" })
  await drive(f.runtime, 2)
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(2)
})

test("a global pause holds a project that was never registered, and lifting it dispatches", async () => {
  const f = fixture({ delayed: true, shared: true, commit: true })
  setPause(f.repository, { kind: "global" }, { paused: true, reason: "Away", by: "owner" })
  await runPlan(f)
  await drive(f.runtime, 5)
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(0)
  expect(effectivePause(f.repository, f.receipt.planID)?.level).toBe("global")
  setPause(f.repository, { kind: "global" }, { paused: false, reason: "", by: "owner" })
  await drive(f.runtime, 2)
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
})

test("a paused project's waiting task names the level in the execution read and the plan inspection", async () => {
  const f = fixture({ delayed: true, shared: true, commit: true })
  const key = await registeredKey(f)
  await runPlan(f)
  setPause(f.repository, { kind: "project", key }, { paused: true, reason: "Rebuild", by: "owner" })
  await drive(f.runtime, 3)
  const waiting = f.store.nodes(f.receipt.planID)[0]!
  expect(f.store.execution(waiting.task_id)?.dispatchPause).toEqual({
    reason: "Project pause: Rebuild",
    untilPlans: [],
    level: "project",
  })
  const compact = inspectPlan(f.store, {
    planID: f.receipt.planID,
    full: false,
  }) as CompactPlanDetail
  expect(compact.plan.schedule.dispatchPause).toEqual({
    reason: "Project pause: Rebuild",
    untilPlans: [],
    level: "project",
  })
  setPause(f.repository, { kind: "global" }, { paused: true, reason: "Away", by: "owner" })
  expect(f.store.execution(waiting.task_id)?.dispatchPause?.reason).toBe("Global pause: Away")
})

test("8c276019-1: a queued task of another plan is named as a scope owner", () => {
  const f = fixture()
  const plans = [
    { id: "plan-a", state: "running" },
    { id: "plan-b", state: "running" },
    { id: "plan-c", state: "integrated" },
  ]
  const nodes: Record<string, Array<{ task_id: string; state: string }>> = {
    "plan-a": [{ task_id: "task-a", state: "running" }],
    "plan-b": [
      { task_id: "task-b", state: "queued" },
      { task_id: "task-done", state: "accepted" },
    ],
    "plan-c": [{ task_id: "task-old", state: "queued" }],
  }
  const fake = {
    store: {
      planHeads: (states: string[]) => plans.filter((plan) => states.includes(plan.state)),
      nodes: (id: string) => nodes[id] ?? [],
      activeProjectAttempts: () => [],
      effectiveReservationScope: (id: string) => [`src/${id}.ts`],
    },
  }
  const owners = (VerificationReview.prototype as any).scopeOwners.call(fake, plans[0], "task-a")
  expect(owners).toEqual([{ taskID: "task-b", patterns: ["src/task-b.ts"] }])
})

test("capacity: with no limit set two independent tasks dispatch together, as before", async () => {
  const f = fixture({ independent: true, delayed: true })
  await f.runtime.command({ requestID: "run", planID: f.receipt.planID, action: "run" }, "owner")
  await drive(f.runtime, 2)
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(2)
  expect(await f.runtime.delegatedAgentCapacity.settings()).toMatchObject({
    limit: null,
    active: 2,
    queued: 0,
    reason: null,
  })
})

test("capacity: the Projects limit is honoured and a changed limit applies on the next pass", async () => {
  const f = fixture({ independent: true, delayed: true })
  await capacityLimit(f, 1)
  await f.runtime.command({ requestID: "run", planID: f.receipt.planID, action: "run" }, "owner")
  await drive(f.runtime, 2)
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(await f.runtime.delegatedAgentCapacity.settings()).toMatchObject({ limit: 1, active: 1 })
  await capacityLimit(f, 2)
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(2)
  // Lowering it again stops nothing that runs.
  await capacityLimit(f, 1)
  await drive(f.runtime, 2)
  expect(
    f.store.attempts(f.receipt.planID).filter((attempt) => attempt.state === "running"),
  ).toHaveLength(2)
  expect(f.events.some((event) => event.startsWith("interrupt:"))).toBe(false)
})

test("capacity: a paused project is granted no slot and its running work is not pre-empted", async () => {
  const f = fixture({ independent: true, delayed: true })
  const key = await registeredKey(f)
  await capacityLimit(f, 1)
  await f.runtime.command({ requestID: "run", planID: f.receipt.planID, action: "run" }, "owner")
  await drive(f.runtime, 2)
  const [running] = f.store.attempts(f.receipt.planID)
  expect(running).toBeDefined()
  setPause(f.repository, { kind: "project", key }, { paused: true, reason: "Rebuild", by: "owner" })
  await drive(f.runtime, 2)
  expect(f.sessions.get(running!.session_id)!.busy).toBe(true)
  expect(f.events.some((event) => event.startsWith("interrupt:"))).toBe(false)
  // The freed slot is not granted while paused, and no admission waits in the queue for it.
  f.completeWorker(running!.session_id)
  await drive(f.runtime, 4)
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(await f.runtime.delegatedAgentCapacity.settings()).toMatchObject({ active: 0, queued: 0 })
  setPause(f.repository, { kind: "project", key }, { paused: false, reason: "", by: "owner" })
  await drive(f.runtime, 2)
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(2)
})

test("capacity: a task taken over by the Architect counts once against the limit", async () => {
  const { f, worker } = await takeoverFixture()
  await capacityLimit(f, 1)
  expect(await f.runtime.delegatedAgentCapacity.settings()).toMatchObject({ active: 1 })
  f.completeWorker(worker.session_id, "interrupted")
  const taken = await f.runtime.takeover({ attemptID: worker.id, reason: "Dead worker" }, "owner")
  expect(taken.status).toBe("taken-over")
  await drive(f.runtime, 2)
  expect(await f.runtime.delegatedAgentCapacity.settings()).toMatchObject({
    limit: 1,
    active: 1,
    queued: 0,
  })
  // The slot is the task's: a helper waits behind it rather than starting a second agent.
  const helper = await f.runtime.delegatedAgentCapacity.ensureNativeQueued({
    parentSessionID: "owner",
    toolCallID: "helper-during-takeover",
    agent: "research",
    description: "Wait for the task's slot",
  })
  await expect(
    f.runtime.delegatedAgentCapacity.waitForNative(helper, AbortSignal.timeout(300)),
  ).rejects.toThrow()
  writeFileSync(join(worker.workspace, "a.txt"), "a")
  await submitTakeover(f, worker.task_id, "submit-capacity")
  await drive(f.runtime, 10)
  expect(f.store.attempts(f.receipt.planID).find((a) => a.id === taken.attemptID)!.state).toBe(
    "accepted",
  )
  expect(await f.runtime.delegatedAgentCapacity.settings()).toMatchObject({ active: 0 })
})

test("a worker waiting on a question releases capacity without losing its task", async () => {
  const f = fixture({ delayed: true, independent: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await capacityLimit(f, 1)
  await runPlan(f)
  await f.runtime.tick()
  const first = f.store.attempts(f.receipt.planID)[0]!
  const secondTask = f.createTask("b", "b.txt")
  const second = f.store.submit(
    f.inputFor([secondTask], { requestID: "work-beside-question" }),
    "owner",
  )
  await runPlan(f, second.planID, "start-beside-question")
  await f.runtime.tick()
  expect(f.store.attempts(second.planID)).toHaveLength(0)
  f.sessions.get(first.session_id)!.pendingForms = 1
  await f.runtime.tick()
  await f.runtime.tick()
  expect(f.store.attempts(second.planID)).toHaveLength(1)
  expect(f.store.attempts(f.receipt.planID)[0]?.id).toBe(first.id)
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
  expect(await f.runtime.delegatedAgentCapacity.settings()).toMatchObject({ limit: 1, active: 1 })
})
