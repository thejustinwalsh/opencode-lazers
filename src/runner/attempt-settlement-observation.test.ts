import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { sameNativeModel } from "./model-route.ts"
import type { HostSession } from "./host.ts"
import type { AttemptRow } from "./store.ts"
import { completedIdleAttemptSettlementObservation } from "./attempt-settlement-observation.ts"
import { fixture, runPlan, useRuntimeFixtureCleanup } from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

async function blockedAttemptFixture() {
  let now = Date.now()
  const f = fixture({
    delayed: true,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
  })
  await runPlan(f)
  await f.runtime.tick()
  const planID = f.receipt.planID
  const attempt = f.store.attempts(planID)[0]!
  f.store.atomic((db) =>
    db
      .query(
        "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'blocked'),reason='manual hold',version=version+1 WHERE id=?",
      )
      .run(planID),
  )
  await f.runtime.tick()
  return {
    f,
    planID,
    attempt,
    now: () => now,
    advance: (milliseconds: number) => {
      now += milliseconds
      return now
    },
  }
}

function idleCompletedSession(
  attempt: AttemptRow,
  session: HostSession,
): HostSession & { idleAt: number } {
  const completed = structuredClone(session)
  completed.busy = false
  completed.pendingInput = false
  completed.pendingPermissions = 0
  completed.pendingForms = 0
  completed.observationUnstable = false
  completed.runningShells = 0
  completed.activeChildren = 0
  completed.outcome = undefined
  completed.turn = { inputID: attempt.message_id, state: "completed" }
  const idleAt = Math.max(Date.now(), attempt.started_at + 1)
  return { ...completed, idleAt }
}

test("an exact idle completed input without a session outcome produces a settlement proof", async () => {
  const { f, attempt } = await blockedAttemptFixture()
  const worker = idleCompletedSession(attempt, f.sessions.get(attempt.session_id)!)
  const observation = completedIdleAttemptSettlementObservation({
    attempt,
    session: worker,
    projectID: "project",
    matchesWorkerInput: (inputID) => inputID === attempt.message_id,
    sameModel: sameNativeModel,
  })

  expect(observation).toEqual({
    schema: "lazers-attempt-settlement-observation/v1",
    kind: "completed-idle-assignment-without-outcome",
    attemptID: attempt.id,
    sessionID: attempt.session_id,
    projectID: "project",
    workspace: attempt.workspace,
    inputID: attempt.message_id,
    turnState: "completed",
    outcome: null,
    idleAt: worker.idleAt,
    busy: false,
    pendingInput: false,
    pendingPermissions: 0,
    pendingForms: 0,
    observationUnstable: false,
    runningShells: 0,
    activeChildren: 0,
  })
})

test("settlement proof rejects active, pending, foreign, interrupted, or otherwise uncertain sessions", async () => {
  const { f, attempt } = await blockedAttemptFixture()
  const worker = idleCompletedSession(attempt, f.sessions.get(attempt.session_id)!)
  const mutate = (change: (session: HostSession) => void) => {
    const candidate = structuredClone(worker)
    change(candidate)
    return completedIdleAttemptSettlementObservation({
      attempt,
      session: candidate,
      projectID: "project",
      matchesWorkerInput: (inputID) => inputID === attempt.message_id,
      sameModel: sameNativeModel,
    })
  }

  const rejected: [string, (session: HostSession) => void][] = [
    ["busy", (session) => (session.busy = true)],
    ["pending input", (session) => (session.pendingInput = true)],
    ["unknown input state", (session) => (session.pendingInput = undefined)],
    ["pending permission", (session) => (session.pendingPermissions = 1)],
    ["pending form", (session) => (session.pendingForms = 1)],
    ["unstable observation", (session) => (session.observationUnstable = true)],
    ["running shell", (session) => (session.runningShells = 1)],
    ["active child", (session) => (session.activeChildren = 1)],
    ["reported success", (session) => (session.outcome = "succeeded")],
    ["reported failure", (session) => (session.outcome = "failed")],
    [
      "interrupted continuation",
      (session) => {
        session.outcome = "interrupted"
        session.turn = { inputID: attempt.message_id, state: "interrupted" }
      },
    ],
    ["foreign input", (session) => (session.turn = { inputID: "msg_foreign", state: "completed" })],
    [
      "pending turn",
      (session) => (session.turn = { inputID: attempt.message_id, state: "pending" }),
    ],
    ["archived", (session) => (session.archived = true)],
    ["foreign session", (session) => (session.id = "ses_foreign")],
    ["foreign project", (session) => (session.projectID = "project_foreign")],
    ["foreign workspace", (session) => (session.directory = "/elsewhere")],
    ["foreign agent", (session) => (session.agent = "architect")],
    [
      "foreign attempt",
      (session) => {
        session.metadata = { ...session.metadata, lazersAttemptID: "attempt_foreign" }
      },
    ],
    ["changed route", (session) => (session.model = { providerID: "other", id: "model" })],
    ["missing idle proof", (session) => (session.idleAt = undefined)],
    ["idle before attempt", (session) => (session.idleAt = attempt.started_at - 1)],
  ]

  expect(
    completedIdleAttemptSettlementObservation({
      attempt,
      session: worker,
      projectID: "project",
      matchesWorkerInput: (inputID) => inputID === attempt.message_id,
      sameModel: sameNativeModel,
    }),
  ).toBeDefined()
  for (const [reason, change] of rejected) expect(mutate(change), reason).toBeUndefined()
  expect(
    completedIdleAttemptSettlementObservation({
      attempt,
      session: worker,
      projectID: "project",
      matchesWorkerInput: () => false,
      sameModel: sameNativeModel,
    }),
  ).toBeUndefined()
  expect(
    completedIdleAttemptSettlementObservation({
      attempt,
      session: worker,
      projectID: "project",
      matchesWorkerInput: (inputID) => inputID === attempt.message_id,
      sameModel: () => false,
    }),
  ).toBeUndefined()
})

test("blocked stale attempts settle on an exact live completion, preserve lineage and release reservation", async () => {
  const { f, planID, attempt, advance } = await blockedAttemptFixture()
  const worker = f.sessions.get(attempt.session_id)!
  const artifact = f.base
  f.store.atomic((db) => {
    db.query(
      "UPDATE runner_attempts SET artifact=?,token_count=19,tool_count=4,cost=0.5 WHERE id=?",
    ).run(artifact, attempt.id)
    db.query("UPDATE runner_nodes SET artifact=? WHERE plan_id=? AND task_id=?").run(
      artifact,
      planID,
      attempt.task_id,
    )
  })
  worker.busy = false
  worker.pendingInput = false
  worker.pendingPermissions = 0
  worker.pendingForms = 0
  worker.observationUnstable = false
  worker.runningShells = 0
  worker.activeChildren = 0
  worker.outcome = undefined
  worker.turn = { inputID: attempt.message_id, state: "completed" }
  worker.idleAt = advance(61_001)
  worker.tokens = 12
  worker.tools = 2

  expect(f.store.dispatchReservations().map((reservation) => reservation.taskID)).toContain(
    attempt.task_id,
  )
  const originalEffects = f.store.effects(planID).map(({ id, state, receipt }) => ({
    id,
    state,
    receipt,
  }))

  await f.runtime.tick()

  const settled = f.store.attempts(planID).find((candidate) => candidate.id === attempt.id)!
  expect(settled).toMatchObject({
    id: attempt.id,
    state: "failed",
    session_id: attempt.session_id,
    message_id: attempt.message_id,
    workspace: attempt.workspace,
    policy: attempt.policy,
    artifact,
    token_count: 19,
    tool_count: 4,
    cost: 0.5,
  })
  expect(existsSync(attempt.workspace)).toBe(true)
  expect(f.store.dispatchReservations().map((reservation) => reservation.taskID)).not.toContain(
    attempt.task_id,
  )
  expect(
    f.store.latestTransition<{
      cause: string
      workerObservation?: Record<string, unknown>
    }>(planID, attempt.task_id, "ATTEMPT_STALE_SETTLED"),
  ).toMatchObject({
    attemptID: attempt.id,
    from: "running",
    to: "failed",
    planState: "blocked",
    cause: "session-live-idle-exact-completed-input",
    workerObservation: {
      kind: "completed-idle-assignment-without-outcome",
      attemptID: attempt.id,
      sessionID: attempt.session_id,
      workspace: attempt.workspace,
      inputID: attempt.message_id,
      turnState: "completed",
      outcome: null,
      idleAt: worker.idleAt,
    },
  })
  expect(f.store.effects(planID).map(({ id, state, receipt }) => ({ id, state, receipt }))).toEqual(
    originalEffects,
  )

  await f.runtime.tick()
  expect(
    f.store
      .activity(planID, attempt.task_id)
      .filter((event) => event.event === "ATTEMPT_STALE_SETTLED"),
  ).toHaveLength(1)
  expect(f.store.attempts(planID).find((candidate) => candidate.id === attempt.id)?.state).toBe(
    "failed",
  )

  const retry = await f.runtime.command(
    {
      requestID: "retry-exactly-settled-attempt",
      planID,
      action: "retry",
      taskID: attempt.task_id,
      reason: "Retry after the exact completed worker input was settled",
    },
    "owner",
  )
  expect(retry).toMatchObject({ status: "retrying" })
  expect(f.store.attempts(planID).find((candidate) => candidate.id === attempt.id)).toMatchObject({
    session_id: attempt.session_id,
    message_id: attempt.message_id,
    workspace: attempt.workspace,
    artifact,
  })
})

test("a scope decision hold keeps an exact idle completion attached to its attempt", async () => {
  const { f, planID, attempt, advance } = await blockedAttemptFixture()
  const reason = "Architect must review the worker's scope"
  f.store.record(planID, attempt.task_id, "SCOPE_DECISION_REQUIRED", {
    attemptID: attempt.id,
    reason,
  })
  f.store.atomic((db) =>
    db.query("UPDATE runner_plans SET reason=?,version=version+1 WHERE id=?").run(reason, planID),
  )
  const worker = f.sessions.get(attempt.session_id)!
  worker.busy = false
  worker.pendingInput = false
  worker.pendingPermissions = 0
  worker.pendingForms = 0
  worker.observationUnstable = false
  worker.runningShells = 0
  worker.activeChildren = 0
  worker.outcome = undefined
  worker.turn = { inputID: attempt.message_id, state: "completed" }
  worker.idleAt = advance(61_001)

  await f.runtime.tick()

  expect(f.store.attempts(planID).find((candidate) => candidate.id === attempt.id)?.state).toBe(
    "running",
  )
  expect(f.store.dispatchReservations().map((reservation) => reservation.taskID)).toContain(
    attempt.task_id,
  )
  expect(f.store.latestTransition(planID, attempt.task_id, "ATTEMPT_STALE_SETTLED")).toBeUndefined()
})

test("a concurrent reconciliation invalidates the stale completion observation", async () => {
  const { f, planID, attempt, advance } = await blockedAttemptFixture()
  const worker = f.sessions.get(attempt.session_id)!
  worker.busy = false
  worker.pendingInput = false
  worker.pendingPermissions = 0
  worker.pendingForms = 0
  worker.observationUnstable = false
  worker.runningShells = 0
  worker.activeChildren = 0
  worker.outcome = undefined
  worker.turn = { inputID: attempt.message_id, state: "completed" }
  worker.idleAt = advance(61_001)

  const snapshot = structuredClone(worker)
  const originalSession = f.host.session
  let deferred = false
  let enterRead!: () => void
  let releaseRead!: () => void
  const readStarted = new Promise<void>((resolve) => {
    enterRead = resolve
  })
  const readBarrier = new Promise<void>((resolve) => {
    releaseRead = resolve
  })
  f.host.session = async (sessionID, options) => {
    if (sessionID === attempt.session_id && options?.messages && !deferred) {
      deferred = true
      enterRead()
      await readBarrier
      return structuredClone(snapshot)
    }
    return originalSession(sessionID, options)
  }

  const tick = f.runtime.tick()
  await readStarted
  try {
    await f.runtime.command(
      {
        requestID: "reconcile-during-stale-completion",
        planID,
        action: "reconcile",
        reason: "Review this exact worker completion",
      },
      "owner",
    )
  } finally {
    releaseRead()
  }
  await tick

  expect(f.store.plan(planID)?.state).toBe("running")
  expect(f.store.attempts(planID).find((candidate) => candidate.id === attempt.id)?.state).toBe(
    "running",
  )
  expect(f.store.latestTransition(planID, attempt.task_id, "ATTEMPT_STALE_SETTLED")).toBeUndefined()
  expect(f.store.dispatchReservations().map((reservation) => reservation.taskID)).toContain(
    attempt.task_id,
  )
})
