import { expect, test } from "bun:test"
import type {
  ObservationChange,
  ObservationScope,
  TrajectoryResponse,
} from "../../src/observability/contract.ts"
import { ObservationChangeTracker } from "../../src/observability/changes.ts"
import { ObservationReads } from "../../src/observability/read.ts"
import { selectedAttemptFor, TrajectoryPanelState } from "../../src/trajectory-panel/panel-state.ts"
import { checkKey, detailedChecks } from "../../src/trajectory-panel/projection.ts"
import type { TrajectoryTransport } from "../../src/trajectory-panel/projection.ts"
import type { TaskTrajectoryTarget } from "../../src/trajectory-panel/panel-state.ts"
import { firstAttemptID, makeFixture, secondAttemptID, taskID } from "../trajectory/fixture.ts"

const cursorSecret = new Uint8Array(32).fill(8)
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const targetFor = (
  fixture: ReturnType<typeof makeFixture>,
  id: string,
  reference: string,
  requestID: string,
): TaskTrajectoryTarget => ({
  requestID,
  taskID: id,
  reference,
  projectID: "project",
  projectDirectory: fixture.directory,
})

function transportFor(
  fixture: ReturnType<typeof makeFixture>,
  tracker: ObservationChangeTracker,
  online = () => true,
) {
  const reads = new ObservationReads(fixture.store, fixture.host, "project", cursorSecret)
  let deliver: ((event: ObservationChange | null) => void) | undefined
  let snapshotCount = 0
  const transport: TrajectoryTransport = {
    snapshot: async (scope, signal) => {
      if (signal.aborted) throw signal.reason
      snapshotCount++
      return reads.snapshot(scope, tracker)
    },
    trajectory: async (scope, id, signal, cursor) => {
      if (signal.aborted) throw signal.reason
      return reads.trajectory(
        { scope, taskID: id, limit: 50, ...(cursor ? { cursor } : {}) },
        tracker,
      )
    },
    changes: (signal) =>
      (async function* () {
        while (!signal.aborted) {
          const event = await new Promise<ObservationChange | null>((resolve) => {
            deliver = resolve
            signal.addEventListener("abort", () => resolve(null), { once: true })
          })
          if (!event) return
          yield event
        }
      })(),
    online,
  }
  return {
    transport,
    publish: (event: ObservationChange) => deliver?.(event),
    snapshotCount: () => snapshotCount,
  }
}

async function waitFor(state: TrajectoryPanelState, predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await tick()
  }
  throw new Error(`Timed out waiting for trajectory state: ${JSON.stringify(state.data)}`)
}

test("plan checks and unassociated events never inherit the latest worker attempt", async () => {
  const fixture = makeFixture()
  const tracker = new ObservationChangeTracker(fixture.repository, cursorSecret, "project")
  tracker.initialize()
  const { transport } = transportFor(fixture, tracker)
  const state = new TrajectoryPanelState(() => {})
  try {
    state.connect(
      "view",
      "project",
      fixture.directory,
      { kind: "project", sessionID: "ses-owner" },
      transport,
      {
        taskID,
        selection: null,
      },
    )
    await waitFor(state, () => state.data.report !== undefined && !state.data.loading)
    const planCheck = detailedChecks(state.data.report!).find((check) => check.scope === "plan")!
    expect(planCheck.attemptID).toBeNull()
    state.selectCheck(checkKey(planCheck))
    expect(selectedAttemptFor(state.data)).toBeUndefined()
    const unassociated = { id: "plan-event", kind: "runner-transition", attemptID: null }
    state.data.events.push(unassociated)
    state.selectEvent(unassociated.id)
    expect(selectedAttemptFor(state.data)).toBeUndefined()
    state.selectAttempt(secondAttemptID)
    expect(selectedAttemptFor(state.data)?.id).toBe(secondAttemptID)
    expect(selectedAttemptFor({ ...state.data, selection: null })?.id).toBe(secondAttemptID)
    expect(
      selectedAttemptFor({ ...state.data, selection: { kind: "attempt", id: "unavailable" } }),
    ).toBeUndefined()
  } finally {
    state.close()
    fixture.close()
  }
})

test("projection-backed panel retains failed-attempt selection and all-attempt unique-session totals on late updates", async () => {
  const fixture = makeFixture()
  const tracker = new ObservationChangeTracker(fixture.repository, cursorSecret, "project")
  tracker.initialize()
  const { transport, publish } = transportFor(fixture, tracker)
  const state = new TrajectoryPanelState(() => {})
  try {
    state.connect(
      "project-view",
      "project",
      fixture.directory,
      { kind: "project", sessionID: "ses-owner" },
      transport,
      { taskID, selection: null },
    )
    await waitFor(state, () => state.data.report !== undefined && !state.data.loading)
    state.selectAttempt(secondAttemptID)
    const before = state.data.report!.effort.tokenUsage.measuredSubtotal
    expect(state.data.report!.attempts.map((attempt) => attempt.state)).toEqual([
      "failed",
      "accepted",
    ])
    expect(state.data.report!.effort.recordedCost.apiEquivalentTotalUsd).toBeNull()
    expect(state.data.report!.effort.tokenUsage.totalSessions).toBe(2)
    expect(JSON.stringify(state.data)).not.toContain("PRIVATE REASONING DO NOT EXPORT")

    fixture.store.atomic((db) =>
      db
        .query(
          "INSERT INTO runner_attempts(id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,state,started_at,token_count,tool_count,retry_count,cost) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          "e4a18e7b-9196-450b-9bd7-82a058b9d8a1",
          fixture.receipt.planID,
          taskID,
          3,
          "ses-third",
          "msg-third",
          fixture.directory,
          "a".repeat(40),
          null,
          JSON.stringify({ model: { providerID: "openai", id: "gpt-6-luna" } }),
          "failed",
          4_500,
          999,
          4,
          1,
          null,
        ),
    )
    tracker.refreshSource()
    publish({
      projectID: "project",
      sequence: tracker.sequence,
      repositoryVersion: fixture.repository.version(),
      sourceRevision: tracker.sourceRevision,
      nativeRevision: tracker.nativeRevision,
      cause: "runner",
      resnapshotRequired: false,
    })
    await waitFor(state, () => state.data.report?.attempts.length === 3)
    expect(state.data.selection).toEqual({ kind: "attempt", id: secondAttemptID })
    expect(state.data.report!.effort.tokenUsage.totalSessions).toBe(3)
    expect(state.data.report!.effort.tokenUsage.knownSessions).toBe(2)
    expect(state.data.report!.effort.tokenUsage.total).toBeNull()
    expect(state.data.report!.effort.tokenUsage.measuredSubtotal).toEqual(before)
    expect(state.data.report!.effort.toolCalls.count).toBe(9)

    const event = state.data.events[0]
    expect(event).toBeDefined()
    state.selectEvent(event!.id)
    await state.refresh()
    expect(state.data.selection).toEqual({ kind: "event", id: event!.id })
  } finally {
    state.close()
    fixture.close()
  }
})

test("scope reconnect keeps an in-scope task/attempt and rejects late responses from the previous scope", async () => {
  const fixture = makeFixture()
  const tracker = new ObservationChangeTracker(fixture.repository, cursorSecret, "project")
  tracker.initialize()
  const { transport: oldTransport } = transportFor(fixture, tracker)
  const { transport: newTransport } = transportFor(fixture, tracker)
  let holdOld = true
  const originalSnapshot = oldTransport.snapshot
  oldTransport.snapshot = async (scope: ObservationScope, signal: AbortSignal) => {
    if (holdOld) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      holdOld = false
    }
    return originalSnapshot(scope, signal)
  }
  const state = new TrajectoryPanelState(() => {})
  try {
    state.connect(
      "old-project-scope",
      "project",
      fixture.directory,
      { kind: "project", sessionID: "ses-owner" },
      oldTransport,
      { taskID, selection: { kind: "attempt", id: secondAttemptID } },
    )
    state.connect(
      "new-worker-session-scope",
      "project",
      fixture.directory,
      { kind: "session", sessionID: "ses-failed" },
      newTransport,
      { taskID, selection: { kind: "attempt", id: secondAttemptID } },
    )
    await waitFor(
      state,
      () => state.data.key === "new-worker-session-scope" && state.data.report !== undefined,
    )
    await tick()
    expect(state.data.snapshot?.scope.kind).toBe("session")
    expect(state.data.taskID).toBe(taskID)
    expect(state.data.selection).toEqual({ kind: "attempt", id: secondAttemptID })
    expect(state.data.report!.attempts.map((attempt) => attempt.id)).toHaveLength(2)
  } finally {
    state.close()
    fixture.close()
  }
})

test("an external historical target bypasses snapshot choices and loads its reference and every attempt", async () => {
  const fixture = makeFixture()
  const tracker = new ObservationChangeTracker(fixture.repository, cursorSecret, "project")
  tracker.initialize()
  const { transport } = transportFor(fixture, tracker)
  const originalSnapshot = transport.snapshot
  transport.snapshot = async (scope, signal) => {
    const snapshot = await originalSnapshot(scope, signal)
    return { ...snapshot, plans: [], unplannedTasks: [] }
  }
  const state = new TrajectoryPanelState(() => {})
  const reference = fixture.repository.referenceFor(taskID)!
  try {
    state.connect(
      "history",
      "project",
      fixture.directory,
      { kind: "project", sessionID: "ses-owner" },
      transport,
      {
        taskID: null,
        selection: null,
        target: targetFor(fixture, taskID, reference, "request-history"),
      },
    )
    await waitFor(state, () => Boolean(state.data.report) && !state.data.loading)
    expect(state.data.taskID).toBe(taskID)
    expect(state.data.taskReference).toBe(reference)
    expect(state.data.report?.task.id).toBe(taskID)
    expect(state.data.report?.attempts.map((attempt) => attempt.id)).toEqual([
      firstAttemptID,
      secondAttemptID,
    ])
    expect(state.data.tasks).toContainEqual(expect.objectContaining({ taskID, title: reference }))
  } finally {
    state.close()
    fixture.close()
  }
})

test("deferred task A cannot replace unavailable target B or fall back to A", async () => {
  const fixture = makeFixture()
  const tracker = new ObservationChangeTracker(fixture.repository, cursorSecret, "project")
  tracker.initialize()
  const { transport } = transportFor(fixture, tracker)
  const originalTrajectory = transport.trajectory
  const aResponse = await originalTrajectory(
    { kind: "project", sessionID: "ses-owner" },
    taskID,
    new AbortController().signal,
  )
  const pendingA = deferred<TrajectoryResponse>()
  const requested: string[] = []
  transport.trajectory = async (_scope, id) => {
    requested.push(id)
    if (id === taskID) return pendingA.promise
    throw new Error("Task history is unavailable")
  }
  const state = new TrajectoryPanelState(() => {})
  const targetA = targetFor(fixture, taskID, "LZ-1", "request-a")
  const taskB = "00000000-0000-4000-8000-000000000002"
  const targetB = targetFor(fixture, taskB, "LZ-2", "request-b")
  try {
    state.connect(
      "history",
      "project",
      fixture.directory,
      { kind: "project", sessionID: "ses-owner" },
      transport,
      { taskID: null, selection: null, target: targetA },
    )
    await waitFor(state, () => requested.includes(taskID))
    state.selectTarget(targetB)
    await waitFor(state, () => state.data.error.includes("LZ-2"))
    pendingA.resolve(aResponse)
    await tick()
    expect(requested).toEqual([taskID, taskB])
    expect(state.data.taskID).toBe(taskB)
    expect(state.data.taskReference).toBe("LZ-2")
    expect(state.data.report).toBeUndefined()
    expect(state.data.error).toContain("LZ-2")
    expect(state.data.tasks.some((task) => task.taskID === taskB && task.title === "LZ-2")).toBe(
      true,
    )
  } finally {
    state.close()
    fixture.close()
  }
})

test("a historical project target is rejected after switching to a different scope", async () => {
  const fixture = makeFixture()
  const tracker = new ObservationChangeTracker(fixture.repository, cursorSecret, "project")
  tracker.initialize()
  const { transport } = transportFor(fixture, tracker)
  let trajectoryCalls = 0
  const original = transport.trajectory
  transport.trajectory = async (...args) => {
    trajectoryCalls++
    return original(...args)
  }
  const state = new TrajectoryPanelState(() => {})
  try {
    state.connect(
      "session-scope",
      "project",
      fixture.directory,
      { kind: "session", sessionID: "ses-accepted" },
      transport,
      {
        taskID,
        selection: null,
        target: targetFor(fixture, taskID, "LZ-1", "stale-project-target"),
      },
    )
    expect(state.data.taskID).toBe(taskID)
    expect(state.data.error).toContain("unavailable in this project or scope")
    expect(state.data.report).toBeUndefined()
    expect(trajectoryCalls).toBe(0)
  } finally {
    state.close()
    fixture.close()
  }
})

test("disconnected transport retains scoped data and a reconnect refreshes it", async () => {
  const fixture = makeFixture()
  const tracker = new ObservationChangeTracker(fixture.repository, cursorSecret, "project")
  tracker.initialize()
  let online = true
  const { transport } = transportFor(fixture, tracker, () => online)
  const state = new TrajectoryPanelState(() => {})
  try {
    state.connect(
      "session-view",
      "project",
      fixture.directory,
      { kind: "session", sessionID: "ses-failed" },
      transport,
      { taskID, selection: null },
    )
    await waitFor(state, () => state.data.report !== undefined)
    const original = state.data.report
    online = false
    await state.refresh()
    expect(state.data.stale).toBe(true)
    expect(state.data.report).toBe(original)
    online = true
    await state.refresh()
    expect(state.data.stale).toBe(false)
    expect(state.data.taskID).toBe(taskID)
  } finally {
    state.close()
    fixture.close()
  }
})

test("explicit projection gaps resnapshot even when their sequence is not newer", async () => {
  const fixture = makeFixture()
  const tracker = new ObservationChangeTracker(fixture.repository, cursorSecret, "project")
  tracker.initialize()
  const { transport, publish, snapshotCount } = transportFor(fixture, tracker)
  const state = new TrajectoryPanelState(() => {})
  try {
    state.connect(
      "session-view",
      "project",
      fixture.directory,
      { kind: "session", sessionID: "ses-failed" },
      transport,
      { taskID, selection: null },
    )
    await waitFor(state, () => state.data.snapshot !== undefined && state.data.report !== undefined)
    const before = snapshotCount()
    const boundary = state.data.snapshot!.boundary
    publish({
      projectID: "project",
      sequence: Math.max(1, boundary.eventSequence),
      repositoryVersion: boundary.repositoryVersion,
      sourceRevision: boundary.sourceRevision,
      nativeRevision: boundary.nativeRevision,
      cause: "gap",
      resnapshotRequired: true,
    })
    await waitFor(state, () => snapshotCount() > before)
  } finally {
    state.close()
    fixture.close()
  }
})
