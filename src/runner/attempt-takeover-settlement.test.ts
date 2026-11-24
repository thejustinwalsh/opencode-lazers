import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { deferred, fixture, runPlan, useRuntimeFixtureCleanup } from "./runtime.fixture.ts"
import type { HostSession } from "./host.ts"
import type { AttemptRow } from "./store.ts"

useRuntimeFixtureCleanup()

async function blockedStaleAttemptFixture() {
  let now = Date.now()
  const f = fixture({
    delayed: true,
    now: () => now,
    taskFiles: [{ name: "a", path: "a.txt" }],
    takeover: { handoffWindowMs: 60_000, stopWaitMs: 50, pollMs: 5 },
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
  now += 61_001
  return { f, planID, attempt, now: () => now }
}

function completedIdleWorker(attempt: AttemptRow, worker: HostSession, now: number) {
  worker.busy = false
  worker.pendingInput = false
  worker.pendingPermissions = 0
  worker.pendingForms = 0
  worker.observationUnstable = false
  worker.runningShells = 0
  worker.activeChildren = 0
  worker.outcome = undefined
  worker.turn = { inputID: attempt.message_id, state: "completed" }
  worker.idleAt = now
}

async function startOpenTakeover(
  f: ReturnType<typeof fixture>,
  attempt: AttemptRow,
  requestID: string,
) {
  const notified = deferred<void>()
  f.host.steerWorker = async () => {
    notified.resolve()
  }
  const abort = new AbortController()
  const pending = f.runtime.takeover(
    {
      attemptID: attempt.id,
      reason: "Keep the live source worker owned during settlement observation",
      requestID,
    },
    "owner",
    abort.signal,
  )
  await notified.promise
  abort.abort()
  const result = await pending
  expect(result.status).toBe("in-progress")
  return result
}

test("a preexisting open takeover owns its idle source attempt before stale observation", async () => {
  const { f, planID, attempt, now } = await blockedStaleAttemptFixture()
  const worker = f.sessions.get(attempt.session_id)!
  worker.busy = true
  const takeover = await startOpenTakeover(f, attempt, "takeover-before-stale-observation")

  completedIdleWorker(attempt, worker, now())
  await f.runtime.tick()

  expect(f.store.latestTransition(planID, attempt.task_id, "ATTEMPT_STALE_SETTLED")).toBeUndefined()
  expect(f.store.attempts(planID).find((candidate) => candidate.id === attempt.id)).toMatchObject({
    state: "cancelled",
    session_id: attempt.session_id,
    message_id: attempt.message_id,
    workspace: attempt.workspace,
    policy: attempt.policy,
  })
  expect(
    f.store.latestTransition<{ takeoverID: string }>(planID, attempt.task_id, "TAKEOVER_STARTED")
      ?.takeoverID,
  ).toBe(takeover.takeoverID)
  expect(f.store.dispatchReservations().map((reservation) => reservation.taskID)).toContain(
    attempt.task_id,
  )
})

test("a takeover opened during deferred detailed observation fences stale settlement transactionally", async () => {
  const { f, planID, attempt, now } = await blockedStaleAttemptFixture()
  const worker = f.sessions.get(attempt.session_id)!
  completedIdleWorker(attempt, worker, now())
  const snapshot = structuredClone(worker)
  const originalSession = f.host.session
  const readStarted = deferred<void>()
  const releaseRead = deferred<void>()
  let deferredRead = false
  f.host.session = async (sessionID, options) => {
    if (sessionID === attempt.session_id && options?.messages && !deferredRead) {
      deferredRead = true
      readStarted.resolve()
      await releaseRead.promise
      return structuredClone(snapshot)
    }
    return originalSession(sessionID, options)
  }

  const tick = f.runtime.tick()
  await readStarted.promise
  worker.busy = true
  const takeover = await startOpenTakeover(f, attempt, "takeover-during-stale-observation")
  const takeoverState = f.store.read(
    (db) =>
      db
        .query<{ state: string }, [string]>("SELECT state FROM runner_takeovers WHERE id=?")
        .get(takeover.takeoverID)?.state,
  )
  expect(takeoverState).toBe("awaiting-handoff")

  releaseRead.resolve()
  await tick

  expect(f.store.latestTransition(planID, attempt.task_id, "ATTEMPT_STALE_SETTLED")).toBeUndefined()
  expect(f.store.attempts(planID).find((candidate) => candidate.id === attempt.id)).toMatchObject({
    state: "running",
    session_id: attempt.session_id,
    message_id: attempt.message_id,
    workspace: attempt.workspace,
    policy: attempt.policy,
  })
  expect(f.store.dispatchReservations().map((reservation) => reservation.taskID)).toContain(
    attempt.task_id,
  )
  expect(f.store.attempts(planID)).toHaveLength(1)
  expect(existsSync(attempt.workspace)).toBe(true)
})
