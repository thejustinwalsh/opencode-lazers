import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { git } from "./artifacts.ts"
import { settleVerification } from "../../test/runner/verification-driver.ts"
import {
  cancelRunningPlan,
  countTransitions,
  drive,
  fixture,
  idleCancelFixture,
  runPlan,
  useRuntimeFixtureCleanup,
} from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

test("heartbeat avoids context and rechecks a stopped worker after detailed accounting", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  const original = f.host.session
  const calls: { id: string; messages: boolean }[] = []
  let firstFinalRead = true
  f.host.session = async (id, options) => {
    calls.push({ id, messages: options?.messages === true })
    const session = await original(id, options)
    if (session && options?.messages) {
      session.tools = 9
      if (id === attempt.session_id && firstFinalRead) {
        firstFinalRead = false
        session.busy = true
        session.outcome = undefined
      }
    }
    return session
  }

  const worker = f.sessions.get(attempt.session_id)!
  worker.busy = false
  worker.outcome = "succeeded"
  worker.turn = { inputID: attempt.message_id, state: "completed" }
  await f.runtime.tick()
  expect(calls.find((call) => call.id === attempt.session_id)?.messages).toBe(false)
  expect(calls.some((call) => call.id === attempt.session_id && call.messages)).toBe(true)
  expect(f.store.attempts(f.receipt.planID)[0]!.state).toBe("running")

  await settleVerification(f.runtime)
  expect(f.store.attempts(f.receipt.planID)[0]!.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID)[0]!.tool_count).toBe(9)
})

test.each(["interrupted", "succeeded", "missing"] as const)(
  "cancellation wins over a stale %s detailed worker observation",
  async (result) => {
    const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
    await runPlan(f)
    await f.runtime.tick()
    const planID = f.receipt.planID
    const attempt = f.store.attempts(planID)[0]!
    const worker = f.sessions.get(attempt.session_id)!
    worker.busy = false
    worker.outcome = result === "succeeded" ? "succeeded" : "interrupted"
    worker.turn = { inputID: attempt.message_id, state: "interrupted" }
    const originalSession = f.host.session
    let raced = false
    f.host.session = async (id, options) => {
      const snapshot = await originalSession(id, options)
      if (id === worker.id && options?.messages && !raced) {
        raced = true
        await f.runtime.command(
          {
            requestID: `cancel-during-${result}-detail`,
            planID,
            action: "cancel",
          },
          "owner",
        )
        return result === "missing" ? null : snapshot
      }
      return snapshot
    }

    const prompts = f.events.filter((event) => event.startsWith("prompt:")).length
    await f.runtime.tick()
    expect(raced).toBe(true)
    expect(f.store.plan(planID)?.state).toBe("cancelled")
    expect(f.store.attempts(planID)).toHaveLength(1)
    expect(f.store.attempts(planID)[0]).toMatchObject({
      id: attempt.id,
      state: "cancelled",
      session_id: attempt.session_id,
      workspace: attempt.workspace,
    })
    expect(existsSync(attempt.workspace)).toBe(true)
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(prompts)
    expect(f.store.effects(planID).some((effect) => effect.kind.startsWith("verify:"))).toBe(false)
  },
)

test("terminal verification waits for active foreground, exact input completion, and live background activity", async () => {
  const f = fixture({ delayed: true, repair: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  const originalSession = f.host.session
  const baseHead = git(f.root, ["rev-parse", "HEAD"])

  // A stale succeeded value after prompt admission cannot outrank the current native handle.
  worker.outcome = "succeeded"
  worker.turn = { inputID: "msg_historical", state: "completed" }
  expect(worker.busy).toBe(true)
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(false)
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(baseHead)

  // The foreground becomes active after the quiet heartbeat but during the detail read.
  worker.busy = false
  worker.turn = { inputID: attempt.message_id, state: "completed" }

  let raced = false
  f.host.session = async (id, options) => {
    const session = await originalSession(id, options)
    if (id === attempt.session_id && options?.messages && !raced && session) {
      raced = true
      worker.busy = true
      return { ...session, busy: true, observationUnstable: true, outcome: "succeeded" }
    }
    return session
  }
  await f.runtime.tick()
  expect(raced).toBe(true)
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(false)
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(baseHead)

  f.host.session = originalSession
  worker.busy = false
  worker.outcome = "succeeded"
  worker.turn = { inputID: attempt.message_id, state: "pending" }
  await f.runtime.tick()
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(false)

  worker.turn = { inputID: attempt.message_id, state: "completed" }
  worker.runningShells = 1
  worker.activeChildren = 1
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
  expect(f.store.plan(f.receipt.planID)?.reason).toContain(
    "Worker has 1 running shell(s) and 1 active child session(s)",
  )
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(false)
  expect(git(f.root, ["rev-parse", "HEAD"])).toBe(baseHead)
  expect(
    f.store.latestTransition<{ background: unknown }>(
      f.receipt.planID,
      attempt.task_id,
      "WORKER_BACKGROUND_WAIT",
    )?.background,
  ).toEqual({ runningShells: 1, activeChildren: 1 })

  // The hold clears on the next tick once the host observes no live activity.
  worker.runningShells = 0
  worker.activeChildren = 0
  await settleVerification(f.runtime)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(true)
})

test.each(["failed", "interrupted"] as const)(
  "background hold avoids repeated context for %s while preserving interruption evidence",
  async (outcome) => {
    const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
    await runPlan(f)
    await f.runtime.tick()
    const attempt = f.store.attempts(f.receipt.planID)[0]!
    const worker = f.sessions.get(attempt.session_id)!
    worker.busy = false
    worker.outcome = outcome
    worker.idleAt = 1234
    worker.runningShells = 1
    const original = f.host.session
    let freshReads = 0
    let detailedReads = 0
    f.host.session = async (id, options) => {
      if (id === attempt.session_id) {
        if (options?.messages) detailedReads++
        else freshReads++
      }
      return original(id, options)
    }
    await f.runtime.tick()
    await f.runtime.tick()
    expect(freshReads).toBe(2)
    expect(detailedReads).toBe(outcome === "interrupted" ? 2 : 1)
    expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
    expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
    expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
    expect(
      f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
    ).toBe(false)
    const stopped = f.store.latestTransition<{ outcome: string }>(
      f.receipt.planID,
      attempt.task_id,
      "WORKER_STOPPED",
    )
    expect(stopped?.outcome).toBe(outcome)
  },
)

test("worker-location permissions and forms block terminal work and surface actionable diagnostics", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const attempt = f.store.attempts(planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  worker.busy = false
  worker.outcome = "succeeded"
  worker.turn = { inputID: attempt.message_id, state: "completed" }
  worker.pendingInput = false
  worker.pendingPermissions = 1
  worker.pendingForms = 1

  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("blocked")
  expect(f.store.plan(planID)?.reason).toContain(`Worker at ${worker.directory}`)
  expect(f.store.plan(planID)?.reason).toContain("1 pending permission request(s)")
  expect(f.store.plan(planID)?.reason).toContain("1 pending form(s)")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]?.state).toBe("running")
  expect(f.store.effects(planID).some((effect) => effect.kind.startsWith("verify:"))).toBe(false)
  expect(
    f.store.latestTransition<{
      workspace: string
      directory: string
      pendingPermissions: number
      pendingForms: number
    }>(planID, attempt.task_id, "WORKER_APPROVAL_WAIT"),
  ).toMatchObject({
    workspace: attempt.workspace,
    directory: worker.directory,
    pendingPermissions: 1,
    pendingForms: 1,
  })

  worker.pendingPermissions = 0
  worker.pendingForms = 0
  await settleVerification(f.runtime)
  expect(f.store.plan(planID)?.state).toBe("accepted")
  expect(f.store.attempts(planID)).toHaveLength(1)
})

test("fresh zero approvals clear an approval-only hold while the same worker remains busy without churn", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const attempt = f.store.attempts(planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  worker.pendingInput = false
  worker.pendingPermissions = 1
  worker.pendingForms = 0

  await f.runtime.tick()
  const blocked = f.store.plan(planID)!
  expect(blocked.state).toBe("blocked")
  expect(blocked.reason).toContain("1 pending permission request(s)")
  const before = f.store.attempts(planID)[0]!
  const workerMessages = structuredClone(worker.messages)
  const workerTurn = structuredClone(worker.turn)
  const workerRoute = structuredClone(worker.model)
  const workerEvents = f.events.filter((event) => /^(create|prompt|start|stop):/.test(event))
  const count = (event: string) =>
    f.store.atomic(
      (db) =>
        db
          .query<{ count: number }, [string, string]>(
            "SELECT COUNT(*) AS count FROM runner_transitions WHERE plan_id=? AND event=?",
          )
          .get(planID, event)?.count ?? 0,
    )
  const settledBefore = count("WORKER_OBSERVATION_SETTLED")

  worker.pendingPermissions = 0
  worker.pendingForms = 0
  await f.runtime.tick()

  const resumed = f.store.plan(planID)!
  expect(resumed.state).toBe("running")
  expect(resumed.reason).toBeNull()
  expect(resumed.version).toBe(blocked.version + 1)
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]).toMatchObject({
    id: before.id,
    state: "running",
    session_id: before.session_id,
    message_id: before.message_id,
    workspace: before.workspace,
    policy: before.policy,
    artifact: before.artifact,
    token_count: before.token_count,
    tool_count: before.tool_count,
    cost: before.cost,
  })
  expect(worker.id).toBe(attempt.session_id)
  expect(worker.busy).toBe(true)
  expect(worker.messages).toEqual(workerMessages)
  expect(worker.turn).toEqual(workerTurn)
  expect(worker.model).toEqual(workerRoute)
  expect(f.events.filter((event) => /^(create|prompt|start|stop):/.test(event))).toEqual(
    workerEvents,
  )
  expect(f.store.effects(planID).some((effect) => effect.kind.startsWith("verify:"))).toBe(false)
  expect(count("WORKER_OBSERVATION_SETTLED")).toBe(settledBefore + 1)
  expect(count("WORKER_APPROVAL_WAIT")).toBe(1)
  const notificationsAfterClear = f.notifications.length
  const versionAfterClear = resumed.version

  await f.runtime.tick()

  expect(f.store.plan(planID)?.version).toBe(versionAfterClear)
  expect(count("WORKER_OBSERVATION_SETTLED")).toBe(settledBefore + 1)
  expect(count("WORKER_APPROVAL_WAIT")).toBe(1)
  expect(f.notifications).toHaveLength(notificationsAfterClear)
  expect(f.store.attempts(planID)[0]).toMatchObject({
    id: before.id,
    session_id: before.session_id,
    message_id: before.message_id,
    policy: before.policy,
    token_count: before.token_count,
    tool_count: before.tool_count,
    cost: before.cost,
    artifact: before.artifact,
  })
})

test.each([
  "missing-permissions",
  "missing-forms",
  "unstable",
  "foreign-worker",
  "changed-route",
  "unrelated-hold",
] as const)("fresh zero approvals do not clear %s", async (condition) => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const attempt = f.store.attempts(planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  worker.pendingInput = false
  worker.pendingPermissions = 1
  worker.pendingForms = 0
  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("blocked")
  const blocked = f.store.plan(planID)!

  worker.pendingPermissions = 0
  worker.pendingForms = 0
  if (condition === "missing-permissions") delete worker.pendingPermissions
  if (condition === "missing-forms") delete worker.pendingForms
  if (condition === "unstable") worker.observationUnstable = true
  if (condition === "foreign-worker")
    worker.metadata = { ...worker.metadata, lazersAttemptID: "foreign-attempt" }
  if (condition === "changed-route") worker.model = { ...worker.model!, id: "foreign-model" }
  if (condition === "unrelated-hold")
    f.store.atomic((db) =>
      db
        .query("UPDATE runner_plans SET reason='Review found a concrete defect' WHERE id=?")
        .run(planID),
    )

  await f.runtime.tick()

  const current = f.store.plan(planID)!
  expect(current.state).toBe("blocked")
  expect(current.version).toBe(blocked.version)
  if (condition === "unrelated-hold") expect(current.reason).toBe("Review found a concrete defect")
  else expect(current.reason).toBe(blocked.reason)
  expect(f.store.latestTransition(planID, null, "WORKER_OBSERVATION_SETTLED")).toBeUndefined()
})

test.each(["reconcile", "cancel", "reassign"] as const)(
  "deferred pre-%s approval observations cannot override concurrent control",
  async (action) => {
    const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
    await runPlan(f)
    await f.runtime.tick()
    const planID = f.receipt.planID
    const attempt = f.store.attempts(planID)[0]!
    const worker = f.sessions.get(attempt.session_id)!
    worker.pendingInput = false
    worker.pendingPermissions = 0
    worker.pendingForms = 0

    if (action === "reconcile") {
      worker.pendingPermissions = 1
      await f.runtime.tick()
      expect(f.store.plan(planID)?.state).toBe("blocked")
      worker.pendingPermissions = 0
    }

    const staleObservation = {
      ...structuredClone(worker),
      pendingPermissions: 1,
      pendingForms: 0,
    }
    let release!: () => void
    let entered!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const readStarted = new Promise<void>((resolve) => {
      entered = resolve
    })
    const originalSession = f.host.session
    let deferred = true
    f.host.session = async (sessionID, options) => {
      if (sessionID === attempt.session_id && deferred) {
        deferred = false
        entered()
        await barrier
        return structuredClone(staleObservation)
      }
      return originalSession(sessionID, options)
    }

    const priorBlockedEvents = f.store.atomic(
      (db) =>
        db
          .query<{ count: number }, [string, string]>(
            "SELECT COUNT(*) AS count FROM runner_transitions WHERE plan_id=? AND event=?",
          )
          .get(planID, "BLOCKED")?.count ?? 0,
    )
    const planVersion = f.store.plan(planID)!.version
    const tick = f.runtime.tick()
    await readStarted
    const owner2 = structuredClone(f.sessions.get("owner")!)
    owner2.id = "owner-2"
    f.sessions.set(owner2.id, owner2)

    let result: { status: string; version: number }
    try {
      result = (await f.runtime.command(
        {
          requestID: `approval-race-${action}`,
          planID,
          action,
          ...(action === "reassign" ? { targetSessionID: owner2.id } : {}),
          ...(action === "cancel" ? { reason: "Cancel during worker approval observation" } : {}),
        },
        "owner",
      )) as { status: string; version: number }
    } finally {
      release()
    }
    await tick

    const current = f.store.plan(planID)!
    expect(
      f.store.atomic(
        (db) =>
          db
            .query<{ count: number }, [string, string]>(
              "SELECT COUNT(*) AS count FROM runner_transitions WHERE plan_id=? AND event=?",
            )
            .get(planID, "BLOCKED")?.count ?? 0,
      ),
    ).toBe(priorBlockedEvents)
    expect(
      f.store.atomic(
        (db) =>
          db
            .query<{ count: number }, [string, string]>(
              "SELECT COUNT(*) AS count FROM runner_transitions WHERE plan_id=? AND event=?",
            )
            .get(planID, "WORKER_APPROVAL_WAIT")?.count ?? 0,
      ),
    ).toBe(action === "reconcile" ? 1 : 0)

    if (action === "reconcile") {
      expect(result.status).toBe("reconciling")
      expect(current).toMatchObject({ state: "running", reason: null, version: result.version })
      worker.pendingPermissions = 1
      await f.runtime.tick()
      expect(f.store.plan(planID)).toMatchObject({
        state: "blocked",
        reason: expect.stringContaining("1 pending permission request(s)"),
        version: result.version + 1,
      })
    } else if (action === "reassign") {
      expect(result.status).toBe("reassigned")
      expect(current).toMatchObject({ state: "running", owner: owner2.id, version: result.version })
    } else {
      expect(result.status).toBe("cancelling")
      expect(["cancelling", "cancelled"]).toContain(current.state)
      expect(current.state).not.toBe("blocked")
    }
  },
)

test("a durably admitted same-attempt handoff reminder can finish with fresh matching evidence", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  const claim = f.runtime.progress.claimReminder(
    attempt.session_id,
    "Provide the remaining handoff",
    "msg_owned_final_handoff",
  )!
  expect(claim).toBeDefined()
  f.runtime.progress.finishReminder(claim, "admitted")
  worker.busy = false
  worker.outcome = "succeeded"
  worker.turn = { inputID: claim.messageID, state: "completed" }

  await drive(f.runtime, 10)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
})

test("a contradicted active entry counts as idle: cancel finishes and the diagnostic is recorded once", async () => {
  const f = fixture({ shared: true, delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  // The host lists the session active, but interrupt has nothing to stop and the
  // last turn is complete: the native adapter reports it idle with a stale marker.
  f.completeWorker(attempt.session_id, "interrupted")
  f.sessions.get(attempt.session_id)!.staleActive = { cause: "completed-turn" }
  await cancelRunningPlan(f, "cancel-stale-active")
  for (let tick = 0; tick < 4; tick++) await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelled")
  expect(countTransitions(f, f.receipt.planID, "HOST_ACTIVE_STALE")).toBe(1)
})

test("a turn with no progress past the window is interrupted exactly once", async () => {
  let clock = 1_000_000
  const f = fixture({
    shared: true,
    delayed: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
    now: () => clock,
    workerNoProgressWindowMs: 60_000,
  })
  await runPlan(f)
  const interrupts: string[] = []
  f.host.interrupt = async (id) => {
    interrupts.push(id)
  }
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  expect(f.sessions.get(attempt.session_id)?.busy).toBe(true)
  await f.runtime.tick()
  clock += 59_000
  await f.runtime.tick()
  expect(interrupts).toEqual([])
  clock += 2_000
  await f.runtime.tick()
  expect(interrupts).toEqual([attempt.session_id])
  clock += 600_000
  await f.runtime.tick()
  await f.runtime.tick()
  expect(interrupts).toEqual([attempt.session_id])
  expect(countTransitions(f, f.receipt.planID, "WORKER_NO_PROGRESS_INTERRUPT")).toBe(1)
})

test("cancelling a never-idle worker finishes within its bounded wait and preserves the worktree", async () => {
  let clock = 1_000_000
  const f = fixture({
    shared: false,
    delayed: true,
    taskFiles: [{ name: "a", path: "a.txt" }],
    now: () => clock,
    workerNoProgressWindowMs: 0,
    cancelIdleWaitMs: 30_000,
  })
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  let interrupts = 0
  f.host.interrupt = async () => {
    interrupts++
  }
  await cancelRunningPlan(f, "cancel-never-idle")
  await f.runtime.tick()
  clock += 10_000
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelling")
  clock += 21_000
  await f.runtime.tick()
  await f.runtime.tick()
  expect(interrupts).toBeGreaterThanOrEqual(2)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelled")
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("cancelled")
  expect(existsSync(attempt.workspace)).toBe(true)
  expect(countTransitions(f, f.receipt.planID, "WORKER_CANCEL_WITHOUT_IDLE")).toBe(1)
})

test("cancelling an archived worker settles it at once and preserves the worktree", async () => {
  const clock = { now: 1_000_000 }
  const { f, attempt, session } = await idleCancelFixture(clock)
  session.archived = true
  session.busy = false
  // The native success belongs to a different input: without the archive rule this waits forever.
  session.turn = { inputID: "msg_other", state: "completed" }
  await cancelRunningPlan(f, "cancel-archived")
  for (let tick = 0; tick < 4; tick++) await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelled")
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("cancelled")
  expect(existsSync(attempt.workspace)).toBe(true)
  expect(countTransitions(f, f.receipt.planID, "CANCEL_WORKER_ARCHIVED")).toBe(1)
})

test("a stuck uncertain effect is superseded after the bounded wait and the cancel completes", async () => {
  const clock = { now: 1_000_000 }
  const { f, attempt, session } = await idleCancelFixture(clock)
  session.archived = true
  f.store.atomic((db) =>
    db
      .query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'uncertain',?,?,0)")
      .run("stuck-effect", f.receipt.planID, attempt.task_id, attempt.id, "session", "{}", null),
  )
  await cancelRunningPlan(f, "cancel-uncertain")
  await f.runtime.tick()
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelling")
  clock.now += 31_000
  for (let tick = 0; tick < 3; tick++) await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelled")
  const effect = f.store.effects(f.receipt.planID).find((row) => row.id === "stuck-effect")!
  expect(effect.state).toBe("failed")
  expect(JSON.parse(effect.receipt!)).toMatchObject({ superseded: true })
  expect(countTransitions(f, f.receipt.planID, "EFFECT_SUPERSEDED")).toBe(1)
  expect(countTransitions(f, f.receipt.planID, "CANCEL_WAIT")).toBe(1)
})

test.each([
  ["observation-unstable", true],
  ["turn-input-mismatch", true],
  ["background-activity", true],
  ["pending-input", false],
  ["pending-approval", false],
] as const)(
  "a cancel waiting on %s records the reason once across ticks (bounded: %s)",
  async (cause, bounded) => {
    const clock = { now: 1_000_000 }
    const { f, session } = await idleCancelFixture(clock)
    if (cause === "observation-unstable") session.observationUnstable = true
    if (cause === "turn-input-mismatch") session.turn = { inputID: "msg_other", state: "completed" }
    if (cause === "background-activity") session.runningShells = 1
    if (cause === "pending-input") session.pendingInput = true
    if (cause === "pending-approval") session.pendingPermissions = 1
    await cancelRunningPlan(f, `cancel-${cause}`)
    const waits = () =>
      f.repository.read((db) =>
        db
          .query<{ payload: string }, [string]>(
            "SELECT payload FROM runner_transitions WHERE plan_id=? AND event='CANCEL_WAIT' ORDER BY id",
          )
          .all(f.receipt.planID)
          .map((row) => JSON.parse(row.payload) as { cause: string }),
      )
    for (let tick = 0; tick < 4; tick++) await f.runtime.tick()
    expect(waits().map((wait) => wait.cause)).toEqual([cause])
    expect(f.store.plan(f.receipt.planID)?.state).toBe("cancelling")
    clock.now += 31_000
    for (let tick = 0; tick < 4; tick++) await f.runtime.tick()
    expect(waits().map((wait) => wait.cause)).toEqual([cause])
    expect(f.store.plan(f.receipt.planID)?.state).toBe(bounded ? "cancelled" : "cancelling")
  },
)

test.each([
  ["cancelled", "cancel"],
  ["integrated", "cancel"],
  ["running", "integrated"],
  ["draft", "integrated"],
  ["integrated", "resume"],
  ["accepted", "retry"],
  ["integrated", "retry"],
] as const)(
  "the plan machine refuses %s plan + %s with its state and options",
  async (state, action) => {
    const f = fixture()
    const planID = f.receipt.planID
    f.store.atomic((db) =>
      db.query("UPDATE runner_plans SET state=? WHERE id=?").run(state, planID),
    )
    const before = f.store.plan(planID)!
    await expect(
      f.runtime.command(
        {
          requestID: `refused-${state}-${action}`,
          planID,
          action,
          taskID: action === "resume" || action === "retry" ? f.tasks[0]!.id : undefined,
          reason: "Not legal from this state",
        },
        "owner",
      ),
    ).rejects.toThrow(`Plan is ${state}; ${action} is not available. Available:`)
    expect(f.store.plan(planID)).toEqual(before)
  },
)
