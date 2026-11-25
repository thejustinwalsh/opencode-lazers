import { expect, test } from "bun:test"
import type { RunnerTransitionRecord } from "../runtime-helpers.ts"
import { DEFAULT_ARCHITECT_CACHE_WINDOW_MS } from "../architect-routing.ts"
import {
  currentRetainedRepairAuthorityMatches,
  retainedRepairAuthorMatchesHistory,
} from "./authority.ts"
import {
  TaskRuntime,
  drive,
  expireRunnerLease,
  expectNoRecoveryAdmission,
  recoveryAdmissionSnapshot,
  recoveryCommand,
  useRuntimeFixtureCleanup,
} from "../runtime.fixture.ts"
import { reproduceUnpromptedRetainedRepairFenceFailure } from "./fixture.ts"

useRuntimeFixtureCleanup()

test("repair authorship follows durable ownership history while recovery requires the live owner", () => {
  const repairTransition: RunnerTransitionRecord = {
    id: 10,
    task_id: "task",
    event: "RETAINED_REPAIR_REQUESTED",
    payload: JSON.stringify({ owner: "architect-a" }),
  }
  const history: RunnerTransitionRecord[] = [
    repairTransition,
    {
      id: 12,
      task_id: null,
      event: "OWNER_CONTINUED",
      payload: JSON.stringify({ from: "architect-a", to: "architect-b" }),
    },
    {
      id: 14,
      task_id: null,
      event: "OWNER_CONTINUED",
      payload: JSON.stringify({ from: "architect-b", to: "architect-c" }),
    },
  ]
  expect(
    retainedRepairAuthorMatchesHistory({
      author: "architect-a",
      currentOwnerID: "architect-c",
      repairTransition,
      history,
    }),
  ).toBe(true)
  expect(
    retainedRepairAuthorMatchesHistory({
      author: "forged-author",
      currentOwnerID: "architect-c",
      repairTransition,
      history,
    }),
  ).toBe(false)
  expect(
    retainedRepairAuthorMatchesHistory({
      author: "architect-a",
      currentOwnerID: "architect-c",
      repairTransition: {
        ...repairTransition,
        payload: JSON.stringify({ owner: "architect-b" }),
      },
      history,
    }),
  ).toBe(false)

  const currentOwner = {
    id: "architect-c",
    agent: "architect",
    projectID: "project",
    archived: false,
  }
  expect(
    currentRetainedRepairAuthorityMatches({
      callerID: "architect-c",
      planOwnerID: "architect-c",
      ownerSession: currentOwner,
      projectID: "project",
    }),
  ).toBe(true)
  expect(
    currentRetainedRepairAuthorityMatches({
      callerID: "architect-a",
      planOwnerID: "architect-c",
      ownerSession: currentOwner,
      projectID: "project",
    }),
  ).toBe(false)
})

async function reproduceRenewedUnpromptedRecovery(renewalCount: number) {
  const state = await reproduceUnpromptedRetainedRepairFenceFailure()
  const { f, planID, task, reopened } = state

  const genericResume = recoveryCommand(state, "historical-generic-resume-without-attempt")
  const { attemptID: _attemptID, ...genericResumeWithoutAttempt } = genericResume
  await expect(reopened.runtime.command(genericResumeWithoutAttempt, "owner")).rejects.toThrow()
  await expect(
    reopened.runtime.command(
      {
        requestID: "historical-non-owner-cancel",
        planID,
        action: "cancel",
        reason: "A non-owner cannot cancel the retained repair.",
      },
      "not-an-owner",
    ),
  ).rejects.toThrow()
  await reopened.runtime.command(
    { requestID: "historical-reconcile-cancelled-reservation", planID, action: "reconcile" },
    "owner",
  )
  await reopened.runtime.tick()
  expect(reopened.store.plan(planID)).toMatchObject({
    state: "blocked",
    reason: `Task ${task.id}: cancelled`,
  })
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)

  await reopened.runtime.stop()
  // Stopping a coordinator does not release the durable scheduler lease.
  expireRunnerLease(f)
  const now = Date.now()
  const runtime = new TaskRuntime(reopened.store, f.host, "project", undefined, {
    autoResumeInterrupted: false,
    architectPromptHook: true,
    now: () => now,
  })
  try {
    let ownerID = reopened.store.plan(planID)!.owner
    const journal = Reflect.get(runtime, "journal") as {
      outcome(planID: string, payload: unknown, resume: boolean): void
    }
    for (let index = 0; index < renewalCount; index++) {
      const owner = f.sessions.get(ownerID)
      if (!owner) throw new Error(`Renewal predecessor ${ownerID} is missing`)
      owner.idleAt = now - DEFAULT_ARCHITECT_CACHE_WINDOW_MS
      owner.activityAt = undefined
      owner.contextTokens = 60_000
      await runtime.recordArchitectContinuity(ownerID, {
        decisions: ["Keep the existing accepted artifact and preserve the pending defect."],
        unresolvedQuestions: ["Confirm the exact retained-repair recovery."],
      })
      journal.outcome(
        planID,
        { status: "blocked", reason: `Renewal checkpoint ${index + 1}` },
        true,
      )
      await runtime.tick()

      const renewal = reopened.store.architectRenewalForPlan(planID)
      expect(renewal).toMatchObject({ state: "committed", previous_session_id: ownerID })
      expect(f.sessions.get(ownerID)?.archived).toBe(true)
      ownerID = renewal!.successor_session_id
      expect(reopened.store.plan(planID)?.owner).toBe(ownerID)
    }
    return { ...state, runtime, currentOwnerID: ownerID }
  } catch (error) {
    await runtime.stop()
    throw error
  }
}

test.each([1, 2])(
  "the exact unprompted retained repair recovers after %i automatic Architect renewal(s)",
  async (renewalCount) => {
    const state = await reproduceRenewedUnpromptedRecovery(renewalCount)
    const { f, planID, task, attempt, repair, worker, reopened, runtime, currentOwnerID } = state
    try {
      const before = recoveryAdmissionSnapshot(state)
      const currentOwner = f.sessions.get(currentOwnerID)!
      f.sessions.set("recovery-non-architect", {
        ...structuredClone(currentOwner),
        id: "recovery-non-architect",
        agent: "lazers-implementor",
      })
      f.sessions.set("recovery-cross-project", {
        ...structuredClone(currentOwner),
        id: "recovery-cross-project",
        projectID: "another-project",
      })
      const adoptingArchitectID = "recovery-live-architect"
      f.sessions.set(adoptingArchitectID, {
        ...structuredClone(currentOwner),
        id: adoptingArchitectID,
      })

      for (const caller of ["owner", "recovery-non-architect", "recovery-cross-project"]) {
        await expect(
          runtime.command(
            recoveryCommand(state, `refuse-${caller}-${crypto.randomUUID()}`),
            caller,
          ),
        ).rejects.toThrow()
        expectNoRecoveryAdmission(state, before)
      }

      const promptsBeforeRecovery = f.events.filter((event) => event.startsWith("prompt:")).length
      const recovered = await runtime.command(
        recoveryCommand(state, `recover-after-${renewalCount}-renewals`),
        adoptingArchitectID,
      )
      expect(recovered).toMatchObject({
        status: "retained-repair-recovered",
        attemptID: attempt.id,
        taskID: task.id,
      })
      const resumed = reopened.store.attempts(planID)[0]!
      expect(resumed).toMatchObject({
        id: attempt.id,
        state: "preparing",
        session_id: attempt.session_id,
        workspace: attempt.workspace,
        base_commit: attempt.base_commit,
        policy: attempt.policy,
        artifact: attempt.artifact,
        token_count: before.attempt.token_count,
        tool_count: before.attempt.tool_count,
        cost: before.attempt.cost,
      })
      expect(reopened.store.latestTransition(planID, null, "OWNER_ADOPTED")).toMatchObject({
        from: currentOwnerID,
        to: adoptingArchitectID,
        reason: "command-from-live-architect",
      })
      const resumeEvent = reopened.store
        .activity(planID, task.id)
        .filter((entry) => entry.event === "ATTEMPT_RESUMED")
        .at(-1)!
      expect(JSON.parse(resumeEvent.payload)).toMatchObject({
        previousMessageID: attempt.message_id,
        messageID: resumed.message_id,
        terminalInputID: repair.nativeInputID,
        terminalOutcome: "succeeded",
        retainedRepairRecovery: {
          schema: "lazers-retained-repair-recovery/v2",
          operationID: repair.operationID,
          owner: repair.owner,
          recoveredBy: adoptingArchitectID,
          reservedRepairMessageID: repair.messageID,
          predecessorMessageID: repair.previousMessageID,
        },
        usageRetained: true,
      })

      await runtime.tick()
      expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(
        promptsBeforeRecovery + 1,
      )
      const prompt = reopened.store.effects(planID).find((effect) => {
        if (effect.kind !== "prompt") return false
        return (
          (JSON.parse(effect.payload) as { messageID?: unknown }).messageID === resumed.message_id
        )
      })!
      expect(prompt.state).toBe("completed")
      expect(worker.messages.filter((message) => message.id === resumed.message_id)).toHaveLength(1)
      expect(JSON.parse(prompt.payload)).toMatchObject({
        sessionID: attempt.session_id,
        messageID: resumed.message_id,
        workspace: attempt.workspace,
        repairID: repair.operationID,
        repairMessageID: repair.messageID,
        continuedFromInputID: repair.nativeInputID,
      })
      expect(JSON.parse(prompt.receipt!)).toMatchObject({
        messageID: resumed.message_id,
        taskID: task.id,
        repairID: repair.operationID,
        repairMessageID: repair.messageID,
        continuedFromInputID: repair.nativeInputID,
      })
      expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)
      expect(worker).toMatchObject({
        id: attempt.session_id,
        parentID: "owner",
        directory: attempt.workspace,
        model: JSON.parse(attempt.policy).model,
        metadata: { lazersAttemptID: attempt.id },
      })

      await drive(runtime, 10)
      expect(reopened.store.plan(planID)?.state).toBe("accepted")
      expect(reopened.store.attempts(planID)).toHaveLength(1)
      expect(reopened.store.attempts(planID)[0]).toMatchObject({
        id: attempt.id,
        session_id: attempt.session_id,
        workspace: attempt.workspace,
        policy: attempt.policy,
      })
      expect(
        reopened.store.effects(planID).find((effect) => effect.kind === "verify:content"),
      ).toMatchObject({ state: "completed" })
      expect(
        reopened.store.effects(planID).find((effect) => effect.kind === "graph-verify:combined"),
      ).toMatchObject({ state: "completed" })
      expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(
        promptsBeforeRecovery + 1,
      )
    } finally {
      await runtime.stop()
    }
  },
)
