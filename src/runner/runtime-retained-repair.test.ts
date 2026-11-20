import { setProjectSetting } from "../projects/settings.ts"
import { expect, test } from "bun:test"
import { SessionMessage } from "@opencode/schema/session-message"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { git } from "./artifacts.ts"
import {
  type LegacyFenceState,
  acceptedAttemptFixture,
  acceptedRetainedRepairFixture,
  deferred,
  drive,
  expectNoRecoveryAdmission,
  fixture,
  pauseRecoveryAtWorktrees,
  recoveryAdmissionSnapshot,
  recoveryCommand,
  reopenRuntime,
  reproduceLegacyRetainedRepairFenceFailure,
  runPlan,
  useRuntimeFixtureCleanup,
} from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

test("retained repair carries an owned captured synthetic terminal input through same-worker dispatch", async () => {
  const { f, planID, task, original, artifact, worker } = await acceptedAttemptFixture({
    syntheticTerminalInput: true,
  })
  const nativeInputID = worker.turn!.inputID!
  expect(nativeInputID).not.toBe(original.message_id)
  expect(
    f.runtime.progress.matchesAssignedInput(
      original.id,
      original.session_id,
      original.message_id,
      nativeInputID,
    ),
  ).toBe(true)
  const originalSessionCount = f.events.filter((event) => event.startsWith("create:")).length
  const result = (await f.runtime.command(
    {
      requestID: "retained-repair-captured-terminal-input",
      planID,
      action: "retained-repair",
      taskID: task.id,
      attemptID: original.id,
      artifact,
      reason: "Continue from the captured successful native input.",
    },
    "owner",
  )) as { status: string; attemptID: string }
  expect(result).toMatchObject({ status: "retained-repair-requested", attemptID: original.id })
  const admitted = f.store.attempts(planID)[0]!
  const repair = f.store.latestRetainedRepair<{
    previousMessageID: string
    nativeInputID: string
    nativeAssignmentID: string
  }>(planID, task.id)!
  expect(repair).toMatchObject({
    previousMessageID: original.message_id,
    nativeInputID,
    nativeAssignmentID: original.message_id,
  })
  expect(admitted).toMatchObject({
    id: original.id,
    session_id: original.session_id,
    workspace: original.workspace,
    policy: original.policy,
    state: "preparing",
  })
  expect(admitted.message_id).not.toBe(original.message_id)

  await f.runtime.tick()

  const dispatched = f.store.attempts(planID)[0]!
  expect(dispatched).toMatchObject({
    id: original.id,
    session_id: original.session_id,
    workspace: original.workspace,
    policy: original.policy,
    state: "running",
  })
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(originalSessionCount)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(2)
  expect(worker.messages.some((message) => message.id === nativeInputID)).toBe(true)
})

test("retained repair waits for a project-capacity slot before reusing its worker", async () => {
  const { f, planID, task, original, artifact } = await acceptedAttemptFixture()
  setProjectSetting(f.store.repository, await f.runtime.delegatedAgentCapacity.key(), "limit", 1)
  const blocker = await f.runtime.delegatedAgentCapacity.ensureNativeQueued({
    parentSessionID: "lazers-parent",
    toolCallID: "retained-repair-capacity-blocker",
    agent: "research",
    description: "Hold the only project slot",
  })
  await f.runtime.delegatedAgentCapacity.waitForNative(blocker, new AbortController().signal)
  const promptsBeforeRepair = f.events.filter((event) => event.startsWith("prompt:")).length

  await f.runtime.command(
    {
      requestID: "retained-repair-capacity-queue",
      planID,
      action: "retained-repair",
      taskID: task.id,
      attemptID: original.id,
      artifact,
      reason: "Wait for the canonical-project slot before resuming this retained worker.",
    },
    "owner",
  )
  await f.runtime.tick()

  expect(f.store.attempts(planID)[0]).toMatchObject({ id: original.id, state: "preparing" })
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(promptsBeforeRepair)
  const waitingStatus = await f.runtime.delegatedAgentCapacity.settings()
  expect(waitingStatus).toMatchObject({
    active: 1,
    queued: 1,
    limit: 1,
  })

  await f.runtime.delegatedAgentCapacity.releaseNativeRequest(blocker)
  await f.runtime.tick()

  expect(f.store.attempts(planID)[0]).toMatchObject({ id: original.id, state: "running" })
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(
    promptsBeforeRepair + 1,
  )
})

test.each(["uncaptured-synthetic", "foreign-user", "running-shell"] as const)(
  "retained repair rejects %s input evidence before reserving the attempt",
  async (invalidInput) => {
    const { f, planID, task, original, artifact, worker } = await acceptedAttemptFixture()
    if (invalidInput === "uncaptured-synthetic" || invalidInput === "foreign-user") {
      const foreignInputID = SessionMessage.ID.create()
      worker.messages.push({
        id: foreignInputID,
        type: invalidInput === "foreign-user" ? "user" : "synthetic",
        text: "Unowned terminal input",
      })
      worker.turn = { inputID: foreignInputID, state: "completed" }
    } else {
      worker.turn = { inputID: original.message_id, state: "completed" }
      worker.runningShells = 1
    }

    await expect(
      f.runtime.command(
        {
          requestID: `reject-${invalidInput}-retained-repair`,
          planID,
          action: "retained-repair",
          taskID: task.id,
          attemptID: original.id,
          artifact,
          reason: "Reject terminal input without exact captured idle ownership.",
        },
        "owner",
      ),
    ).rejects.toThrow()
    expect(f.store.attempts(planID)).toHaveLength(1)
    expect(f.store.attempts(planID)[0]?.message_id).toBe(original.message_id)
    expect(f.store.latestRetainedRepair(planID, task.id)).toBeUndefined()
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  },
)

test("retained repair revalidates the captured terminal input before prompting the original worker", async () => {
  const { f, planID, task, original, artifact, worker } = await acceptedAttemptFixture({
    syntheticTerminalInput: true,
  })
  const before = f.events.filter((event) => event.startsWith("prompt:")).length
  await f.runtime.command(
    {
      requestID: "reserve-captured-terminal-for-dispatch",
      planID,
      action: "retained-repair",
      taskID: task.id,
      attemptID: original.id,
      artifact,
      reason: "Repair only while the exact captured terminal input remains current.",
    },
    "owner",
  )
  const foreignInputID = SessionMessage.ID.create()
  worker.messages.push({ id: foreignInputID, type: "synthetic", text: "Unowned input" })
  worker.turn = { inputID: foreignInputID, state: "completed" }

  await f.runtime.tick()

  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.store.attempts(planID)[0]?.state).toBe("preparing")
  expect(f.store.plan(planID)?.state).toBe("blocked")
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(before)
})

test("native heartbeat failures retain structured holds without repeatedly reading context", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const attempt = f.store.attempts(planID)[0]!
  const worker = f.sessions.get(attempt.session_id)!
  worker.busy = false
  worker.pendingInput = false
  worker.outcome = "failed"
  worker.idleAt = 1000
  worker.turn = { inputID: attempt.message_id, state: "completed" }

  const original = f.host.session
  let detailReads = 0
  f.host.session = async (id, options) => {
    const session = await original(id, options)
    if (id !== attempt.session_id || !session) return session
    if (options?.messages) {
      detailReads++
      return session
    }
    return { ...session, turn: undefined, messages: [] }
  }
  await f.runtime.tick()
  await f.runtime.tick()
  expect(detailReads).toBe(1)
  expect(f.store.latestTransition(planID, null, "BLOCKED")).toMatchObject({
    workerObservation: { inputID: attempt.message_id, outcome: "failed", idleAt: 1000 },
  })
  await f.runtime.command(
    {
      requestID: "resume-native-heartbeat-failure",
      planID,
      action: "resume",
      taskID: attempt.task_id,
      attemptID: attempt.id,
      reason: "Continue the exact failed worker",
    },
    "owner",
  )
  await f.runtime.tick()
  const resumed = f.store.attempts(planID)[0]!
  const readsBeforeNewFailure = detailReads
  worker.busy = false
  worker.pendingInput = false
  worker.outcome = "failed"
  worker.idleAt = 2000
  worker.turn = { inputID: resumed.message_id, state: "completed" }
  await f.runtime.tick()
  await f.runtime.tick()
  expect(detailReads).toBe(readsBeforeNewFailure + 1)
  expect(f.store.latestTransition(planID, null, "BLOCKED")).toMatchObject({
    workerObservation: { inputID: resumed.message_id, outcome: "failed", idleAt: 2000 },
  })
  expect(f.store.attempts(planID)).toHaveLength(1)
})

test("retained repair continuation preserves authority across process replacement and verifies the original attempt", async () => {
  const state = await acceptedRetainedRepairFixture()
  const { f, planID, task, attempt, artifact, repair, worker } = state
  const original = structuredClone(attempt)
  const nativeParentID = worker.parentID
  const nativeRoute = structuredClone(worker.model)
  worker.tokens = 777
  worker.tools = 23
  worker.cost = 2.5
  worker.busy = false
  worker.outcome = "interrupted"
  worker.turn = { inputID: repair.messageID, state: "interrupted" }

  await f.runtime.tick()
  expect(f.store.plan(planID)?.state).toBe("blocked")
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(2)

  await f.runtime.stop()
  const reopened = reopenRuntime(f)
  const resume = {
    requestID: "resume-retained-repair-after-restart",
    planID,
    action: "resume" as const,
    taskID: task.id,
    attemptID: attempt.id,
    reason: "Continue the exact interrupted retained repair after process replacement.",
  }
  const receipt = await reopened.runtime.command(resume, "owner")
  expect(await reopened.runtime.command(resume, "owner")).toEqual(receipt)
  const resumed = reopened.store.attempts(planID)[0]!
  expect(receipt).toMatchObject({ status: "resuming" })
  expect(resumed).toMatchObject({
    id: original.id,
    state: "preparing",
    session_id: original.session_id,
    workspace: original.workspace,
    base_commit: original.base_commit,
    policy: original.policy,
    artifact,
    token_count: 777,
    tool_count: 23,
    cost: 2.5,
  })
  expect(resumed.message_id).not.toBe(repair.messageID)
  const resumeEvent = reopened.store
    .activity(planID, task.id)
    .filter((entry) => entry.event === "ATTEMPT_RESUMED")
    .at(-1)!
  expect(JSON.parse(resumeEvent.payload)).toMatchObject({
    attemptID: original.id,
    previousMessageID: repair.messageID,
    messageID: resumed.message_id,
    terminalInputID: repair.messageID,
    terminalOutcome: "interrupted",
    interruptedInputID: repair.messageID,
    retainedRepairContinuation: {
      schema: "lazers-retained-repair-continuation/v1",
      operationID: repair.operationID,
      owner: "owner",
    },
    usageRetained: true,
  })

  await reopened.runtime.tick()
  const continuationPrompt = reopened.store.effects(planID).find((effect) => {
    if (effect.kind !== "prompt") return false
    const payload = JSON.parse(effect.payload) as Record<string, unknown>
    return payload.messageID === resumed.message_id
  })!
  expect(continuationPrompt.state).toBe("completed")
  expect(worker).toMatchObject({
    id: original.session_id,
    parentID: nativeParentID,
    directory: original.workspace,
    model: nativeRoute,
    metadata: { lazersAttemptID: original.id },
  })
  expect(JSON.parse(continuationPrompt.payload)).toMatchObject({
    sessionID: original.session_id,
    messageID: resumed.message_id,
    workspace: original.workspace,
    repairID: repair.operationID,
    repairMessageID: repair.messageID,
    continuedFromInputID: repair.messageID,
  })
  expect(JSON.parse(continuationPrompt.receipt!)).toMatchObject({
    messageID: resumed.message_id,
    taskID: task.id,
    repairID: repair.operationID,
    continuedFromInputID: repair.messageID,
  })
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(3)
  expect(reopened.store.attempts(planID)).toHaveLength(1)

  f.completeWorker(original.session_id)

  await drive(reopened.runtime, 10)
  expect(reopened.store.plan(planID)?.state).toBe("accepted")
  expect(reopened.store.nodes(planID)[0]).toMatchObject({ task_id: task.id, state: "accepted" })
  expect(reopened.store.attempts(planID)).toHaveLength(1)
  expect(reopened.store.attempts(planID)[0]).toMatchObject({
    id: original.id,
    session_id: original.session_id,
    workspace: original.workspace,
    base_commit: original.base_commit,
    policy: original.policy,
    token_count: 777,
    tool_count: 23,
    cost: 2.5,
  })
  expect(
    reopened.store.effects(planID).find((effect) => effect.kind === "verify:content"),
  ).toMatchObject({ state: "completed" })
  expect(
    reopened.store.effects(planID).find((effect) => effect.kind === "graph-verify:combined"),
  ).toMatchObject({ state: "completed" })
  expect(reopened.store.latestRetainedRepair<{ artifact: string }>(planID, task.id)?.artifact).toBe(
    artifact,
  )
})

test("a pre-existing retained-repair fence failure recovers the exact cancelled reservation without losing dirty work", async () => {
  const { f, planID, task, attempt, repair, reopened, failedReservation } =
    await reproduceLegacyRetainedRepairFenceFailure()
  const worker = f.sessions.get(attempt.session_id)!
  const nativeParentID = worker.parentID
  const nativeRoute = structuredClone(worker.model)

  const dirtyWork = "unsaved retained-repair progress\n"
  writeFileSync(join(attempt.workspace, "repair-notes.txt"), dirtyWork)
  git(attempt.workspace, ["add", "repair-notes.txt"])
  const recoveryCommand = {
    requestID: "recover-retained-repair-fence-failure",
    planID,
    action: "resume" as const,
    taskID: task.id,
    attemptID: attempt.id,
    reason: "Recover the original retained repair after its proven runtime fence failure.",
  }
  const recovered = await reopened.runtime.command(recoveryCommand, "owner")
  expect(await reopened.runtime.command(recoveryCommand, "owner")).toEqual(recovered)
  expect(recovered).toMatchObject({ status: "retained-repair-recovered", attemptID: attempt.id })
  const resumed = reopened.store.attempts(planID)[0]!
  expect(resumed).toMatchObject({
    id: attempt.id,
    state: "preparing",
    session_id: attempt.session_id,
    workspace: attempt.workspace,
    base_commit: attempt.base_commit,
    policy: attempt.policy,
    artifact: attempt.artifact,
    token_count: 777,
    tool_count: 23,
    cost: 2.5,
  })
  expect(resumed.message_id).not.toBe(failedReservation.message_id)
  expect(readFileSync(join(attempt.workspace, "repair-notes.txt"), "utf8")).toBe(dirtyWork)
  const recoveryEvent = reopened.store
    .activity(planID, task.id)
    .filter((entry) => entry.event === "ATTEMPT_RESUMED")
    .at(-1)!
  expect(JSON.parse(recoveryEvent.payload)).toMatchObject({
    attemptID: attempt.id,
    previousMessageID: failedReservation.message_id,
    messageID: resumed.message_id,
    terminalInputID: repair.messageID,
    interruptedInputID: repair.messageID,
    retainedRepairRecovery: {
      schema: "lazers-retained-repair-recovery/v1",
      operationID: repair.operationID,
      failedMessageID: failedReservation.message_id,
      interruptedInputID: repair.messageID,
      owner: "owner",
    },
    usageRetained: true,
  })

  await reopened.runtime.tick()
  const prompt = reopened.store.effects(planID).find((effect) => {
    if (effect.kind !== "prompt") return false
    return (JSON.parse(effect.payload) as { messageID?: unknown }).messageID === resumed.message_id
  })!
  expect(prompt.state).toBe("completed")
  expect(worker).toMatchObject({
    id: attempt.session_id,
    parentID: nativeParentID,
    directory: attempt.workspace,
    model: nativeRoute,
    metadata: { lazersAttemptID: attempt.id },
  })
  expect(JSON.parse(prompt.receipt!)).toMatchObject({
    messageID: resumed.message_id,
    repairID: repair.operationID,
    continuedFromInputID: repair.messageID,
  })
  expect(readFileSync(join(attempt.workspace, "repair-notes.txt"), "utf8")).toBe(dirtyWork)
  expect(reopened.store.attempts(planID)).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(3)
})

test("retained repair recovery preserves dirty progress that changes during native revalidation", async () => {
  const state = await reproduceLegacyRetainedRepairFenceFailure()
  const path = join(state.attempt.workspace, "repair-progress.txt")
  writeFileSync(path, "earlier progress\n")
  const originalSession = state.f.host.session
  let ownerReads = 0
  state.f.host.session = async (sessionID, options) => {
    if (sessionID === "owner" && ++ownerReads === 3) writeFileSync(path, "new useful progress\n")
    return originalSession(sessionID, options)
  }
  try {
    const result = await state.reopened.runtime.command(
      recoveryCommand(state, "recover-with-new-dirty-progress"),
      "owner",
    )
    expect(result).toMatchObject({
      status: "retained-repair-recovered",
      attemptID: state.attempt.id,
    })
    expect(ownerReads).toBeGreaterThanOrEqual(2)
    expect(readFileSync(path, "utf8")).toBe("new useful progress\n")
    expect(state.reopened.store.attempts(state.planID)).toHaveLength(1)
    expect(state.reopened.store.attempts(state.planID)[0]).toMatchObject({
      id: state.attempt.id,
      session_id: state.attempt.session_id,
      workspace: state.attempt.workspace,
      state: "preparing",
      token_count: 777,
      tool_count: 23,
      cost: 2.5,
    })
  } finally {
    state.f.host.session = originalSession
  }
})

test("an owner cancellation after the fence failure is not eligible for retained-repair recovery", async () => {
  const { f, planID, task, attempt, reopened } = await reproduceLegacyRetainedRepairFenceFailure()
  const promptsBeforeCancel = f.events.filter((event) => event.startsWith("prompt:")).length
  await reopened.runtime.command(
    {
      requestID: "cancel-retained-repair-after-fence-failure",
      planID,
      action: "cancel",
      reason: "Do not continue this retained repair.",
    },
    "owner",
  )
  const cancellation = reopened.store.plan(planID)!
  expect(cancellation.state).toBe("cancelling")
  expect(reopened.store.latestTransition(planID, null, "CANCEL_REQUESTED")).toBeDefined()
  await expect(
    reopened.runtime.command(
      {
        requestID: "resume-after-actual-cancellation",
        planID,
        action: "resume",
        taskID: task.id,
        attemptID: attempt.id,
        reason: "This actual cancellation must not be recovered.",
      },
      "owner",
    ),
  ).rejects.toThrow()
  expect(reopened.store.plan(planID)?.state).toBe("cancelling")
  expect(reopened.store.attempts(planID)).toHaveLength(1)
  expect(reopened.store.attempts(planID)[0]).toMatchObject({ id: attempt.id, state: "cancelled" })
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(promptsBeforeCancel)
})

test.each([
  {
    name: "native route",
    caller: "owner",
    mutate: (state: LegacyFenceState) => {
      state.worker.model = { providerID: "openai", id: "wrong-recovery-route" }
    },
  },
  {
    name: "repair artifact",
    caller: "owner",
    mutate: (state: LegacyFenceState) => {
      const transition = state.reopened.store
        .activity(state.planID, state.task.id)
        .filter((entry) => entry.event === "RETAINED_REPAIR_REQUESTED")
        .at(-1)!
      const payload = JSON.parse(transition.payload) as Record<string, unknown>
      payload.artifact = "f".repeat(40)
      state.reopened.store.atomic((db) =>
        db
          .query("UPDATE runner_transitions SET payload=? WHERE id=?")
          .run(JSON.stringify(payload), transition.id),
      )
    },
  },
  {
    name: "owner",
    caller: "not-the-plan-owner",
    mutate: () => {},
  },
  {
    name: "uncertain effect",
    caller: "owner",
    mutate: (state: LegacyFenceState) => {
      const check = state.reopened.store
        .effects(state.planID)
        .find((effect) => effect.kind === "verify:content")!
      state.reopened.store.atomic((db) =>
        db.query("UPDATE runner_effects SET state='uncertain' WHERE id=?").run(check.id),
      )
    },
  },
  {
    name: "pending executable controls",
    caller: "owner",
    mutate: (state: LegacyFenceState) => {
      Object.assign(state.worker, {
        pendingInput: true,
        pendingPermissions: 1,
        pendingForms: 1,
      })
    },
  },
])(
  "registered retained-repair recovery rejects a mismatched $name",
  async ({ name, caller, mutate }) => {
    const state = await reproduceLegacyRetainedRepairFenceFailure()
    mutate(state)
    const before = recoveryAdmissionSnapshot(state)
    await expect(
      state.reopened.runtime.command(
        recoveryCommand(state, `reject-retained-repair-${name}-${crypto.randomUUID()}`),
        caller,
      ),
    ).rejects.toThrow()
    expectNoRecoveryAdmission(state, before)
  },
)

test.each(["revision", "project"] as const)(
  "registered retained-repair recovery rechecks changed task %s after deferred native revalidation",
  async (binding) => {
    const state = await reproduceLegacyRetainedRepairFenceFailure()
    const before = recoveryAdmissionSnapshot(state)
    const paused = await pauseRecoveryAtWorktrees(state, `deferred-task-${binding}`)
    try {
      const task = state.f.repository.get(state.task.id)!
      const changed = structuredClone(task)
      if (binding === "revision") changed.revision += 1
      else changed.provenance.projectID = "foreign-project"
      state.f.repository.atomic((db) =>
        db
          .query("UPDATE tasks SET body=? WHERE project_directory=? AND id=?")
          .run(JSON.stringify(changed), state.f.repository.projectDirectory, state.task.id),
      )
    } finally {
      paused.release()
    }
    await expect(paused.pending).rejects.toThrow()
    expectNoRecoveryAdmission(state, before)
  },
)

test("registered retained-repair recovery rechecks task disposition after deferred native revalidation", async () => {
  const state = await reproduceLegacyRetainedRepairFenceFailure()
  const before = recoveryAdmissionSnapshot(state)
  const paused = await pauseRecoveryAtWorktrees(state, "deferred-task-disposition")
  try {
    expect(
      state.f.repository.recordDisposition(
        {
          taskID: state.task.id,
          requestID: "dispose-during-retained-recovery",
          disposition: "rejected",
          reason: "The task is obsolete while native recovery validation is pending.",
          evidence: [{ kind: "human", reference: "Deferred recovery race regression" }],
        },
        { sessionID: "owner", agent: "architect" },
      ).status,
    ).toBe("recorded")
    expect(state.reopened.store.plan(state.planID)?.version).toBe(before.version)
  } finally {
    paused.release()
  }
  await expect(paused.pending).rejects.toThrow()
  expectNoRecoveryAdmission(state, before)
})

test("registered retained-repair recovery loses to an owner reassignment during deferred native revalidation", async () => {
  const state = await reproduceLegacyRetainedRepairFenceFailure()
  const { f, reopened, planID, attempt } = state
  const owner = f.sessions.get("owner")!
  f.sessions.set("owner-b", { ...structuredClone(owner), id: "owner-b" })
  const paused = await pauseRecoveryAtWorktrees(state, "recovery-raced-by-reassign")
  const originalResumes = reopened.store
    .activity(planID, state.task.id)
    .filter((entry) => entry.event === "ATTEMPT_RESUMED").length
  const originalPrompts = f.events.filter((event) => event.startsWith("prompt:")).length
  try {
    await reopened.runtime.command(
      {
        requestID: "reassign-during-retained-recovery",
        planID,
        action: "reassign",
        targetSessionID: "owner-b",
        reason: "Reassign while original-worker recovery is awaiting native evidence.",
      },
      "owner",
    )
  } finally {
    paused.release()
  }
  await expect(paused.pending).rejects.toThrow()
  expect(reopened.store.plan(planID)).toMatchObject({ owner: "owner-b", state: "blocked" })
  expect(reopened.store.attempts(planID)).toHaveLength(1)
  expect(reopened.store.attempts(planID)[0]).toMatchObject({
    id: attempt.id,
    state: "cancelled",
    message_id: state.failedReservation.message_id,
    session_id: attempt.session_id,
    workspace: attempt.workspace,
    base_commit: attempt.base_commit,
    policy: attempt.policy,
  })
  expect(
    reopened.store
      .activity(planID, state.task.id)
      .filter((entry) => entry.event === "ATTEMPT_RESUMED"),
  ).toHaveLength(originalResumes)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(originalPrompts)
})

test("registered retained-repair recovery rejects a native input that changes between revalidation reads", async () => {
  const state = await reproduceLegacyRetainedRepairFenceFailure()
  const before = recoveryAdmissionSnapshot(state)
  const ownerRead = deferred<void>()
  const releaseOwnerRead = deferred<void>()
  const originalSession = state.f.host.session
  let ownerReads = 0
  state.f.host.session = async (sessionID, options) => {
    if (sessionID === "owner" && ++ownerReads === 3) {
      ownerRead.resolve()
      await releaseOwnerRead.promise
    }
    return originalSession(sessionID, options)
  }
  const pending = state.reopened.runtime.command(
    recoveryCommand(state, "recovery-raced-by-native-input"),
    "owner",
  )
  try {
    await ownerRead.promise
    state.worker.messages.push({
      id: "msg-new-native-input",
      type: "user",
      text: "A newer native input arrived during recovery revalidation.",
    })
    state.worker.outcome = "interrupted"
    state.worker.turn = { inputID: "msg-new-native-input", state: "interrupted" }
  } finally {
    releaseOwnerRead.resolve()
    state.f.host.session = originalSession
  }
  await expect(pending).rejects.toThrow()
  expectNoRecoveryAdmission(state, before)
})
