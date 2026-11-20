import { expect, test } from "bun:test"
import type { HostSession } from "./host.ts"
import { matchesReviewInputAlias, parseReviewInputAlias } from "./review-input.ts"
import {
  TaskRuntime,
  cleanup,
  drive,
  expireRunnerLease,
  fixture,
  heldReviewInputFixture,
  invalidReviewInputs,
  reviewInputCommand,
  runPlan,
  useRuntimeFixtureCleanup,
} from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

test("a verifying attempt reconciles its actual review input and resumes the same worker for correction", async () => {
  const { f, attempt, reviewInputID } = await heldReviewInputFixture()
  const planID = f.receipt.planID
  f.store.atomic((db) => {
    db.query("UPDATE runner_attempts SET state='verifying' WHERE id=?").run(attempt.id)
    db.query("UPDATE runner_nodes SET state='verifying' WHERE plan_id=? AND task_id=?").run(
      planID,
      attempt.task_id,
    )
  })
  const effects = f.store.effects(planID)
  const reconciled = await f.runtime.command(reviewInputCommand(f, attempt, reviewInputID), "owner")
  expect(reconciled).toMatchObject({ relationshipRecorded: true })
  expect(f.store.attempts(planID)[0]!.state).toBe("verifying")
  f.store.atomic((db) =>
    db
      .query(
        "UPDATE runner_plans SET state='blocked',reason='Review found a concrete defect' WHERE id=?",
      )
      .run(planID),
  )
  const command = {
    requestID: "resume-verifying-for-real-correction",
    planID,
    action: "resume" as const,
    taskID: attempt.task_id,
    attemptID: attempt.id,
    reason: "Correct the defect found during verification in the same worker",
  }
  expect(await f.runtime.command(command, "owner")).toMatchObject({ status: "resuming" })
  const resumed = f.store.attempts(planID)[0]!
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(resumed).toMatchObject({
    id: attempt.id,
    session_id: attempt.session_id,
    workspace: attempt.workspace,
    policy: attempt.policy,
    state: "preparing",
  })
  expect(resumed.message_id).not.toBe(attempt.message_id)
  expect(f.store.effects(planID)).toEqual(effects)
  expect(f.store.nodes(planID)[0]!.state).toBe("running")
  expect(await f.runtime.command(command, "owner")).toMatchObject({ status: "resuming" })
  expect(f.store.attempts(planID)[0]!.message_id).toBe(resumed.message_id)
  await f.runtime.tick()
  expect(f.events.filter((event) => event.startsWith("create:"))).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(2)
})

test("owner reconciliation binds an observed review input without replacing the assignment", async () => {
  const {
    f,
    attempt: initialAttempt,
    worker,
    reviewInputID,
    reviewRequestID,
  } = await heldReviewInputFixture()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  expect(attempt.id).toBe(initialAttempt.id)
  const originalAssignment = {
    id: attempt.id,
    session_id: attempt.session_id,
    message_id: attempt.message_id,
    workspace: attempt.workspace,
    base_commit: attempt.base_commit,
    policy: attempt.policy,
    token_count: attempt.token_count,
    tool_count: attempt.tool_count,
    cost: attempt.cost,
  }
  const promptCount = f.events.filter((event) => event.startsWith("prompt:")).length
  const command = reviewInputCommand(f, attempt, reviewInputID)

  const first = await f.runtime.command(command, "owner")
  expect(first).toMatchObject({
    status: "reconciling",
    reviewInputID,
    relationshipRecorded: true,
  })
  expect(f.store.plan(f.receipt.planID)?.state).toBe("running")
  expect(f.store.attempts(f.receipt.planID)[0]).toMatchObject(originalAssignment)
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("create:")).length).toBe(1)
  expect(f.events.filter((event) => event.startsWith("prompt:")).length).toBe(promptCount)
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(false)

  const alias = f.store.latestTransition<{
    source: string
    runtimeSentMessage: boolean
    projectDirectory: string
    projectID: string
    planID: string
    taskID: string
    attemptID: string
    sessionID: string
    workspace: string
    assignedMessageID: string
    reviewInputID: string
    reviewRequestID: string
    commandRequestID: string
    input: Record<string, unknown>
    observation: { inputID: string; turnState: string }
  }>(f.receipt.planID, attempt.task_id, "WORKER_REVIEW_INPUT_RECONCILED")!
  expect(alias).toMatchObject({
    source: "observed-native-review-input",
    runtimeSentMessage: false,
    projectDirectory: f.root,
    projectID: "project",
    planID: f.receipt.planID,
    taskID: attempt.task_id,
    attemptID: attempt.id,
    sessionID: attempt.session_id,
    workspace: attempt.workspace,
    assignedMessageID: attempt.message_id,
    reviewInputID,
    reviewRequestID,
    commandRequestID: command.requestID,
    input: {
      type: "synthetic",
      taskID: attempt.task_id,
      attemptID: attempt.id,
      requestID: reviewRequestID,
    },
    observation: {
      outcome: "succeeded",
      inputID: reviewInputID,
      turnState: "completed",
    },
  })
  expect(alias.input).not.toHaveProperty("delivery")
  expect(alias.input).not.toHaveProperty("resume")
  const parsedAlias = parseReviewInputAlias(alias)
  expect(parsedAlias).toBeDefined()
  expect(
    matchesReviewInputAlias(parsedAlias!, {
      projectDirectory: f.root,
      projectID: "project",
      planID: f.receipt.planID,
      taskID: attempt.task_id,
      attemptID: attempt.id,
      sessionID: attempt.session_id,
      workspace: attempt.workspace,
      assignedMessageID: attempt.message_id,
      reviewInputID,
    }),
  ).toBe(true)
  expect(worker.messages.find((message) => message.id === reviewInputID)?.metadata).toEqual({
    lazersReview: {
      taskID: attempt.task_id,
      attemptID: attempt.id,
      requestID: reviewRequestID,
    },
  })

  expect(await f.runtime.command(command, "owner")).toEqual(first)
  const replay = await f.runtime.command(
    reviewInputCommand(f, attempt, reviewInputID, "reconcile-review-steer-duplicate"),
    "owner",
  )
  expect(replay).toMatchObject({ relationshipRecorded: false, reviewInputID })
  const aliasCount = f.store.atomic(
    (db) =>
      db
        .query<{ count: number }, [string, string]>(
          "SELECT count(*) AS count FROM runner_transitions WHERE plan_id=? AND task_id=? AND event='WORKER_REVIEW_INPUT_RECONCILED'",
        )
        .get(f.receipt.planID, attempt.task_id)!.count,
  )
  expect(aliasCount).toBe(1)

  const reopened = new TaskRuntime(f.store, f.host, "project", undefined, {
    autoResumeInterrupted: false,
  })
  cleanup.push(() => reopened.stop())
  expireRunnerLease(f)
  await drive(reopened, 6)
  expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
  expect(f.store.attempts(f.receipt.planID)[0]).toMatchObject(originalAssignment)
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
  expect(f.events.filter((event) => event.startsWith("prompt:")).length).toBe(promptCount)
  expect(f.store.effects(f.receipt.planID).some((effect) => effect.kind === "verify:content")).toBe(
    true,
  )
})

test("review input identity accepts unrelated additive native message metadata", async () => {
  const { f, attempt, worker, reviewInputID } = await heldReviewInputFixture()
  worker.messages.find((message) => message.id === reviewInputID)!.metadata!.trace = "native-note"
  const result = await f.runtime.command(
    reviewInputCommand(f, attempt, reviewInputID, "review-input-extra-metadata"),
    "owner",
  )
  expect(result).toMatchObject({ status: "reconciling", relationshipRecorded: true })
  expect(
    f.store.latestTransition(f.receipt.planID, attempt.task_id, "WORKER_REVIEW_INPUT_RECONCILED"),
  ).toBeDefined()
})

test.each(["OWNER_CONTINUED", "OWNER_REASSIGNED"] as const)(
  "an admitted review-input alias survives later %s with the original worker assignment",
  async (ownerEvent) => {
    const { f, attempt, worker, reviewInputID } = await heldReviewInputFixture()
    await f.runtime.command(
      reviewInputCommand(f, attempt, reviewInputID, `review-before-${ownerEvent}`),
      "owner",
    )
    const nextOwner: HostSession = {
      ...structuredClone(f.sessions.get("owner")!),
      id: `next-${ownerEvent.toLowerCase()}`,
    }
    f.sessions.set(nextOwner.id, nextOwner)
    if (ownerEvent === "OWNER_CONTINUED") {
      expect(f.store.updatePlanOwner(f.receipt.planID, "owner", nextOwner.id)).toBe(true)
    } else {
      await f.runtime.command(
        {
          requestID: "reassign-after-review-alias",
          planID: f.receipt.planID,
          action: "reassign",
          targetSessionID: nextOwner.id,
          reason: "Transfer ownership after exact review-input reconciliation",
        },
        "owner",
      )
    }
    expect(f.store.latestTransition(f.receipt.planID, null, ownerEvent)).toBeDefined()
    expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
    expect(f.store.attempts(f.receipt.planID)[0]).toMatchObject({
      id: attempt.id,
      session_id: attempt.session_id,
      message_id: attempt.message_id,
      workspace: attempt.workspace,
      base_commit: attempt.base_commit,
      policy: attempt.policy,
    })
    expect(worker.turn).toEqual({ inputID: reviewInputID, state: "completed" })

    const reopened = new TaskRuntime(f.store, f.host, "project", undefined, {
      autoResumeInterrupted: false,
    })
    cleanup.push(() => reopened.stop())
    expireRunnerLease(f)
    await drive(reopened, 6)
    expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
    expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
    expect(f.store.attempts(f.receipt.planID)[0]?.id).toBe(attempt.id)
  },
)

test.each(invalidReviewInputs)(
  "review reconciliation rejects $name without recording an alias",
  async ({ mutate }) => {
    const context = await heldReviewInputFixture()
    mutate(context)
    const { f, attempt, reviewInputID } = context
    const promptCount = f.events.filter((event) => event.startsWith("prompt:")).length
    await expect(
      f.runtime.command(reviewInputCommand(f, attempt, reviewInputID), "owner"),
    ).rejects.toThrow()
    expect(
      f.store.latestTransition(f.receipt.planID, attempt.task_id, "WORKER_REVIEW_INPUT_RECONCILED"),
    ).toBeUndefined()
    expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
    expect(f.events.filter((event) => event.startsWith("prompt:")).length).toBe(promptCount)
    expect(
      f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
    ).toBe(false)
  },
)

test.each(["wrong-owner", "wrong-task", "wrong-attempt"] as const)(
  "review reconciliation rejects %s command identity",
  async (scenario) => {
    const { f, attempt, reviewInputID } = await heldReviewInputFixture()
    const command = reviewInputCommand(f, attempt, reviewInputID)
    const caller = scenario === "wrong-owner" ? "not-owner" : "owner"
    if (scenario === "wrong-task") command.taskID = crypto.randomUUID()
    if (scenario === "wrong-attempt") command.attemptID = crypto.randomUUID()
    await expect(f.runtime.command(command, caller)).rejects.toThrow()
    expect(
      f.store.latestTransition(f.receipt.planID, attempt.task_id, "WORKER_REVIEW_INPUT_RECONCILED"),
    ).toBeUndefined()
  },
)

test.each(["intended", "uncertain"] as const)(
  "review reconciliation does not record lineage while an effect is %s",
  async (state) => {
    const { f, attempt, reviewInputID } = await heldReviewInputFixture()
    f.store.atomic((db) =>
      db
        .query(
          `INSERT INTO runner_effects(id,plan_id,task_id,attempt_id,kind,state,payload,receipt,fence)
         VALUES(?,?,?,?,?,?,?,NULL,0)`,
        )
        .run(
          crypto.randomUUID(),
          f.receipt.planID,
          attempt.task_id,
          attempt.id,
          "review-test-effect",
          state,
          "{}",
        ),
    )
    const result = await f.runtime.command(
      reviewInputCommand(f, attempt, reviewInputID, `review-effect-${state}`),
      "owner",
    )
    expect(result).toMatchObject({ status: "blocked" })
    expect(
      f.store.latestTransition(f.receipt.planID, attempt.task_id, "WORKER_REVIEW_INPUT_RECONCILED"),
    ).toBeUndefined()
  },
)

test("cancellation and assignment changes during review observation fence stale aliases", async () => {
  const cancelled = await heldReviewInputFixture()
  const originalSession = cancelled.f.host.session
  let didCancel = false
  cancelled.f.host.session = async (id, options) => {
    const snapshot = await originalSession(id, options)
    if (id === cancelled.attempt.session_id && options?.messages && !didCancel) {
      didCancel = true
      await cancelled.f.runtime.command(
        {
          requestID: "cancel-during-review-observation",
          planID: cancelled.f.receipt.planID,
          action: "cancel",
        },
        "owner",
      )
    }
    return snapshot
  }
  await expect(
    cancelled.f.runtime.command(
      reviewInputCommand(
        cancelled.f,
        cancelled.attempt,
        cancelled.reviewInputID,
        "review-cancel-race",
      ),
      "owner",
    ),
  ).rejects.toThrow("Review input reconciliation requires a running or blocked plan")
  expect(cancelled.f.store.plan(cancelled.f.receipt.planID)?.state).toBe("cancelling")
  expect(
    cancelled.f.store.latestTransition(
      cancelled.f.receipt.planID,
      cancelled.attempt.task_id,
      "WORKER_REVIEW_INPUT_RECONCILED",
    ),
  ).toBeUndefined()

  const reassigned = await heldReviewInputFixture()
  const replacementOwner: HostSession = {
    ...reassigned.f.sessions.get("owner")!,
    id: "new-owner",
  }
  reassigned.f.sessions.set(replacementOwner.id, replacementOwner)
  const originalReassignmentSession = reassigned.f.host.session
  let didReassign = false
  reassigned.f.host.session = async (id, options) => {
    const snapshot = await originalReassignmentSession(id, options)
    if (id === reassigned.attempt.session_id && options?.messages && !didReassign) {
      didReassign = true
      await reassigned.f.runtime.command(
        {
          requestID: "reassign-during-review-observation",
          planID: reassigned.f.receipt.planID,
          action: "reassign",
          targetSessionID: replacementOwner.id,
          reason: "Move current ownership during review reconciliation",
        },
        "owner",
      )
    }
    return snapshot
  }
  // Ownership is advisory: the command is re-read after the reassignment and its live
  // Architect caller is adopted, so the review alias is recorded once, against the current plan.
  await expect(
    reassigned.f.runtime.command(
      reviewInputCommand(
        reassigned.f,
        reassigned.attempt,
        reassigned.reviewInputID,
        "review-owner-race",
      ),
      "owner",
    ),
  ).resolves.toMatchObject({ status: "reconciling" })
  expect(reassigned.f.store.plan(reassigned.f.receipt.planID)?.owner).toBe("owner")
  expect(
    reassigned.f.store.latestTransition(
      reassigned.f.receipt.planID,
      reassigned.attempt.task_id,
      "WORKER_REVIEW_INPUT_RECONCILED",
    ),
  ).toBeDefined()
})

test.each(["new-input", "new-execution"] as const)(
  "a concurrent %s during deferred owner observation rejects review reconciliation",
  async (change) => {
    const { f, attempt, worker, reviewInputID } = await heldReviewInputFixture()
    const originalSession = f.host.session
    let ownerReads = 0
    let signalOwnerRead!: () => void
    let resumeOwnerRead!: () => void
    const ownerReadStarted = new Promise<void>((resolve) => {
      signalOwnerRead = resolve
    })
    const ownerReadGate = new Promise<void>((resolve) => {
      resumeOwnerRead = resolve
    })
    f.host.session = async (id, options) => {
      const snapshot = await originalSession(id, options)
      if (id === "owner" && !options?.messages && ++ownerReads === 3) {
        signalOwnerRead()
        await ownerReadGate
      }
      return snapshot
    }
    const pendingReconciliation = f.runtime.command(
      reviewInputCommand(f, attempt, reviewInputID, `review-${change}-race`),
      "owner",
    )
    await ownerReadStarted
    if (change === "new-input") {
      worker.messages.push({ id: "msg_later_input", type: "synthetic", text: "Later input" })
      worker.turn = { inputID: "msg_later_input", state: "completed" }
    } else {
      worker.busy = true
      worker.outcome = undefined
    }
    resumeOwnerRead()
    await expect(pendingReconciliation).rejects.toThrow()
    expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
    expect(
      f.store.latestTransition(f.receipt.planID, attempt.task_id, "WORKER_REVIEW_INPUT_RECONCILED"),
    ).toBeUndefined()
    expect(
      f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
    ).toBe(false)
    expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
  },
)

test("an admitted review alias does not match a later unrelated native current input", async () => {
  const { f, attempt, worker, reviewInputID } = await heldReviewInputFixture()
  await f.runtime.command(
    reviewInputCommand(f, attempt, reviewInputID, "review-then-later-input"),
    "owner",
  )
  worker.messages.push({ id: "msg_later_unrelated_input", type: "synthetic", text: "Later input" })
  worker.turn = { inputID: "msg_later_unrelated_input", state: "completed" }
  await f.runtime.tick()
  expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
  expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(false)
})

test("a changed current attempt during native review observation rejects the stale alias", async () => {
  const { f, attempt, reviewInputID } = await heldReviewInputFixture()
  const originalSession = f.host.session
  let ownerReads = 0
  let signalOwnerRead!: () => void
  let resumeOwnerRead!: () => void
  const ownerReadStarted = new Promise<void>((resolve) => {
    signalOwnerRead = resolve
  })
  const ownerReadGate = new Promise<void>((resolve) => {
    resumeOwnerRead = resolve
  })
  f.host.session = async (id, options) => {
    const snapshot = await originalSession(id, options)
    if (id === "owner" && !options?.messages && ++ownerReads === 3) {
      signalOwnerRead()
      await ownerReadGate
    }
    return snapshot
  }
  const pendingReconciliation = f.runtime.command(
    reviewInputCommand(f, attempt, reviewInputID, "review-attempt-race"),
    "owner",
  )
  await ownerReadStarted
  const replacementAttemptID = crypto.randomUUID()
  const replacementSessionID = "ses_changed_during_review_observation"
  const replacementMessageID = "msg_changed_during_review_observation"
  f.store.atomic((db) => {
    db.query("UPDATE runner_attempts SET state='failed' WHERE id=?").run(attempt.id)
    db.query(
      `INSERT INTO runner_attempts(
         id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,
         policy,state,started_at,token_count,tool_count,retry_count,cost
       ) VALUES(?,?,?,?,?,?,?,?,NULL,?,'running',?,NULL,0,0,NULL)`,
    ).run(
      replacementAttemptID,
      attempt.plan_id,
      attempt.task_id,
      attempt.number + 1,
      replacementSessionID,
      replacementMessageID,
      attempt.workspace,
      attempt.base_commit,
      attempt.policy,
      Date.now() + 1,
    )
  })
  resumeOwnerRead()
  await expect(pendingReconciliation).rejects.toThrow(
    "Review input worker assignment changed during native observation",
  )
  expect(f.store.attempts(f.receipt.planID)).toHaveLength(2)
  expect(f.store.attempts(f.receipt.planID)[1]).toMatchObject({
    id: replacementAttemptID,
    session_id: replacementSessionID,
    message_id: replacementMessageID,
    state: "running",
  })
  expect(
    f.store.latestTransition(f.receipt.planID, attempt.task_id, "WORKER_REVIEW_INPUT_RECONCILED"),
  ).toBeUndefined()
  expect(
    f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
  ).toBe(false)
})

test.each(["projectID", "taskID", "attemptID", "sessionID", "assignedMessageID"] as const)(
  "a persisted foreign %s review alias cannot verify the original attempt",
  async (field) => {
    const { f, attempt, reviewInputID } = await heldReviewInputFixture()
    await f.runtime.command(
      reviewInputCommand(f, attempt, reviewInputID, `review-foreign-alias-${field}`),
      "owner",
    )
    const row = f.store.atomic((db) =>
      db
        .query<{ id: number; payload: string }, [string, string]>(
          `SELECT id,payload FROM runner_transitions
           WHERE plan_id=? AND task_id=? AND event='WORKER_REVIEW_INPUT_RECONCILED'`,
        )
        .get(f.receipt.planID, attempt.task_id)!,
    )
    const payload = JSON.parse(row.payload) as Record<string, unknown>
    payload[field] = field === "projectID" ? "foreign-project" : crypto.randomUUID()
    f.store.atomic((db) =>
      db
        .query("UPDATE runner_transitions SET payload=? WHERE id=?")
        .run(JSON.stringify(payload), row.id),
    )
    await f.runtime.tick()
    expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
    expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
    expect(
      f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
    ).toBe(false)
  },
)

test.each(["unconfirmed", "foreign", "stale-assignment"])(
  "reminder completion rejects %s lineage",
  async (mode) => {
    const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
    await runPlan(f)
    await f.runtime.tick()
    const attempt = f.store.attempts(f.receipt.planID)[0]!
    const worker = f.sessions.get(attempt.session_id)!
    const claim = f.runtime.progress.claimReminder(
      attempt.session_id,
      "Remaining handoff",
      "msg_claimed_handoff",
    )!
    f.runtime.progress.finishReminder(claim, mode === "unconfirmed" ? "unknown" : "admitted")
    if (mode === "stale-assignment")
      f.store.atomic((db) =>
        db
          .query("UPDATE runner_attempts SET message_id=? WHERE id=?")
          .run("msg_resumed_assignment", attempt.id),
      )
    const inputID = mode === "foreign" ? "msg_foreign_synthetic" : claim.messageID
    worker.busy = false
    worker.outcome = "succeeded"
    worker.turn = { inputID, state: "completed" }

    await f.runtime.tick()
    expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
    expect(f.store.attempts(f.receipt.planID)).toHaveLength(1)
    expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("running")
    expect(
      f.store.effects(f.receipt.planID).some((effect) => effect.kind.startsWith("verify:")),
    ).toBe(false)
  },
)

test.each([false, true])(
  "a deferred blocked tick cannot undo resume or a later cancellation (cancel=%s)",
  async (cancelAfterResume) => {
    const f = fixture({ wrongFirstA: true, taskFiles: [{ name: "a", path: "a.txt" }] })
    await runPlan(f)
    await drive(f.runtime, 4)
    const planID = f.receipt.planID
    const attempt = f.store.attempts(planID)[0]!
    expect(f.store.plan(planID)?.state).toBe("blocked")
    expect(attempt.state).toBe("failed")

    const originalSession = f.host.session
    let entered!: () => void
    let release!: () => void
    const reading = new Promise<void>((resolve) => (entered = resolve))
    const paused = new Promise<void>((resolve) => (release = resolve))
    let defer = true
    f.host.session = async (id, options) => {
      const session = await originalSession(id, options)
      if (id === "owner" && defer) {
        defer = false
        entered()
        await paused
      }
      return session
    }

    const staleTick = f.runtime.tick()
    await reading
    let resumedInput: string
    try {
      await f.runtime.command(
        {
          requestID: "resume-during-owner-read",
          planID,
          action: "resume",
          taskID: attempt.task_id,
          reason: "Continue the stopped attempt after repairing its verification failure",
        },
        "owner",
      )
      resumedInput = f.store.attempts(planID)[0]!.message_id
      expect(resumedInput).not.toBe(attempt.message_id)
      if (cancelAfterResume)
        await f.runtime.command(
          {
            requestID: "cancel-after-resume",
            planID,
            action: "cancel",
          },
          "owner",
        )
    } finally {
      release()
    }
    await staleTick

    if (cancelAfterResume)
      expect(["cancelling", "cancelled"]).toContain(f.store.plan(planID)!.state)
    else expect(f.store.plan(planID)?.state).toBe("running")
    expect(f.store.attempts(planID)[0]).toMatchObject({
      id: attempt.id,
      session_id: attempt.session_id,
      workspace: attempt.workspace,
      message_id: resumedInput!,
    })
    if (cancelAfterResume)
      expect(["preparing", "cancelled"]).toContain(f.store.attempts(planID)[0]!.state)
    else expect(f.store.attempts(planID)[0]?.state).toBe("preparing")
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
    await f.runtime.tick()
    expect(f.store.attempts(planID)[0]?.state).toBe(cancelAfterResume ? "cancelled" : "running")
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(
      cancelAfterResume ? 1 : 2,
    )
    expect(f.store.attempts(planID)).toHaveLength(1)
  },
)
