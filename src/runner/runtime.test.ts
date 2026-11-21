import { allPlans } from "./store-plans.fixture.ts"
import { expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { checkResourcesSettled } from "./artifacts.ts"
import type { RunnerCheckReceipt } from "./artifacts.ts"

import { RunnerStore } from "./store.ts"
import { fingerprint } from "../identity.ts"
import { sharedScheduler, schedulerProjectKey } from "./scheduler-coordinator.ts"
import { verificationActivitiesForDatabase } from "./verification-activities.ts"
import {
  TaskRuntime,
  architectBacklog,
  cleanup,
  drive,
  fixture,
  prepareIdleArchitect,
  registeredPlanCommand,
  reopenRuntime,
  runPlan,
  singleTask,
  waitForPath,
  useRuntimeFixtureCleanup,
} from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

// Live LZ-252: a scope instruction journaled after a retained repair was settled by one tick,
// which then returned; the repair prompt waited 5 minutes for the periodic tick.
test("a plan step that settles an effect continues the plan in the same scheduler pass", async () => {
  const f = fixture({ delayed: true, repair: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const planID = f.receipt.planID
  await f.runtime.command({ requestID: "run", planID, action: "run" }, "owner")
  await drive(f.runtime, 2)
  const attempt = f.store.attempts(planID)[0]!
  await f.runtime.command(
    {
      requestID: "allow-test",
      planID,
      action: "amend-scope",
      taskID: attempt.task_id,
      scopeAdditions: ["escape.txt"],
      reason: "Keep the reviewed legitimate dependency test.",
    },
    "owner",
  )
  expect(f.store.effects(planID).find((e) => e.kind === "scope-instruction")?.state).toBe(
    "intended",
  )
  f.completeWorker(attempt.session_id)
  await f.runtime.tick()
  expect(f.store.effects(planID).find((e) => e.kind === "scope-instruction")?.state).toBe(
    "completed",
  )
  // The same pass observed the finished worker instead of leaving it for the next one.
  expect(["verifying", "accepted"]).toContain(f.store.attempts(planID)[0]!.state)
})

test("Architect run, scope amendment, reconcile, and cancel wake the scheduler before periodic reconciliation", async () => {
  const f = fixture({ delayed: true })
  let drained = Promise.withResolvers<void>()
  const registration = sharedScheduler.register(
    schedulerProjectKey(f.repository.path, f.root, "project"),
    {
      intervalMs: 300_000,
      run: async () => {
        await f.runtime.tick()
        drained.resolve()
      },
      onError: (error) => drained.reject(error),
    },
    300_000,
  )
  let wakes = 0
  const runtime = new TaskRuntime(f.store, f.host, "project", undefined, {
    autoResumeInterrupted: false,
    wakeScheduler: () => {
      wakes++
      expect(f.store.plan(f.receipt.planID)?.state).toBe(wakes === 4 ? "cancelling" : "running")
      registration.request()
    },
  })
  try {
    const tool = await registeredPlanCommand(runtime)
    const command = {
      requestID: "architect-run",
      planID: f.receipt.planID,
      action: "run",
    }
    const receipt = await tool.execute(command)
    expect(await tool.execute(command)).toEqual(receipt)
    await drained.promise
    expect(wakes).toBe(1)
    const attempts = f.store.attempts(f.receipt.planID)
    expect(attempts).toHaveLength(1)
    expect(f.events.filter((event) => event.startsWith("start:"))).toHaveLength(1)
    drained = Promise.withResolvers<void>()
    const amendment = {
      ...command,
      requestID: "architect-scope",
      action: "amend-scope",
      taskID: attempts[0]!.task_id,
      scopeAdditions: ["dependency.test.ts"],
      reason: "Keep the dependency test in the same attempt.",
    }
    const amended = await tool.execute(amendment)
    expect(await tool.execute(amendment)).toEqual(amended)
    await drained.promise
    expect(wakes).toBe(2)
    expect(f.instructions.get(attempts[0]!.session_id)?.size).toBe(1)
    f.completeWorker(attempts[0]!.session_id)
    drained = Promise.withResolvers<void>()
    await tool.execute({
      ...command,
      requestID: "architect-reconcile",
      action: "reconcile",
    })
    await drained.promise
    expect(wakes).toBe(3)
    expect(f.store.attempts(f.receipt.planID)[0]).toMatchObject({
      id: attempts[0]!.id,
      state: "verifying",
    })
    drained = Promise.withResolvers<void>()
    await tool.execute({
      ...command,
      requestID: "architect-cancel",
      action: "cancel",
    })
    expect(wakes).toBe(4)
    await drained.promise
  } finally {
    await registration.dispose()
    await runtime.stop()
  }
})

test("scheduler retries after a failed lease claim instead of remaining permanently running", async () => {
  const f = fixture()
  const claim = f.store.claim.bind(f.store)
  let calls = 0
  f.store.claim = (...args) => {
    calls++
    if (calls === 1) throw new Error("database temporarily unavailable")
    return claim(...args)
  }
  await expect(f.runtime.tick()).rejects.toThrow("database temporarily unavailable")
  await f.runtime.tick()
  expect(calls).toBe(2)
})

test("F-S4-2 scheduler dispatches runnable work behind 1000 high-priority terminal plans", async () => {
  const f = fixture({ delayed: true })
  f.store.atomic((db) => {
    const clone = db.query(`INSERT INTO runner_plans
      SELECT ?,project_directory,owner,revision,version,'integrated',json_set(body,'$.priority',100),model,reason,artifact
      FROM runner_plans WHERE id=?`)
    for (let i = 0; i < 1005; i++) clone.run(`history-${i}`, f.receipt.planID)
  })
  expect(allPlans(f.store).some((plan) => plan.id === f.receipt.planID)).toBe(true)
  await runPlan(f)
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(f.store.attempts(f.receipt.planID)[0]!.state).toBe("running")
})

test("a runtime tick yields to the event loop while observing Git state", async () => {
  const f = fixture({ delayed: true })
  await runPlan(f)
  let beats = 0
  let last = performance.now()
  let worstGap = 0
  const timer = setInterval(() => {
    const now = performance.now()
    worstGap = Math.max(worstGap, now - last)
    last = now
    beats++
  }, 2)
  try {
    await f.runtime.tick()
  } finally {
    clearInterval(timer)
  }
  expect(f.store.attempts(f.receipt.planID).length).toBeGreaterThan(0)
  expect(beats).toBeGreaterThan(0)
  // No synchronous Git or filesystem slice may hold the thread for a whole tick.
  expect(worstGap).toBeLessThan(500)
})

test("a real verification barrier does not block same-project dispatch, cancellation, or delivery", async () => {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const f = fixture({
    delayed: true,
    independent: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
    checkCommand: (name, _path, root) =>
      name === "a"
        ? `printf x >> ${quote(join(root, ".lazers-check-started"))}; while [ ! -f ${quote(join(root, ".lazers-check-release"))} ]; do sleep 0.02; done; test "$(cat a.txt)" = "a"`
        : `test "$(cat ${name}.txt)" = "${name}"`,
  })
  const control = await registeredPlanCommand(f.runtime)
  const run = async (planID: string, requestID: string) => {
    const plan = f.store.plan(planID)!
    await control.execute({ requestID, planID, action: "run" })
  }
  const taskB = f.createTask("b", "b.txt")
  const planB = f.store.submit(f.inputFor([taskB], { requestID: "barrier-plan-b" }), "owner")
  const taskC = f.createTask("c", "c.txt")
  const planC = f.store.submit(f.inputFor([taskC], { requestID: "barrier-plan-c" }), "owner")
  const taskD = f.createTask("d", "d.txt")
  const planD = f.store.submit(f.inputFor([taskD], { requestID: "barrier-plan-d" }), "owner")

  await run(f.receipt.planID, "barrier-run-a")
  await f.runtime.tick()
  const attemptA = f.store.attempts(f.receipt.planID)[0]!
  f.completeWorker(attemptA.session_id)
  await f.runtime.tick()
  const started = join(f.root, ".lazers-check-started")
  const release = join(f.root, ".lazers-check-release")
  await waitForPath(started)
  const effectA = f.store
    .effects(f.receipt.planID)
    .find((effect) => effect.kind === "verify:content")!
  const pending = verificationActivitiesForDatabase(f.repository.path).find(
    (activity) => activity.metadata.effectID === effectA.id,
  )!
  expect(pending.state).toBe("running")
  expect(existsSync(release)).toBe(false)

  await run(planC.planID, "barrier-run-c")
  await f.runtime.tick()
  await run(planB.planID, "barrier-run-b")
  await control.execute({
    requestID: "barrier-cancel-c",
    planID: planC.planID,
    action: "cancel",
  })
  await control.execute({
    requestID: "barrier-cancel-d",
    planID: planD.planID,
    action: "cancel",
  })
  const competing = new TaskRuntime(f.store, f.host, "project", undefined, {
    autoResumeInterrupted: false,
  })
  cleanup.push(async () => competing.stop())
  await Promise.all([f.runtime.tick(), f.runtime.tick(), f.runtime.tick(), competing.tick()])

  expect(pending.state).toBe("running")
  expect(readFileSync(started, "utf8")).toBe("x")
  expect(
    f.store.effects(f.receipt.planID).filter((effect) => effect.kind === "verify:content"),
  ).toHaveLength(1)
  expect(f.store.attempts(planB.planID)).toHaveLength(1)
  expect(f.store.attempts(planC.planID)[0]?.state).toBe("cancelled")
  expect(f.store.plan(planC.planID)?.state).toBe("cancelled")
  expect(f.store.plan(planD.planID)?.state).toBe("cancelled")
  expect(f.notifications.some((notice) => notice.text.includes('"status":"cancelled"'))).toBe(true)

  writeFileSync(release, "release\n")
  await pending.settled
  await drive(f.runtime, 5)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
})

test("runtime stop aborts checks admitted by its draining tick before storage disposal", async () => {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const f = fixture({
    taskFiles: [{ name: "a", path: "a.txt" }],
    checkCommand: (_name, _path, root) =>
      `printf started > ${quote(join(root, "check-started"))}; printf "%s" "$$" > ${quote(join(root, "check-pid"))}; while [ ! -f ${quote(join(root, "check-release"))} ]; do sleep 0.02; done; exit 0`,
    combinedCheckCommand: "true",
  })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  f.completeWorker(attempt.session_id)

  let observed!: () => void
  const observationEntered = new Promise<void>((resolve) => (observed = resolve))
  let release!: () => void
  const observationRelease = new Promise<void>((resolve) => (release = resolve))
  let blocked = false
  const originalSession = f.host.session.bind(f.host)
  f.host.session = async (id, options) => {
    if (id === attempt.session_id && options?.messages && !blocked) {
      blocked = true
      observed()
      await observationRelease
    }
    return originalSession(id, options)
  }
  let admitted!: () => void
  const verificationAdmitted = new Promise<void>((resolve) => (admitted = resolve))
  let drain!: () => void
  const drainRelease = new Promise<void>((resolve) => (drain = resolve))
  const runtimeInternals = Reflect.get(f.runtime, "verificationReview") as {
    verify: (...args: unknown[]) => Promise<void>
  }
  const originalVerify = runtimeInternals.verify.bind(runtimeInternals)
  runtimeInternals.verify = async (...args) => {
    await originalVerify(...args)
    admitted()
    await drainRelease
  }

  const advancing = f.runtime.tick()
  await observationEntered
  const stopping = f.runtime.stop()
  // Let stop take its first activity snapshot while the tick is held before
  // it admits the check; releasing the observation then exercises the late
  // activity sweep after the drain reaches idle.
  await new Promise<void>((resolve) => setImmediate(resolve))
  release()
  await verificationAdmitted
  await waitForPath(join(f.root, "check-started"), 3_000)

  const effect = f.store.effects(f.receipt.planID).find((item) => item.kind === "verify:content")!
  const activity = verificationActivitiesForDatabase(f.repository.path).find(
    (item) => item.metadata.effectID === effect.id,
  )!
  expect(activity.owner).toBe(f.runtime.owner)
  expect(activity.state).toBe("running")
  drain()
  await Promise.all([advancing, stopping])
  runtimeInternals.verify = originalVerify
  expect(activity.state).toBe("completed")
  expect(
    verificationActivitiesForDatabase(f.repository.path).some((item) => item.state === "running"),
  ).toBe(false)
  const checkedAttempt = f.store.attempts(f.receipt.planID)[0]!
  const receiptPath = (JSON.parse(effect.payload) as { receiptPath: string }).receiptPath
  expect(existsSync(receiptPath)).toBe(true)
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as RunnerCheckReceipt
  expect(receipt).toMatchObject({
    id: "content",
    artifact: checkedAttempt.artifact,
    inputIdentity: checkedAttempt.artifact,
    exitCode: expect.any(Number),
    timedOut: false,
    aborted: true,
    processCleanup: { state: "terminated", capability: "process-group" },
  })
  expect(checkResourcesSettled(receipt)).toBe(true)
  expect(effect.state).toBe("intended")

  const reopened = reopenRuntime(f)
  await reopened.runtime.tick()
  const recovered = reopened.store.effects(f.receipt.planID).find((item) => item.id === effect.id)!
  // F-S5-1: shutdown is an interruption, never a failed product check or worker repair.
  expect(recovered.state).toBe("uncertain")
  expect(reopened.store.plan(f.receipt.planID)?.state).toBe("blocked")
  expect(reopened.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(reopened.store.attempts(f.receipt.planID)[0]?.state).toBe("verifying")
  writeFileSync(join(f.root, "check-release"), "release\n")
  await reopened.runtime.tick()
  expect(
    reopened.store.effects(f.receipt.planID).filter((item) => item.kind === "verify:content"),
  ).toHaveLength(2)
  await drive(reopened.runtime, 8)
  expect(reopened.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(reopened.store.attempts(f.receipt.planID)).toHaveLength(1)
  const checks = reopened.store
    .effects(f.receipt.planID)
    .filter((item) => item.kind === "verify:content")
  expect(checks).toHaveLength(2)
  expect(checks.find((item) => item.id === effect.id)?.state).toBe("failed")
  expect(readFileSync(receiptPath, "utf8")).toContain('"aborted":true')
  expect(readFileSync(join(f.root, "check-started"), "utf8")).toBe("started")
})

test("a plan reconcile over 30 seconds records PLAN_STEP_SLOW naming the slow call; a fast one records none", async () => {
  let clock = 2_000_000_000_000
  const slowOwnerRead = (f: ReturnType<typeof fixture>, slow: boolean) => {
    const read = f.host.session
    f.host.session = async (id, options) => {
      if (slow && id === "owner") clock += 45_000
      return read(id, options)
    }
  }
  const slowRecords = (f: ReturnType<typeof fixture>) =>
    f.store
      .atomic((db) =>
        db
          .query<{ payload: string }, [string]>(
            "SELECT payload FROM runner_transitions WHERE plan_id=? AND event='PLAN_STEP_SLOW'",
          )
          .all(f.receipt.planID),
      )
      .map(
        (row) =>
          JSON.parse(row.payload) as {
            ms: number
            phase: string
            sections: { name: string; ms: number }[]
          },
      )

  const fast = fixture({ now: () => clock, taskFiles: singleTask })
  slowOwnerRead(fast, false)
  await runPlan(fast)
  await fast.runtime.tick()
  expect(slowRecords(fast)).toHaveLength(0)

  const slow = fixture({ now: () => clock, taskFiles: singleTask })
  slowOwnerRead(slow, true)
  await runPlan(slow)
  await slow.runtime.tick()
  const records = slowRecords(slow)
  expect(records).toHaveLength(1)
  expect(records[0]!.phase).toBe("step")
  expect(records[0]!.ms).toBeGreaterThanOrEqual(45_000)
  expect(records[0]!.sections[0]).toMatchObject({ name: "step:host.session" })
  expect(records[0]!.sections[0]!.ms).toBeGreaterThanOrEqual(45_000)
})

test("a cancelled plan's cleanup runs after runnable plans and is not re-evaluated while its facts are unchanged", async () => {
  const clock = 2_000_000_000_000
  const f = fixture({ delayed: true, now: () => clock, taskFiles: singleTask })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const worker = f.store.attempts(planID)[0]!
  f.completeWorker(worker.session_id, "interrupted")
  await f.runtime.command(
    { requestID: "cancel-a", planID, action: "cancel", reason: "supersede" },
    "owner",
  )
  const worktreeReads: string[] = []
  const read = f.host.worktrees
  f.host.worktrees = async () => {
    worktreeReads.push(`worktrees@${f.events.length}`)
    f.events.push("cleanup:host.worktrees")
    return read()
  }
  for (let n = 0; n < 6 && f.store.plan(planID)?.state !== "cancelled"; n++) await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("cancelled")
  const readsBefore = worktreeReads.length

  // A runnable plan and a pending cleanup in one tick: the runnable plan is stepped first.
  const taskB = f.createTask("b", "b.txt")
  const planB = f.store.submit(f.inputFor([taskB], { requestID: "second-plan" }), "owner")
  await runPlan(f, planB.planID, "run-b")
  const eventsBefore = f.events.length
  f.store.atomic((db) =>
    db.query("DELETE FROM runner_effects WHERE plan_id=? AND kind='worktree-remove'").run(planID),
  )
  await f.runtime.tick()
  const tickEvents = f.events.slice(eventsBefore)
  const created = tickEvents.findIndex((event) => event.startsWith("create:"))
  const cleaned = tickEvents.indexOf("cleanup:host.worktrees")
  expect(created).toBeGreaterThanOrEqual(0)
  expect(cleaned).toBeGreaterThan(created)

  // Nothing observable changed and the clock did not move: the blocker is not re-evaluated.
  const settledReads = worktreeReads.length
  await f.runtime.tick()
  await f.runtime.tick()
  expect(worktreeReads.length).toBe(settledReads)
  expect(readsBefore).toBeLessThanOrEqual(settledReads)
})

test("leases fence stale owners; expiration does not replay an uncertain effect", async () => {
  const f = fixture()
  const a = f.store.claim("first", 100)!
  expect(f.store.claim("second", 101)).toBeNull()
  const b = f.store.claim("second", 30101)!
  expect(b).toBeGreaterThan(a)
  expect(() => f.store.fenced("first", a, () => true)).toThrow("Stale")
  expect(f.store.fenced("second", b, () => true)).toBe(true)
})

test("runtime shutdown joins an in-flight native operation before storage may close", async () => {
  const f = fixture({ delayed: true })
  await runPlan(f)
  const original = f.host.session
  let entered!: () => void
  let release!: () => void
  const entering = new Promise<void>((resolve) => {
    entered = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  f.host.session = async (id) => {
    entered()
    await blocked
    return original(id)
  }
  const tick = f.runtime.tick()
  await entering
  let stopped = false
  const stopping = f.runtime.stop().then(() => {
    stopped = true
  })
  await Promise.resolve()
  expect(stopped).toBe(false)
  release()
  await tick
  await stopping
  expect(stopped).toBe(true)
  const attempts = f.store.attempts(f.receipt.planID).length
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(attempts)
})

test("a reopened scheduler recovers a durable transfer before archival without changing workers", async () => {
  const now = 2_000_000_400_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  const attempt = await prepareIdleArchitect(f, now, 1_000)
  const ownerID = f.runtime.owner
  const fence = f.store.claim(ownerID, now)!
  const plan = f.store.plan(f.receipt.planID)!
  const renewal = f.store.beginArchitectRenewal({
    schedulerOwner: ownerID,
    fence,
    anchorPlanID: plan.id,
    previousSessionID: plan.owner,
    directory: f.sessions.get(plan.owner)!.directory,
    model: JSON.stringify(f.sessions.get(plan.owner)!.model),
    idleAt: f.sessions.get(plan.owner)!.idleAt!,
    now,
    handoffMessageID: "reopen-handoff-message",
  })!
  await f.host.createArchitect({
    id: renewal.successor_session_id,
    parentID: renewal.previous_session_id,
    directory: renewal.directory,
    model: JSON.parse(renewal.model),
    title: "LAZERS · reopened plan",
    planID: renewal.anchor_plan_id,
    planIDs: f.store.architectRenewalPlans(renewal.id).map((item) => item.plan_id),
    sourceSessionID: renewal.previous_session_id,
  })
  const payload = {
    status: "architect-handoff",
    planID: plan.id,
    version: plan.version + 1,
    planIDs: [plan.id],
    label: "reopened plan",
    continuity: JSON.parse(renewal.continuity_json!),
    predecessorSessionID: renewal.previous_session_id,
    successorSessionID: renewal.successor_session_id,
  }
  const metadata = {
    lazersKind: "runner-outcome",
    lazersProjectID: "project",
    lazersProjectDirectory: f.root,
    lazersPlanID: plan.id,
    lazersOutboxID: "reopen-handoff-outbox",
    lazersMessageID: renewal.handoff_message_id,
    lazersSessionID: renewal.successor_session_id,
    lazersStatus: "architect-handoff",
    lazersVersion: plan.version + 1,
  }
  expect(
    f.store.transferArchitectRenewal({
      schedulerOwner: ownerID,
      fence,
      renewalID: renewal.id,
      outboxID: "reopen-handoff-outbox",
      payload: JSON.stringify(payload),
      metadata: JSON.stringify(metadata),
    }),
  ).toBe(true)
  expect(f.store.architectRenewal(renewal.id)?.state).toBe("archiving")
  expect(f.store.plan(plan.id)?.owner).toBe(renewal.successor_session_id)
  expect(f.sessions.get(renewal.previous_session_id)?.archived).toBe(false)
  await f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())

  const reopenedRepository = new TaskRepository(f.repository.path, f.root)
  const reopenedStore = new RunnerStore(reopenedRepository)
  const reopened = new TaskRuntime(reopenedStore, f.host, "project", undefined, {
    autoResumeInterrupted: false,
    architectIdleWindowMs: 1_000,
    architectPromptHook: true,
    now: () => now,
  })
  cleanup.push(() => {
    void reopened.stop()
    reopenedRepository.close()
  })
  await reopened.tick()

  expect(reopenedStore.architectRenewal(renewal.id)?.state).toBe("committed")
  expect(JSON.parse(reopenedStore.architectRenewal(renewal.id)!.continuity_json!)).toEqual({
    revision: 1,
    decisions: ["Keep the existing approved implementation direction."],
    unresolvedQuestions: ["Confirm whether the follow-up needs additional scope."],
  })
  expect(reopenedStore.architectContinuity(renewal.successor_session_id)).toMatchObject({
    revision: 1,
    decisions: JSON.stringify(["Keep the existing approved implementation direction."]),
    unresolved_questions: JSON.stringify(["Confirm whether the follow-up needs additional scope."]),
  })
  expect(reopenedStore.plan(plan.id)?.owner).toBe(renewal.successor_session_id)
  expect(f.sessions.get(renewal.previous_session_id)?.archived).toBe(true)
  expect(reopenedStore.attempts(plan.id)[0]?.session_id).toBe(attempt.session_id)
  expect(f.sessions.get(attempt.session_id)?.busy).toBe(true)
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(1)
  expect(f.notifications).toHaveLength(1)
})

test("a reopened two-scheduler runtime archives only after durable transfer and reconciles queued input", async () => {
  const now = 2_000_000_450_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const schedulerOwner = f.runtime.owner
  const fence = f.store.claim(schedulerOwner, now)!
  const plan = f.store.plan(f.receipt.planID)!
  const predecessor = f.sessions.get(plan.owner)!
  const renewal = f.store.beginArchitectRenewal({
    schedulerOwner,
    fence,
    anchorPlanID: plan.id,
    previousSessionID: predecessor.id,
    directory: predecessor.directory,
    model: JSON.stringify(predecessor.model),
    idleAt: predecessor.idleAt!,
    now,
    handoffMessageID: "unsupported-hook-handoff",
  })!
  await f.host.createArchitect({
    id: renewal.successor_session_id,
    parentID: predecessor.id,
    directory: renewal.directory,
    model: JSON.parse(renewal.model),
    title: "LAZERS · unsupported-hook case",
    planID: plan.id,
    planIDs: [plan.id],
    sourceSessionID: predecessor.id,
  })
  const payload = {
    status: "architect-handoff",
    planID: plan.id,
    version: plan.version + 1,
    planIDs: [plan.id],
    label: "unsupported-hook case",
    predecessorSessionID: predecessor.id,
    successorSessionID: renewal.successor_session_id,
  }
  const metadata = {
    lazersKind: "runner-outcome",
    lazersProjectID: "project",
    lazersProjectDirectory: f.root,
    lazersPlanID: plan.id,
    lazersOutboxID: "unsupported-hook-outbox",
    lazersMessageID: renewal.handoff_message_id,
    lazersSessionID: renewal.successor_session_id,
    lazersStatus: "architect-handoff",
    lazersVersion: plan.version + 1,
  }
  expect(
    f.store.transferArchitectRenewal({
      schedulerOwner,
      fence,
      renewalID: renewal.id,
      outboxID: "unsupported-hook-outbox",
      payload: JSON.stringify(payload),
      metadata: JSON.stringify(metadata),
    }),
  ).toBe(true)
  const foreign = {
    id: "msg_synthetic_during_process_restart",
    type: "synthetic",
    delivery: "queue",
    metadata: { source: "another-plugin" },
  }
  f.inbox.set(predecessor.id, [foreign])
  await f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())

  const reopenedRepository = new TaskRepository(f.repository.path, f.root)
  const reopenedStore = new RunnerStore(reopenedRepository)
  const first = new TaskRuntime(reopenedStore, f.host, "project", undefined, {
    autoResumeInterrupted: false,
    architectIdleWindowMs: 1_000,
    architectPromptHook: true,
    now: () => now,
  })
  const second = new TaskRuntime(reopenedStore, f.host, "project", undefined, {
    autoResumeInterrupted: false,
    architectIdleWindowMs: 1_000,
    architectPromptHook: true,
    now: () => now,
  })
  cleanup.push(() => {
    void first.stop()
    void second.stop()
    reopenedRepository.close()
  })

  await Promise.all([first.tick(), second.tick()])

  expect(reopenedStore.architectRenewal(renewal.id)?.state).toBe("committed")
  expect(JSON.parse(reopenedStore.architectRenewal(renewal.id)!.continuity_json!)).toEqual({
    revision: 1,
    decisions: ["Keep the existing approved implementation direction."],
    unresolvedQuestions: ["Confirm whether the follow-up needs additional scope."],
  })
  expect(reopenedStore.plan(plan.id)?.owner).toBe(renewal.successor_session_id)
  expect(predecessor.archived).toBe(true)
  expect(f.events.filter((event) => event === "update-session:owner:true")).toHaveLength(1)
  expect(f.inbox.get(predecessor.id)).toEqual([foreign])
  expect(reopenedStore.architectRenewalHasInput(renewal.id)).toBe(true)
  expect(reopenedStore.architectSourceInputs(predecessor.id)).toContainEqual(
    expect.objectContaining({ message_id: foreign.id, disposition: "pending" }),
  )
  expect(
    f.notifications.some((notification) =>
      notification.text.includes("LAZERS Architect source changed"),
    ),
  ).toBe(false)
  expect(f.notifications.some((notification) => notification.text.includes(foreign.id))).toBe(false)
})

test("concurrent plan admission joins the fixed successor and survives two-scheduler reopen", async () => {
  const now = 2_000_000_530_000
  const f = fixture({
    shared: true,
    delayed: true,
    independent: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "concurrent-admission.txt" }],
  })
  const attempt = await prepareIdleArchitect(f, now, 1_000)
  const peer = new TaskRuntime(f.store, f.host, "project", undefined, {
    autoResumeInterrupted: false,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
  })
  cleanup.push(() => void peer.stop())
  let signalCreated!: () => void
  let releaseCreate!: () => void
  const created = new Promise<void>((resolve) => (signalCreated = resolve))
  const createGate = new Promise<void>((resolve) => (releaseCreate = resolve))
  const nativeCreate = f.host.createArchitect
  f.host.createArchitect = async (input) => {
    await nativeCreate(input)
    signalCreated()
    await createGate
  }
  let failArchive = true
  const nativeUpdate = f.host.updateSession!
  f.host.updateSession = async (input) => {
    if (input.sessionID === "owner" && input.archived && failArchive) {
      failArchive = false
      throw new Error("hold transfer for reopen")
    }
    await nativeUpdate(input)
  }

  const tick = f.runtime.tick()
  await created
  const lateTask = f.createTask("late", "late-concurrent-plan.txt")
  const lateReceipt = f.store.submit(
    f.inputFor([lateTask], { requestID: "late-plan-during-successor-create" }),
    "owner",
  )
  await peer.tick()
  releaseCreate()
  await tick

  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("archiving")
  expect(f.store.architectRenewalForPlan(lateReceipt.planID)?.id).toBe(renewal.id)
  expect(f.store.plan(f.receipt.planID)?.owner).toBe(renewal.successor_session_id)
  expect(f.store.plan(lateReceipt.planID)?.owner).toBe(renewal.successor_session_id)
  const handoff = f.store.atomic((db) =>
    db
      .query<{ payload: string }, [string]>("SELECT payload FROM runner_outbox WHERE id=?")
      .get(renewal.handoff_outbox_id!)!,
  )
  const handoffPayload = JSON.parse(handoff.payload)
  expect(handoffPayload.planIDs).toContain(lateReceipt.planID)
  expect(handoffPayload.planVersions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ planID: f.receipt.planID }),
      expect.objectContaining({ planID: lateReceipt.planID }),
    ]),
  )
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(1)

  await f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopenedRepository = new TaskRepository(f.repository.path, f.root)
  const reopenedStore = new RunnerStore(reopenedRepository)
  const reopenedA = new TaskRuntime(reopenedStore, f.host, "project", undefined, {
    autoResumeInterrupted: false,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
  })
  const reopenedB = new TaskRuntime(reopenedStore, f.host, "project", undefined, {
    autoResumeInterrupted: false,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
  })
  cleanup.unshift(() => {
    void reopenedA.stop()
    void reopenedB.stop()
    reopenedRepository.close()
  })
  await Promise.all([reopenedA.tick(), reopenedB.tick()])

  expect(reopenedStore.architectRenewal(renewal.id)?.state).toBe("committed")
  expect(reopenedStore.plan(f.receipt.planID)?.owner).toBe(renewal.successor_session_id)
  expect(reopenedStore.plan(lateReceipt.planID)?.owner).toBe(renewal.successor_session_id)
  expect(f.sessions.get("owner")?.archived).toBe(true)
  expect(f.sessions.get(attempt.session_id)?.busy).toBe(true)
  expect(reopenedStore.attempts(f.receipt.planID)[0]?.session_id).toBe(attempt.session_id)
  expect(f.events.filter((event) => event.startsWith("create-architect:")).length).toBe(1)
})

test("Auditor dispatch retains its role and selected model and waits for Architect review", async () => {
  const model = { providerID: "opencode-go", id: "muse-spark-1.3-contributor" }
  const f = fixture({
    shared: true,
    missingEvidence: true,
    workerAgent: "auditor",
    personas: ["systems"],
  })
  const requested: unknown[] = []
  f.host.workerModel = async (agent) => {
    requested.push(agent)
    return model
  }
  await f.runtime.command(
    { requestID: "audit-run", planID: f.receipt.planID, action: "run" },
    "owner",
  )
  await drive(f.runtime)
  expect(requested).toContain("auditor")
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  expect(f.sessions.get(attempt.session_id)!.agent).toBe("auditor")
  expect(JSON.parse(attempt.policy)).toMatchObject({ agent: "auditor", model })
  expect(f.store.plan(f.receipt.planID)!.state).toBe("blocked")
  expect(f.store.plan(f.receipt.planID)!.reason).toContain("correct:evidence/never-produced.md")
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
})

test("archived owners leave unresolved plans with a durable wake even after their outcome was consumed", async () => {
  const f = fixture({
    fail: true,
    shared: true,
    commit: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await runPlan(f)
  await drive(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
  // The old Architect read the failure but retired before resolving it.
  f.store.atomic((db) =>
    db.query("UPDATE runner_outbox SET state='consumed' WHERE plan_id=?").run(f.receipt.planID),
  )
  f.inbox.set("owner", [])
  f.sessions.get("owner")!.archived = true
  const attempts = f.store.attempts(f.receipt.planID).map((attempt) => attempt.id)
  await f.runtime.stop()
  f.store.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const reopened = new TaskRuntime(f.store, f.host, "project", undefined, {
    autoResumeInterrupted: false,
  })
  try {
    await drive(reopened, 3)
    const owner = f.store.plan(f.receipt.planID)!.owner
    expect(owner).not.toBe("owner")
    const wakes = f.inbox.get(owner) ?? []
    expect(wakes).toHaveLength(1)
    expect(f.notifications.find((notice) => notice.id === wakes[0]!.id)?.resume).toBe(true)
    expect(f.store.attempts(f.receipt.planID).map((attempt) => attempt.id)).toEqual(attempts)
    await drive(reopened, 3)
    expect(f.inbox.get(owner)).toHaveLength(1)
  } finally {
    await reopened.stop()
  }
})

test("an authoritatively missing worker releases its reservation without deleting partial work", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "shared.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const old = f.store.attempts(f.receipt.planID)[0]!
  const partial = join(old.workspace, "shared.txt")
  writeFileSync(partial, "partial work")
  const task = f.createTask("b", "shared.txt")
  const next = f.store.submit(f.inputFor([task], { requestID: "after-missing-worker" }), "owner")
  await runPlan(f, next.planID, "run-after-missing-worker")
  f.sessions.delete(old.session_id)
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("failed")
  expect(f.store.nodes(f.receipt.planID)[0]?.state).toBe("failed")
  expect(f.store.attempts(next.planID)[0]?.state).toBe("running")
  expect(readFileSync(partial, "utf8")).toBe("partial work")
})

test("a tick that holds notices schedules a short retry, not the full interval", async () => {
  const delays: (number | undefined)[] = []
  const f = fixture({ wakeScheduler: undefined })
  ;(f.runtime as unknown as { wakeScheduler: (delay?: number) => void }).wakeScheduler = (delay) =>
    delays.push(delay)
  const { ids, emit } = architectBacklog(f, 1)
  emit(ids[0]!, { status: "blocked", reason: "x" })
  f.host.notify = async () => {
    throw new Error("native inbox unavailable")
  }
  await f.runtime.tick()
  expect(delays).toContain(15_000)
})

test("a tick that loses the lease returns when the lease lapses", async () => {
  const delays: (number | undefined)[] = []
  const f = fixture()
  ;(f.runtime as unknown as { wakeScheduler: (delay?: number) => void }).wakeScheduler = (delay) =>
    delays.push(delay)
  f.store.atomic((db) =>
    db
      .query("INSERT OR REPLACE INTO runner_leases VALUES(?,?,?,?)")
      .run(f.repository.projectDirectory, "another-process", 99, Date.now() + 10_000),
  )
  await f.runtime.tick()
  expect(delays).toHaveLength(1)
  expect(delays[0]!).toBeGreaterThanOrEqual(1_000)
  expect(delays[0]!).toBeLessThanOrEqual(11_000)
})

test("a command applies without a version and a legacy expectedVersion is ignored", async () => {
  const f = fixture()
  const planID = f.receipt.planID
  const receipt = await f.runtime.command(
    { requestID: "legacy-run", planID, action: "run", expectedVersion: 99 },
    "owner",
  )
  expect(receipt).toMatchObject({ status: "running" })
  expect(f.store.plan(planID)?.state).toBe("running")
})

test("a replay matches a receipt recorded with the legacy expectedVersion", async () => {
  const f = fixture()
  const planID = f.receipt.planID
  const command = { requestID: "audit-legacy-receipt", planID, action: "audit" as const }
  const receipt = await f.runtime.command(command, "owner")
  const version = f.store.plan(planID)!.version
  // Rewrite the stored fingerprint as the pre-change runtime wrote it.
  f.store.atomic((db) =>
    db
      .query("UPDATE runner_commands SET fingerprint=? WHERE request_id=?")
      .run(
        fingerprint({ command: { ...command, expectedVersion: version }, caller: "owner" }),
        command.requestID,
      ),
  )
  expect(await f.runtime.command(command, "owner")).toEqual(receipt)
  expect(await f.runtime.command({ ...command, expectedVersion: version }, "owner")).toEqual(
    receipt,
  )
  await expect(
    f.runtime.command({ ...command, reason: "different payload" }, "owner"),
  ).rejects.toThrow("Request identity conflict")
})

test("a plan that keeps moving mid-command fails after a bounded re-evaluation with its state", async () => {
  const f = fixture()
  const planID = f.receipt.planID
  await runPlan(f, planID, "run-moving")
  const original = f.host.session
  let reads = 0
  f.host.session = async (id, options) => {
    if (id === "owner") {
      reads++
      f.store.atomic((db) =>
        db.query("UPDATE runner_plans SET version=version+1 WHERE id=?").run(planID),
      )
    }
    return original(id, options)
  }
  await expect(
    f.runtime.command({ requestID: "moving-pause", planID, action: "pause", reason: "x" }, "owner"),
  ).rejects.toThrow("changed repeatedly while pause was applied")
  expect(reads).toBeLessThanOrEqual(6)
})
