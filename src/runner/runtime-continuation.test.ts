import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { git } from "./artifacts.ts"
import {
  drive,
  fixture,
  holdFailedAttempt,
  holdInterruptedAttempt,
  reopenRuntime,
  runPlan,
  useRuntimeFixtureCleanup,
} from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

test("an explicit resume continues one process-replaced interrupted attempt without inventing idle proof", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const attempt = f.store.attempts(planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  const originalMessageID = attempt.message_id
  const originalSessionID = attempt.session_id
  const originalWorkspace = attempt.workspace
  const originalBase = attempt.base_commit
  const originalPolicy = attempt.policy
  worker.tokens = 777
  worker.tools = 23
  worker.cost = 2.5
  worker.busy = false
  worker.outcome = "interrupted"
  worker.turn = { inputID: originalMessageID, state: "interrupted" }

  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("blocked")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]).toMatchObject({ id: attempt.id, state: "running" })
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)

  // Reopening the runtime preserves the running attempt and still cannot infer
  // that the retained native process is idle or authorize a continuation.
  await f.runtime.stop()
  let wakes = 0
  const replaced = reopenRuntime(f, undefined, () => wakes++)
  await replaced.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("blocked")
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)

  const resume = {
    requestID: "resume-interrupted-process-replacement",
    planID,
    action: "resume",
    taskID: attempt.task_id,
    attemptID: attempt.id,
    reason: "Explicitly continue the matching interrupted attempt after process replacement",
  }
  const receipt = await replaced.runtime.command(resume, "owner")
  expect(await replaced.runtime.command(resume, "owner")).toEqual(receipt)
  expect(wakes).toBe(1)
  const assigned = f.store.attempts(planID)[0]!
  expect(receipt).toMatchObject({ status: "resuming" })
  expect(assigned).toMatchObject({
    id: attempt.id,
    state: "preparing",
    session_id: originalSessionID,
    workspace: originalWorkspace,
    base_commit: originalBase,
    policy: originalPolicy,
    token_count: 777,
    tool_count: 23,
    cost: 2.5,
  })
  expect(assigned.message_id).not.toBe(originalMessageID)
  const resumed = f.store
    .activity(planID, attempt.task_id)
    .filter((entry) => entry.event === "ATTEMPT_RESUMED")
  expect(resumed).toHaveLength(1)
  expect(JSON.parse(resumed[0]!.payload)).toMatchObject({
    attemptID: attempt.id,
    previousMessageID: originalMessageID,
    messageID: assigned.message_id,
    interruptedInputID: originalMessageID,
    usageRetained: true,
  })
  expect(readFileSync(join(originalWorkspace, "a.txt"), "utf8")).toBe("a")
  expect(git(originalWorkspace, ["status", "--porcelain"])).not.toBe("")

  await replaced.runtime.stop()
  const reopened = reopenRuntime(f)
  expect(await reopened.runtime.command(resume, "owner")).toEqual(receipt)
  await reopened.runtime.tick()
  expect(f.events.filter((event) => event.startsWith("create:")).length).toBe(1)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(2)
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]?.message_id).toBe(assigned.message_id)

  worker.busy = false
  worker.outcome = undefined
  worker.turn = { inputID: assigned.message_id, state: "pending" }
  await reopened.runtime.tick()
  expect(reopened.store.plan(planID)?.state).toBe("running")
  expect(reopened.store.effects(planID).some((effect) => effect.kind.startsWith("verify:"))).toBe(
    false,
  )

  // A delayed pre-resume native observation is ignored, not treated as evidence
  // for or a new hold on the assigned continuation.
  const nativeSession = f.host.session
  f.host.session = async (id, options) => {
    const session = await nativeSession(id, options)
    if (id !== originalSessionID || !session) return session
    return {
      ...session,
      busy: false,
      outcome: "interrupted",
      turn: { inputID: originalMessageID, state: "interrupted" },
    }
  }
  await reopened.runtime.tick()
  expect(reopened.store.plan(planID)?.state).toBe("running")
  expect(reopened.store.effects(planID).some((effect) => effect.kind.startsWith("verify:"))).toBe(
    false,
  )

  f.host.session = nativeSession
  worker.busy = false
  worker.outcome = "succeeded"
  worker.turn = { inputID: assigned.message_id, state: "completed" }

  await drive(reopened.runtime, 8)
  expect(reopened.store.plan(planID)?.state).toBe("accepted")
  expect(reopened.store.attempts(planID)).toHaveLength(1)
  expect(reopened.store.attempts(planID)[0]).toMatchObject({
    id: attempt.id,
    session_id: originalSessionID,
    workspace: originalWorkspace,
    base_commit: originalBase,
    policy: originalPolicy,
    token_count: 777,
    tool_count: 23,
    cost: 2.5,
  })
})

test("manual continuation accepts a real failed outcome only for its completed current assigned input", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const { planID, attempt, worker } = await holdFailedAttempt(f)
  expect(worker.outcome).toBe("failed")
  expect(worker.turn).toEqual({ inputID: attempt.message_id, state: "completed" })
  expect(attempt.state).toBe("failed")
  const stopped = f.store.latestTransition<Record<string, unknown>>(
    planID,
    attempt.task_id,
    "WORKER_STOPPED",
  )
  expect(stopped).toMatchObject({
    attemptID: attempt.id,
    sessionID: attempt.session_id,
    workspace: attempt.workspace,
    outcome: "failed",
    inputID: attempt.message_id,
  })
  const blocked = f.store.latestTransition<{ workerObservation?: Record<string, unknown> }>(
    planID,
    null,
    "BLOCKED",
  )
  expect(blocked?.workerObservation).toMatchObject({
    kind: "terminal-worker-observation",
    attemptID: attempt.id,
    sessionID: attempt.session_id,
    workspace: attempt.workspace,
    outcome: "failed",
    inputID: attempt.message_id,
    turnState: "completed",
  })
  expect(f.store.plan(planID)?.reason).toContain("Worker failed")

  const receipt = await f.runtime.command(
    {
      requestID: "resume-failed-foreground",
      planID,
      action: "resume",
      taskID: attempt.task_id,
      attemptID: attempt.id,
      reason: "Continue the exact terminal failed foreground input",
    },
    "owner",
  )
  expect(receipt).toMatchObject({ status: "resuming" })
  const resumed = f.store.attempts(planID)[0]!
  expect(resumed).toMatchObject({ id: attempt.id, state: "preparing" })
  expect(resumed.message_id).not.toBe(attempt.message_id)
  const event = f.store
    .activity(planID, attempt.task_id)
    .find((entry) => entry.event === "ATTEMPT_RESUMED")!
  expect(JSON.parse(event.payload)).toMatchObject({
    attemptID: attempt.id,
    previousMessageID: attempt.message_id,
    messageID: resumed.message_id,
    terminalInputID: attempt.message_id,
    terminalOutcome: "failed",
    usageRetained: true,
  })
  expect(JSON.parse(event.payload)).not.toHaveProperty("interruptedInputID")
  expect(worker.outcome).toBe("failed")
  await f.runtime.tick()
  expect(f.events.filter((item) => item.startsWith("prompt:"))).toHaveLength(2)
  expect(f.store.attempts(planID)).toHaveLength(1)
})

test("a failed fresh continuation input is processed", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const { planID, attempt, worker } = await holdInterruptedAttempt(f)
  await f.runtime.command(
    {
      requestID: "resume-before-fresh-terminal-failure",
      planID,
      action: "resume",
      taskID: attempt.task_id,
      attemptID: attempt.id,
      reason: "Continue the same attempt before observing its fresh input",
    },
    "owner",
  )
  await f.runtime.tick()
  const current = f.store.attempts(planID)[0]!
  expect(current.id).toBe(attempt.id)
  expect(current.message_id).not.toBe(attempt.message_id)
  expect(worker.turn).toEqual({ inputID: current.message_id, state: "pending" })

  worker.busy = false
  worker.outcome = "failed"
  worker.turn = { inputID: current.message_id, state: "completed" }
  await f.runtime.tick()

  expect(f.store.plan(planID)?.state).toBe("blocked")
  expect(f.store.plan(planID)?.reason).toContain("Worker failed")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]).toMatchObject({
    id: attempt.id,
    state: "failed",
    message_id: current.message_id,
  })
  expect(
    f.store.latestTransition<Record<string, unknown>>(planID, attempt.task_id, "WORKER_STOPPED"),
  ).toMatchObject({ outcome: "failed", inputID: current.message_id })
  expect(
    f.store.latestTransition<{ workerObservation?: Record<string, unknown> }>(
      planID,
      null,
      "BLOCKED",
    )?.workerObservation,
  ).toMatchObject({ outcome: "failed", inputID: current.message_id, turnState: "completed" })
})

test.each(["permission", "form"] as const)(
  "a current-input %s hold is raised for a resumed attempt",
  async (approval) => {
    const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
    const { planID, attempt, worker } = await holdInterruptedAttempt(f)
    await f.runtime.command(
      {
        requestID: `resume-before-current-${approval}`,
        planID,
        action: "resume",
        taskID: attempt.task_id,
        attemptID: attempt.id,
        reason: "Continue the same attempt before observing a current approval",
      },
      "owner",
    )
    await f.runtime.tick()
    const current = f.store.attempts(planID)[0]!
    expect(worker.turn).toEqual({ inputID: current.message_id, state: "pending" })
    if (approval === "permission") worker.pendingPermissions = 1
    else worker.pendingForms = 1

    await f.runtime.tick()

    expect(f.store.plan(planID)?.state).toBe("blocked")
    expect(f.store.plan(planID)?.reason).toContain(
      approval === "permission" ? "permission request" : "form",
    )
    expect(f.store.attempts(planID)).toHaveLength(1)
    expect(f.store.attempts(planID)[0]?.message_id).toBe(current.message_id)
    expect(
      f.store.latestTransition<Record<string, unknown>>(
        planID,
        attempt.task_id,
        "WORKER_APPROVAL_WAIT",
      ),
    ).toMatchObject({
      attemptID: attempt.id,
      pendingPermissions: approval === "permission" ? 1 : 0,
      pendingForms: approval === "form" ? 1 : 0,
    })
  },
)

test("terminal failed worker with a genuine current-input idle report can resume from failed state", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const attempt = f.store.attempts(planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  worker.busy = false
  worker.outcome = "failed"
  worker.turn = { inputID: attempt.message_id, state: "completed" }

  await f.runtime.tick()

  expect(f.store.plan(planID)?.state).toBe("blocked")
  expect(f.store.nodes(planID)[0]?.state).toBe("failed")
  expect(f.store.attempts(planID)[0]?.state).toBe("failed")
  expect(
    f.store.latestTransition<Record<string, unknown>>(planID, attempt.task_id, "WORKER_STOPPED"),
  ).toMatchObject({ outcome: "failed", inputID: attempt.message_id })
  expect(
    f.store.latestTransition<{ workerObservation?: Record<string, unknown> }>(
      planID,
      null,
      "BLOCKED",
    )?.workerObservation,
  ).toMatchObject({ outcome: "failed", inputID: attempt.message_id, turnState: "completed" })

  const receipt = await f.runtime.command(
    {
      requestID: "resume-failed-with-current-idle",
      planID,
      action: "resume",
      taskID: attempt.task_id,
      attemptID: attempt.id,
      reason: "Continue after the matching terminal failed worker was observed idle",
    },
    "owner",
  )
  expect(receipt).toMatchObject({ status: "resuming" })
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]).toMatchObject({ id: attempt.id, state: "preparing" })
  expect(worker.outcome).toBe("failed")
})

test.each([
  ["a failed turn for a foreign input", "foreign-input"],
  ["a failed turn with no native input ID", null],
] as const)("native continuation rejects %s", async (_label, inputID) => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const { planID, attempt } = await holdFailedAttempt(f, inputID)
  const before = f.store.attempts(planID)[0]!
  await expect(
    f.runtime.command(
      {
        requestID: `resume-failed-invalid-${inputID ?? "missing"}`,
        planID,
        action: "resume",
        taskID: attempt.task_id,
        attemptID: attempt.id,
        reason: "Only the current assigned failed input can continue",
      },
      "owner",
    ),
  ).rejects.toThrow()
  expect(f.store.attempts(planID)[0]).toMatchObject({
    id: before.id,
    state: "failed",
    message_id: before.message_id,
  })
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
})

test.each(["active", "pending-input", "pending-approval", "unstable", "known-background"] as const)(
  "failed-worker continuation rejects a %s native observation",
  async (state) => {
    const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
    const { planID, attempt, worker } = await holdFailedAttempt(f)
    switch (state) {
      case "active":
        worker.busy = true
        break
      case "pending-input":
        worker.pendingInput = true
        break
      case "pending-approval":
        worker.pendingForms = 1
        break
      case "unstable":
        worker.observationUnstable = true
        break
      case "known-background":
        worker.runningShells = 1
        break
    }
    await expect(
      f.runtime.command(
        {
          requestID: `resume-failed-unsafe-${state}`,
          planID,
          action: "resume",
          taskID: attempt.task_id,
          attemptID: attempt.id,
          reason: "Continue only when the current terminal observation remains safe",
        },
        "owner",
      ),
    ).rejects.toThrow()
    expect(f.store.attempts(planID)[0]).toMatchObject({
      id: attempt.id,
      state: "failed",
      message_id: attempt.message_id,
    })
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  },
)

test("a completed turn for another input cannot authorize terminal continuation", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const { planID, attempt, worker } = await holdFailedAttempt(f, "other-input", "succeeded")
  expect(worker.turn).toEqual({ inputID: "other-input", state: "completed" })
  await expect(
    f.runtime.command(
      {
        requestID: "resume-completed-turn-not-failure",
        planID,
        action: "resume",
        taskID: attempt.task_id,
        attemptID: attempt.id,
        reason: "A completed turn for another input does not authorize this assignment",
      },
      "owner",
    ),
  ).rejects.toThrow()
  expect(f.store.attempts(planID)[0]).toMatchObject({ id: attempt.id, state: "running" })
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
})

test.each([
  "wrong-attempt",
  "foreign-worker",
  "archived-worker",
  "route-mismatch",
  "active-worker",
  "pending-input",
  "pending-approval",
  "unstable-observation",
  "input-lineage",
  "known-background",
  "unrelated-hold",
  "uncertain-effect",
] as const)("interrupted continuation rejects %s", async (caseName) => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const { planID, attempt, worker } = await holdInterruptedAttempt(f)
  let attemptID = attempt.id
  switch (caseName) {
    case "foreign-worker":
      worker.projectID = "foreign-project"
      break
    case "archived-worker":
      worker.archived = true
      break
    case "route-mismatch":
      worker.model = { providerID: "other", id: "other" }
      break
    case "active-worker":
      worker.busy = true
      break
    case "pending-input":
      worker.pendingInput = true
      break
    case "pending-approval":
      worker.pendingPermissions = 1
      break
    case "unstable-observation":
      worker.observationUnstable = true
      break
    case "input-lineage":
      worker.turn = { inputID: "msg-foreign", state: "interrupted" }
      break
    case "known-background":
      worker.runningShells = 1
      break
    case "unrelated-hold":
      f.store.record(planID, null, "BLOCKED", { reason: "A different hold" })
      break
    case "uncertain-effect":
      f.store.atomic((db) =>
        db
          .query("UPDATE runner_effects SET state='uncertain' WHERE plan_id=? AND kind='prompt'")
          .run(planID),
      )
      break
    case "wrong-attempt":
      attemptID = crypto.randomUUID()
      break
  }
  const before = f.store.attempts(planID)[0]!
  await expect(
    f.runtime.command(
      {
        requestID: `unsafe-resume-${caseName}`,
        planID,
        action: "resume",
        taskID: attempt.task_id,
        attemptID,
        reason: "Attempt explicit continuation only if every current guard passes",
      },
      "owner",
    ),
  ).rejects.toThrow()
  expect(f.store.plan(planID)?.state).toBe("blocked")
  expect(f.store.attempts(planID)[0]).toMatchObject({
    id: before.id,
    state: "running",
    message_id: before.message_id,
  })
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
})

test.each(["cancel", "reassign"] as const)(
  "cancellation or reassignment during interrupted-worker observation wins (%s)",
  async (race) => {
    const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
    const { planID, attempt } = await holdInterruptedAttempt(f)
    const originalSession = f.host.session
    let entered!: () => void
    let release!: () => void
    const reading = new Promise<void>((resolve) => (entered = resolve))
    const paused = new Promise<void>((resolve) => (release = resolve))
    let waiting = false
    f.host.session = async (id, options) => {
      const session = await originalSession(id, options)
      if (id === attempt.session_id && options?.messages && !waiting) {
        waiting = true
        entered()
        await paused
      }
      return session
    }
    const resume = f.runtime.command(
      {
        requestID: `resume-race-${race}`,
        planID,
        action: "resume",
        taskID: attempt.task_id,
        attemptID: attempt.id,
        reason: "Resume only if the interrupted observation remains current",
      },
      "owner",
    )
    await reading
    if (race === "cancel") {
      await f.runtime.command(
        {
          requestID: "cancel-during-interrupted-observation",
          planID,
          action: "cancel",
        },
        "owner",
      )
    } else {
      f.sessions.set("new-owner", { ...f.sessions.get("owner")!, id: "new-owner" })
      await f.runtime.command(
        {
          requestID: "reassign-during-interrupted-observation",
          planID,
          action: "reassign",
          targetSessionID: "new-owner",
          reason: "Transfer orchestration while the native observation is pending",
        },
        "owner",
      )
    }
    release()
    if (race === "reassign") {
      // Ownership is advisory: the plan moved, so the command is re-read and its live
      // Architect caller applies it once against the current state.
      await expect(resume).resolves.toBeDefined()
      expect(f.store.plan(planID)?.owner).toBe("owner")
      return
    }
    // Cancellation wins: the recorded state, not a stale version, refuses the resume.
    await expect(resume).rejects.toThrow("Plan is cancelling; resume is not available")
    expect(f.store.attempts(planID)[0]).toMatchObject({
      id: attempt.id,
      state: "running",
      message_id: attempt.message_id,
    })
    expect(
      f.store
        .activity(planID, attempt.task_id)
        .filter((entry) => entry.event === "ATTEMPT_RESUMED"),
    ).toHaveLength(0)
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  },
)

test("ambiguous interrupted continuation delivery stays uncertain after runtime reopen", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const { planID, attempt } = await holdInterruptedAttempt(f)
  const resume = {
    requestID: "resume-ambiguous-interrupted-delivery",
    planID,
    action: "resume",
    taskID: attempt.task_id,
    attemptID: attempt.id,
    reason: "Continue once and retain an ambiguous delivery for reconciliation",
  }
  await f.runtime.command(resume, "owner")
  const resumedMessageID = f.store.attempts(planID)[0]!.message_id
  const prompt = f.host.prompt
  let continuationSends = 0
  f.host.prompt = async (input) => {
    if (input.id === resumedMessageID) {
      continuationSends++
      throw new Error("native admission response lost")
    }
    await prompt(input)
  }
  await f.runtime.tick()
  expect(continuationSends).toBe(1)
  const effect = f.store
    .effects(planID)
    .find(
      (candidate) =>
        candidate.kind === "prompt" && JSON.parse(candidate.payload).messageID === resumedMessageID,
    )
  expect(effect?.state).toBe("uncertain")

  await f.runtime.stop()
  const reopened = reopenRuntime(f)
  await reopened.runtime.tick()
  await reopened.runtime.tick()
  expect(continuationSends).toBe(1)
  expect(
    reopened.store
      .effects(planID)
      .find(
        (candidate) =>
          candidate.kind === "prompt" &&
          JSON.parse(candidate.payload).messageID === resumedMessageID,
      )?.state,
  ).toBe("uncertain")
  expect(reopened.store.attempts(planID)[0]?.message_id).toBe(resumedMessageID)
})

test("explicit cancellation after process replacement resumes the same dirty attempt exactly once", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const attempt = f.store.attempts(planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  const originalSession = f.host.session
  const originalMessageID = attempt.message_id
  const originalWorkspace = attempt.workspace
  const originalPolicy = attempt.policy
  const originalBase = attempt.base_commit
  worker.outcome = "succeeded"
  worker.tokens = 777
  worker.tools = 23
  worker.cost = 2.5
  let replaced = true
  f.host.session = async (id, options) => {
    const session = await originalSession(id, options)
    if (id !== attempt.session_id || !replaced || !session) return session
    return {
      ...session,
      busy: false,
      outcome: "interrupted",
      turn: { inputID: originalMessageID, state: "interrupted" },
    }
  }

  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("blocked")
  expect(f.store.plan(planID)?.reason).toContain("Worker execution was interrupted")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]?.state).toBe("running")
  expect(
    (f.store.detail(planID).activity as { event: string }[]).some(
      (entry) => entry.event === "REPAIR",
    ),
  ).toBe(false)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)

  await f.runtime.command(
    {
      requestID: "cancel-replaced",
      planID,
      action: "cancel",
    },
    "owner",
  )
  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("cancelled")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]).toMatchObject({
    id: attempt.id,
    state: "cancelled",
    session_id: attempt.session_id,
    workspace: originalWorkspace,
    base_commit: originalBase,
    policy: originalPolicy,
    token_count: 777,
    tool_count: 23,
    cost: 2.5,
  })
  expect(git(originalWorkspace, ["status", "--porcelain"])).not.toBe("")
  expect(readFileSync(join(originalWorkspace, "a.txt"), "utf8")).toBe("a")

  replaced = false
  worker.busy = false
  worker.outcome = "interrupted"
  worker.turn = { inputID: originalMessageID, state: "interrupted" }
  const promptCount = f.events.filter((event) => event.startsWith("prompt:")).length
  const resume = {
    requestID: "resume-replaced-same-attempt",
    planID,
    action: "resume",
    taskID: attempt.task_id,
    reason: "Continue the retained dirty attempt after confirming the old process is interrupted",
  }
  const first = await f.runtime.command(resume, "owner")
  const replay = await f.runtime.command(resume, "owner")
  expect(replay).toEqual(first)
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]).toMatchObject({
    id: attempt.id,
    state: "preparing",
    session_id: attempt.session_id,
    workspace: originalWorkspace,
    base_commit: originalBase,
    policy: originalPolicy,
  })
  const resumedMessageID = f.store.attempts(planID)[0]!.message_id
  expect(resumedMessageID).not.toBe(originalMessageID)
  expect(
    (f.store.detail(planID).activity as { event: string }[]).filter(
      (entry) => entry.event === "ATTEMPT_RESUMED",
    ),
  ).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(promptCount)

  await f.runtime.tick()
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(promptCount + 1)
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]?.message_id).toBe(resumedMessageID)
  expect(worker.model).toEqual(JSON.parse(originalPolicy).model)
  expect(readFileSync(join(originalWorkspace, "a.txt"), "utf8")).toBe("a")
  expect(git(originalWorkspace, ["status", "--porcelain"])).not.toBe("")
  expect(f.store.attempts(planID)[0]).toMatchObject({ token_count: 777, tool_count: 23, cost: 2.5 })

  f.completeWorker(worker.id, "succeeded")
  await drive(f.runtime, 4)
  expect(f.store.plan(planID)?.state).toBe("accepted")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.effects(planID).some((effect) => effect.kind === "verify:content")).toBe(true)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(promptCount + 1)
})

test("cancellation does not settle when foreground activity reappears during its detail read", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const attempt = f.store.attempts(planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  const originalSession = f.host.session
  worker.busy = false
  worker.outcome = "interrupted"
  worker.turn = { inputID: attempt.message_id, state: "interrupted" }
  await f.runtime.command(
    {
      requestID: "cancel-detail-race",
      planID,
      action: "cancel",
    },
    "owner",
  )

  let raced = false
  f.host.session = async (id, options) => {
    const session = await originalSession(id, options)
    if (id === attempt.session_id && options?.messages && !raced && session) {
      raced = true
      worker.busy = true
      return { ...session, busy: true, observationUnstable: true }
    }
    return session
  }
  await f.runtime.tick()
  expect(raced).toBe(true)
  expect(f.store.plan(planID)?.state).toBe("cancelling")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]?.state).toBe("running")

  f.host.session = originalSession
  worker.busy = false
  worker.outcome = "interrupted"
  worker.turn = { inputID: attempt.message_id, state: "interrupted" }
  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("cancelled")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]?.state).toBe("cancelled")
})
