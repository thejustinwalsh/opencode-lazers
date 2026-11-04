import { expect, test } from "bun:test"
import type {
  ObservationChange,
  ObservationScope,
  TrajectoryHistoryResponse,
} from "../../src/observability/contract.ts"
import { ObservationChangeTracker } from "../../src/observability/changes.ts"
import { ObservationReads } from "../../src/observability/read.ts"
import { ProgressRecorder } from "../../src/progress/recorder.ts"
import type { TrajectoryHost } from "../../src/trajectory/native.ts"
import {
  selectedAttemptFor,
  selectedEventFor,
  TrajectoryPanelState,
} from "../../src/trajectory-panel/panel-state.ts"
import {
  checkKey,
  detailedChecks,
  eventPayload,
  eventTitle,
} from "../../src/trajectory-panel/projection.ts"
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
  const host: TrajectoryHost = {
    session: (id) => fixture.host.session(id),
    status: async (id) => {
      const session = fixture.sessions.get(id)
      return session
        ? { ...session, messages: null, messageStatus: "not-read", messageError: null }
        : null
    },
  }
  const reads = new ObservationReads(fixture.store, host, "project", cursorSecret)
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
    history: async (scope, id, signal, cursor, limit = 50) => {
      if (signal.aborted) throw signal.reason
      return reads.trajectoryHistory(
        { scope, taskID: id, limit, ...(cursor ? { cursor } : {}) },
        tracker,
      )
    },
    status: async (scope, id, signal) => {
      if (signal.aborted) throw signal.reason
      return reads.trajectoryStatus({ scope, taskID: id }, tracker)
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
  throw new Error(
    `Timed out waiting for trajectory state: ${JSON.stringify({ key: state.data.key, taskID: state.data.taskID, loading: state.data.loading, stale: state.data.stale, error: state.data.error })}`,
  )
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
  const originalHistory = transport.history
  const aResponse = await originalHistory(
    { kind: "project", sessionID: "ses-owner" },
    taskID,
    new AbortController().signal,
  )
  const pendingA = deferred<TrajectoryHistoryResponse>()
  const requested: string[] = []
  transport.history = async (_scope, id) => {
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
    await waitFor(state, () => state.data.historyError.includes("LZ-2"))
    pendingA.resolve(aResponse)
    await tick()
    expect(requested).toEqual([taskID, taskB])
    expect(state.data.taskID).toBe(taskB)
    expect(state.data.taskReference).toBe("LZ-2")
    expect(state.data.report).toBeUndefined()
    expect(state.data.historyError).toContain("LZ-2")
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
  let historyCalls = 0
  const original = transport.history
  transport.history = async (...args) => {
    historyCalls++
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
    expect(historyCalls).toBe(0)
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

test("expired history continuations retain old pages and require an explicit recapture", async () => {
  const fixture = makeFixture()
  const tracker = new ObservationChangeTracker(fixture.repository, cursorSecret, "project")
  tracker.initialize()
  const { transport } = transportFor(fixture, tracker)
  const originalHistory = transport.history
  const calls: Array<string | undefined> = []
  transport.history = async (scope, id, signal, cursor, _limit) => {
    calls.push(cursor)
    if (cursor)
      throw {
        type: "trajectory_history_unavailable",
        message: "Trajectory history expired; recapture explicitly",
        data: { reason: "expired", recovery: "recapture" },
      }
    return originalHistory(scope, id, signal, cursor, 2)
  }
  const state = new TrajectoryPanelState(() => {})
  try {
    state.connect(
      "expired-history",
      "project",
      fixture.directory,
      { kind: "session", sessionID: "ses-failed" },
      transport,
      { taskID, selection: null },
    )
    await waitFor(state, () => state.data.report !== undefined && !state.data.loading)
    const originalEvents = structuredClone(state.data.events)
    const originalCursor = state.data.eventCursor!
    const originalCapturedAt = state.data.historyCapturedAt
    const originalExpiresAt = state.data.historyExpiresAt
    state.selectEvent(originalEvents[0]!.id)
    const originalSelection = state.data.selection
    const originalPayload = structuredClone(state.data.selectionEventSnapshot)
    expect(originalCursor).not.toBeNull()
    await state.loadMoreActivity()
    expect(state.data.events).toEqual(originalEvents)
    expect(state.data.eventCursor).toBe(originalCursor)
    expect(state.data.historyError).toBe(
      "Captured history has expired. Recapture history to continue.",
    )
    expect(state.data.historyError).not.toContain("[object Object]")
    expect(state.data.selection).toEqual(originalSelection)
    expect(state.data.selectionEventSnapshot).toEqual(originalPayload)
    expect(state.data.historyCapturedAt).toBe(originalCapturedAt)
    expect(state.data.historyExpiresAt).toBe(originalExpiresAt)
    await state.refresh()
    expect(calls).toHaveLength(2)
    expect(calls[1]).toBe(originalCursor)
    expect(state.data.historyError).toBe(
      "Captured history has expired. Recapture history to continue.",
    )
    expect(state.data.stale).toBe(true)
    expect(state.data.events).toEqual(originalEvents)
    expect(state.data.eventCursor).toBe(originalCursor)
    expect(state.data.selectionEventSnapshot).toEqual(originalPayload)
    expect(state.data.historyCapturedAt).toBe(originalCapturedAt)
    expect(state.data.historyExpiresAt).toBe(originalExpiresAt)

    await state.recaptureActivity()
    expect(calls).toHaveLength(3)
    expect(calls[2]).toBeUndefined()
    expect(state.data.historyCapturedAt).not.toBeNull()
    expect(state.data.events).toHaveLength(2)
    expect(state.data.eventCursor).not.toBeNull()
    expect(state.data.historyError).toBe("")
    expect(state.data.stale).toBe(false)
    expect(state.data.selection).toEqual(originalSelection)
    expect(state.data.selectionEventSnapshot?.id).toBe(originalPayload?.id)
  } finally {
    state.close()
    fixture.close()
  }
})

test("history recovery remains available after a healthy snapshot before the first capture", async () => {
  const fixture = makeFixture()
  const tracker = new ObservationChangeTracker(fixture.repository, cursorSecret, "project")
  tracker.initialize()
  let online = true
  const { transport } = transportFor(fixture, tracker, () => online)
  const originalHistory = transport.history
  let historyAvailable = false
  transport.history = async (scope, id, signal, cursor, limit) => {
    if (!historyAvailable)
      throw {
        type: "trajectory_history_unavailable",
        message: "Trajectory history expired; recapture explicitly",
        data: { reason: "expired", recovery: "recapture" },
      }
    return originalHistory(scope, id, signal, cursor, limit)
  }
  const state = new TrajectoryPanelState(() => {})
  try {
    state.connect(
      "initial-history-recovery",
      "project",
      fixture.directory,
      { kind: "session", sessionID: "ses-failed" },
      transport,
      { taskID, selection: null },
    )
    await waitFor(state, () => Boolean(state.data.historyError) && !state.data.loading)
    expect(state.data.report).toBeUndefined()

    online = false
    await state.refresh()
    expect(state.data.error).toBe("Trajectory updates are disconnected.")
    expect(state.data.historyError).toContain("Recapture history")

    online = true
    await state.refresh()
    expect(state.data.report).toBeUndefined()
    expect(state.data.error).toBe("")
    expect(state.data.historyError).toContain("Recapture history")
    expect(state.data.stale).toBe(true)

    historyAvailable = true
    await state.recaptureActivity()
    expect(state.data.report).toBeDefined()
    expect(state.data.historyError).toBe("")
    expect(state.data.recapturingHistory).toBe(false)
  } finally {
    state.close()
    fixture.close()
  }
})

test("failed explicit recapture keeps the old capture and page union after healthy status", async () => {
  const fixture = makeFixture()
  const tracker = new ObservationChangeTracker(fixture.repository, cursorSecret, "project")
  tracker.initialize()
  const { transport } = transportFor(fixture, tracker)
  const initialHistory = transport.history
  transport.history = (scope, id, signal, cursor) => initialHistory(scope, id, signal, cursor, 2)
  const pageHistory = transport.history
  const state = new TrajectoryPanelState(() => {})
  try {
    state.connect(
      "recapture-preserves-old-history",
      "project",
      fixture.directory,
      { kind: "session", sessionID: "ses-failed" },
      transport,
      { taskID, selection: null },
    )
    await waitFor(state, () => state.data.report !== undefined && !state.data.loading)
    await state.loadMoreActivity()
    expect(state.data.events).toHaveLength(4)
    state.selectEvent(state.data.events[0]!.id)
    const oldReport = state.data.report
    const oldEvents = structuredClone(state.data.events)
    const oldCursor = state.data.eventCursor
    const oldCapturedAt = state.data.historyCapturedAt
    const oldExpiresAt = state.data.historyExpiresAt
    const oldSelection = state.data.selection
    const oldPayload = structuredClone(state.data.selectionEventSnapshot)
    const calls: Array<string | undefined> = []
    transport.history = async (scope, id, signal, cursor) => {
      calls.push(cursor)
      if (cursor)
        throw {
          type: "trajectory_history_unavailable",
          message: "Trajectory history expired; recapture explicitly",
          data: { reason: "expired", recovery: "recapture" },
        }
      return pageHistory(scope, id, signal, cursor, 2)
    }

    await state.recaptureActivity()
    expect(calls).toHaveLength(2)
    expect(calls[0]).toBeUndefined()
    expect(calls[1]).toBeTypeOf("string")
    expect(state.data.report).toBe(oldReport)
    expect(state.data.events).toEqual(oldEvents)
    expect(state.data.eventCursor).toBe(oldCursor)
    expect(state.data.historyCapturedAt).toBe(oldCapturedAt)
    expect(state.data.historyExpiresAt).toBe(oldExpiresAt)
    expect(state.data.selection).toEqual(oldSelection)
    expect(state.data.selectionEventSnapshot).toEqual(oldPayload)
    expect(state.data.historyError).toBe(
      "Captured history has expired. Recapture history to continue.",
    )
    expect(state.data.recapturingHistory).toBe(false)

    await state.refresh()
    expect(state.data.historyError).toBe(
      "Captured history has expired. Recapture history to continue.",
    )
    expect(state.data.stale).toBe(true)
    expect(state.data.events).toEqual(oldEvents)
    expect(state.data.eventCursor).toBe(oldCursor)
    expect(state.data.historyCapturedAt).toBe(oldCapturedAt)
    expect(state.data.historyExpiresAt).toBe(oldExpiresAt)
    expect(state.data.selection).toEqual(oldSelection)
    expect(state.data.selectionEventSnapshot).toEqual(oldPayload)
    expect(calls).toHaveLength(2)
  } finally {
    state.close()
    fixture.close()
  }
})

test("recapture rejects an empty nonadvancing continuation without replacing old history", async () => {
  const fixture = makeFixture()
  const tracker = new ObservationChangeTracker(fixture.repository, cursorSecret, "project")
  tracker.initialize()
  const { transport } = transportFor(fixture, tracker)
  const initialHistory = transport.history
  transport.history = (scope, id, signal, cursor) => initialHistory(scope, id, signal, cursor, 2)
  const pageHistory = transport.history
  const state = new TrajectoryPanelState(() => {})
  try {
    state.connect(
      "nonadvancing-recapture",
      "project",
      fixture.directory,
      { kind: "session", sessionID: "ses-failed" },
      transport,
      { taskID, selection: null },
    )
    await waitFor(state, () => state.data.report !== undefined && !state.data.loading)
    await state.loadMoreActivity()
    expect(state.data.events).toHaveLength(4)
    state.selectEvent(state.data.events[0]!.id)

    const oldReport = state.data.report
    const oldEvents = structuredClone(state.data.events)
    const oldCursor = state.data.eventCursor
    const oldCapturedAt = state.data.historyCapturedAt
    const oldExpiresAt = state.data.historyExpiresAt
    const oldSelection = state.data.selection
    const oldPayload = structuredClone(state.data.selectionEventSnapshot)
    const calls: Array<string | undefined> = []
    transport.history = async (scope, id, signal, cursor, limit) => {
      calls.push(cursor)
      const response = await pageHistory(scope, id, signal, cursor, limit)
      if (!cursor) return response
      const report = response.report as { trajectory: Record<string, unknown> }
      return {
        ...response,
        report: {
          ...response.report,
          trajectory: {
            ...report.trajectory,
            events: [],
            nextCursor: cursor,
            hasMore: true,
          },
        },
      }
    }

    await state.recaptureActivity()
    expect(calls).toHaveLength(2)
    expect(calls[0]).toBeUndefined()
    expect(calls[1]).toBeTypeOf("string")
    expect(state.data.historyError).toContain("cursor did not advance")
    expect(state.data.recapturingHistory).toBe(false)
    expect(state.data.report).toBe(oldReport)
    expect(state.data.events).toEqual(oldEvents)
    expect(state.data.eventCursor).toBe(oldCursor)
    expect(state.data.historyCapturedAt).toBe(oldCapturedAt)
    expect(state.data.historyExpiresAt).toBe(oldExpiresAt)
    expect(state.data.selection).toEqual(oldSelection)
    expect(state.data.selectionEventSnapshot).toEqual(oldPayload)
  } finally {
    state.close()
    fixture.close()
  }
})

test("replayed or reordered history pages retain the old union and cursor for explicit recovery", async () => {
  const fixture = makeFixture()
  const tracker = new ObservationChangeTracker(fixture.repository, cursorSecret, "project")
  tracker.initialize()
  const { transport } = transportFor(fixture, tracker)
  const pageHistory = transport.history
  transport.history = (scope, id, signal, cursor) => pageHistory(scope, id, signal, cursor, 2)
  const originalHistory = transport.history
  let firstPage: TrajectoryHistoryResponse | undefined
  transport.history = async (scope, id, signal, cursor, limit) => {
    const response = await originalHistory(scope, id, signal, cursor, limit)
    if (!cursor) {
      firstPage = response
      return response
    }
    const responseReport = response.report as { trajectory: Record<string, unknown> }
    const firstReport = firstPage!.report as { trajectory: { events: unknown[] } }
    return {
      ...response,
      report: {
        ...responseReport,
        trajectory: {
          ...responseReport.trajectory,
          events: firstReport.trajectory.events,
          nextCursor: cursor,
        },
      },
    }
  }
  const state = new TrajectoryPanelState(() => {})
  try {
    state.connect(
      "replayed-page",
      "project",
      fixture.directory,
      { kind: "project", sessionID: "ses-owner" },
      transport,
      { taskID, selection: null },
    )
    await waitFor(state, () => state.data.report !== undefined && !state.data.loading)
    const originalEvents = structuredClone(state.data.events)
    const originalCursor = state.data.eventCursor
    expect(firstPage).toBeDefined()
    await state.loadMoreActivity()
    expect(state.data.events).toEqual(originalEvents)
    expect(state.data.eventCursor).toBe(originalCursor)
    expect(state.data.historyError).toContain("page order changed or cursor did not advance")
    expect(state.data.stale).toBe(true)
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

test("live status and progress do not cancel page-size-two history or rewrite its event selection", async () => {
  const fixture = makeFixture()
  const tracker = new ObservationChangeTracker(fixture.repository, cursorSecret, "project")
  tracker.initialize()
  const { transport } = transportFor(fixture, tracker)
  const historyPage = transport.history
  transport.history = (scope, id, signal, cursor) => historyPage(scope, id, signal, cursor, 2)
  const enteringPage = deferred<void>()
  const releasePage = deferred<void>()
  let holdFirstContinuation = true
  const stableHistoryPage = transport.history
  transport.history = async (scope, id, signal, cursor, limit) => {
    const result = stableHistoryPage(scope, id, signal, cursor, limit)
    if (cursor && holdFirstContinuation) {
      holdFirstContinuation = false
      enteringPage.resolve()
      const page = await result
      await releasePage.promise
      return page
    }
    return result
  }
  const state = new TrajectoryPanelState(() => {})
  const scope = { kind: "project" as const, sessionID: "ses-owner" }
  try {
    state.connect("stable-pages", "project", fixture.directory, scope, transport, {
      taskID,
      selection: null,
    })
    await waitFor(state, () => state.data.report !== undefined && !state.data.loading)
    expect(state.data.events).toHaveLength(2)
    expect(state.data.report?.trajectory.limit).toBe(2)
    const event = state.data.events[0]!
    const capturedPage = structuredClone(state.data.events)
    state.selectEvent(event.id)
    const capturedPayload = structuredClone(state.data.selectionEventSnapshot)
    const expectedIDs = state.data.capturedEventIDs

    const pageOne = state.loadMoreActivity()
    await enteringPage.promise
    const recorder = new ProgressRecorder(fixture.store, "project")
    const recordTool = (
      type: "session.tool.called" | "session.tool.success",
      eventID: string,
      at: number,
    ) =>
      recorder.recordNativeEvent({
        id: eventID,
        type,
        created: at,
        data: {
          sessionID: "ses-failed",
          assistantMessageID: "msg-live",
          id: "same-tool-call",
          executed: true,
          ...(type === "session.tool.success"
            ? { content: [{ type: "text", text: "tool completed" }] }
            : {}),
        },
      })
    const sequence = recordTool("session.tool.called", "tool-running", 3000)
    await state.refresh()
    await waitFor(state, () =>
      state.data.liveEvents.some((fact) => fact.id === `progress:${sequence}`),
    )
    const running = state.data.liveEvents.find((fact) => fact.id === `progress:${sequence}`)
    expect(running?.status).toBe("running")
    expect(state.data.events).toEqual(capturedPage)
    expect(state.data.selection).toEqual({ kind: "event", id: event.id })
    expect(state.data.selectionEventSnapshot).toEqual(capturedPayload)
    expect(selectedEventFor(state.data)).toEqual(event)
    const progressID = `progress:${sequence}`
    expect(state.data.capturedEventIDs).not.toContain(progressID)
    state.selectEvent(progressID)
    const runningSnapshot = structuredClone(state.data.selectionEventSnapshot)
    expect(selectedEventFor(state.data)).toMatchObject({ id: progressID, status: "running" })
    releasePage.resolve()
    await pageOne
    expect(state.data.events.map((item) => item.id)).toEqual(expectedIDs.slice(0, 4))

    recordTool("session.tool.success", "tool-completed", 3010)
    await state.refresh()
    await waitFor(
      state,
      () =>
        state.data.liveEvents.find((fact) => fact.id === `progress:${sequence}`)?.status ===
        "succeeded",
    )
    const completed = state.data.liveEvents.find((fact) => fact.id === `progress:${sequence}`)
    expect(completed).toMatchObject({ status: "succeeded", result: "tool completed" })
    const selectedCompleted = selectedEventFor(state.data)
    expect(selectedCompleted).toMatchObject({ id: progressID, status: "succeeded" })
    expect(eventPayload(selectedCompleted!)).toMatchObject({
      status: "succeeded",
      result: "tool completed",
    })
    expect(eventTitle(selectedCompleted!)).toBe("Worker tool · succeeded")
    expect(state.data.selectionEventSnapshot).toEqual(runningSnapshot)
    state.selectEvent(progressID)
    expect(state.data.selectionEventSnapshot).toMatchObject({
      id: progressID,
      status: "succeeded",
      result: "tool completed",
    })
    expect(selectedEventFor(state.data)).toMatchObject({ id: progressID, status: "succeeded" })
    expect(selectedEventFor({ ...state.data, liveEvents: [] })).toEqual(
      state.data.selectionEventSnapshot,
    )
    expect(state.data.events.map((item) => item.id)).toEqual(expectedIDs.slice(0, 4))
    await state.loadMoreActivity()
    await state.refresh()
    await state.loadMoreActivity()
    expect(state.data.events.map((item) => item.id)).toEqual(expectedIDs.slice(0, 8))
    expect(new Set(state.data.events.map((item) => item.id)).size).toBe(8)
    expect(state.data.eventCursor).not.toBeNull()

    state.selectEvent(event.id)
    await state.recaptureActivity()
    expect(state.data.selection).toEqual({ kind: "event", id: event.id })
    expect(state.data.selectionEventSnapshot?.id).toBe(event.id)
    expect(state.data.events.map((item) => item.id)).toEqual(expectedIDs.slice(0, 8))
  } finally {
    state.close()
    fixture.close()
  }
})

function recoveryClock() {
  const jobs: { run: () => void; delay: number; cancelled: boolean }[] = []
  return {
    jobs,
    schedule: (run: () => void, delay: number) => {
      const job = { run, delay, cancelled: false }
      jobs.push(job)
      return () => {
        job.cancelled = true
      }
    },
  }
}

test("healthy trajectory stays quiet past the old poll interval and reconnect preserves captured history", async () => {
  const fixture = makeFixture()
  const tracker = new ObservationChangeTracker(fixture.repository, cursorSecret, "project")
  tracker.initialize()
  const { transport, snapshotCount, publish } = transportFor(fixture, tracker)
  const originalHistory = transport.history
  let historyCalls = 0
  transport.history = (...args) => {
    historyCalls++
    return originalHistory(...args)
  }
  const clock = recoveryClock()
  const state = new TrajectoryPanelState(
    () => {},
    () => {},
    clock.schedule,
  )
  try {
    state.connect(
      "quiet",
      "project",
      fixture.directory,
      { kind: "project", sessionID: "ses-owner" },
      transport,
      { taskID, selection: null },
    )
    await waitFor(state, () => Boolean(state.data.report) && !state.data.loading)
    state.selectAttempt(firstAttemptID)
    const captured = state.data.historyCapturedAt
    const events = [...state.data.capturedEventIDs]
    const reads = snapshotCount()
    await new Promise<void>((resolve) => setTimeout(resolve, 4_100))
    expect(snapshotCount()).toBe(reads)
    expect(clock.jobs).toHaveLength(0)
    publish({
      projectID: "project",
      sequence: 1,
      repositoryVersion: 0,
      sourceRevision: 0,
      nativeRevision: 0,
      cause: "gap",
      resnapshotRequired: true,
    })
    await waitFor(state, () => snapshotCount() === reads + 1)
    await tick()
    expect(state.data.selection).toEqual({ kind: "attempt", id: firstAttemptID })
    expect(state.data.historyCapturedAt).toBe(captured)
    expect(state.data.capturedEventIDs).toEqual(events)
    expect(historyCalls).toBe(1)
  } finally {
    state.close()
    fixture.close()
  }
})

test("failed snapshot reads back off, recover without a new event, reset and cancel on close", async () => {
  const fixture = makeFixture()
  const tracker = new ObservationChangeTracker(fixture.repository, cursorSecret, "project")
  tracker.initialize()
  const { transport } = transportFor(fixture, tracker)
  const original = transport.snapshot
  let failures = 2
  transport.snapshot = (...args) => {
    if (failures-- > 0) return Promise.reject(new Error("temporary read failure"))
    return original(...args)
  }
  const clock = recoveryClock()
  const state = new TrajectoryPanelState(
    () => {},
    () => {},
    clock.schedule,
  )
  try {
    state.connect(
      "recovery",
      "project",
      fixture.directory,
      { kind: "project", sessionID: "ses-owner" },
      transport,
      { taskID, selection: null },
    )
    await waitFor(state, () => clock.jobs.length === 1)
    expect(clock.jobs[0]!.delay).toBe(1_000)
    clock.jobs[0]!.run()
    await waitFor(state, () => clock.jobs.length === 2)
    expect(clock.jobs[1]!.delay).toBe(2_000)
    clock.jobs[1]!.run()
    await waitFor(state, () => Boolean(state.data.report) && !state.data.loading)
    expect(state.data.error).toBe("")
    expect(state.data.stale).toBe(false)
    expect(clock.jobs).toHaveLength(2)
    failures = 1
    await state.refresh()
    expect(clock.jobs[2]!.delay).toBe(1_000)
    state.close()
    expect(clock.jobs[2]!.cancelled).toBe(true)
    const before = clock.jobs.length
    clock.jobs[2]!.run()
    await tick()
    expect(clock.jobs).toHaveLength(before)
  } finally {
    state.close()
    fixture.close()
  }
})

test("a failed live status read recovers without recapturing selected historical activity", async () => {
  const fixture = makeFixture()
  const tracker = new ObservationChangeTracker(fixture.repository, cursorSecret, "project")
  tracker.initialize()
  const { transport } = transportFor(fixture, tracker)
  const clock = recoveryClock()
  const state = new TrajectoryPanelState(
    () => {},
    () => {},
    clock.schedule,
  )
  try {
    state.connect(
      "status",
      "project",
      fixture.directory,
      { kind: "project", sessionID: "ses-owner" },
      transport,
      { taskID, selection: null },
    )
    await waitFor(state, () => Boolean(state.data.report) && !state.data.loading)
    state.selectAttempt(firstAttemptID)
    const captured = state.data.historyCapturedAt
    const events = [...state.data.capturedEventIDs]
    const original = transport.status
    let fail = true
    transport.status = (...args) => {
      if (fail) {
        fail = false
        return Promise.reject(new Error("temporary status failure"))
      }
      return original(...args)
    }
    await state.refresh()
    expect(state.data.stale).toBe(true)
    expect(clock.jobs).toHaveLength(1)
    clock.jobs[0]!.run()
    await waitFor(state, () => !state.data.error && !state.data.stale)
    expect(state.data.historyCapturedAt).toBe(captured)
    expect(state.data.capturedEventIDs).toEqual(events)
    expect(state.data.selection).toEqual({ kind: "attempt", id: firstAttemptID })
    expect(clock.jobs).toHaveLength(1)
  } finally {
    state.close()
    fixture.close()
  }
})

test("reconnect arriving during a snapshot forces one catch-up even at the same sequence", async () => {
  const fixture = makeFixture()
  const tracker = new ObservationChangeTracker(fixture.repository, cursorSecret, "project")
  tracker.initialize()
  const { transport, publish } = transportFor(fixture, tracker)
  const original = transport.snapshot
  const waiting = deferred<void>()
  let calls = 0
  transport.snapshot = async (...args) => {
    const result = await original(...args)
    if (++calls === 1) await waiting.promise
    return result
  }
  const state = new TrajectoryPanelState(() => {})
  try {
    state.connect(
      "inflight",
      "project",
      fixture.directory,
      { kind: "project", sessionID: "ses-owner" },
      transport,
      { taskID, selection: null },
    )
    await waitFor(state, () => calls === 1)
    publish({
      projectID: "project",
      sequence: 1,
      repositoryVersion: 0,
      sourceRevision: 0,
      nativeRevision: 0,
      cause: "gap",
      resnapshotRequired: true,
    })
    await tick()
    waiting.resolve()
    await waitFor(state, () => calls === 2 && Boolean(state.data.report) && !state.data.loading)
    await tick()
    expect(calls).toBe(2)
  } finally {
    state.close()
    fixture.close()
  }
})

for (const newerThanSnapshot of [false, true]) {
  test(`an in-flight event ${newerThanSnapshot ? "newer than" : "covered by"} the snapshot ${newerThanSnapshot ? "gets" : "avoids"} a catch-up read`, async () => {
    const fixture = makeFixture()
    const tracker = new ObservationChangeTracker(fixture.repository, cursorSecret, "project")
    tracker.initialize()
    const { transport, publish } = transportFor(fixture, tracker)
    const original = transport.snapshot
    const waiting = deferred<void>()
    let calls = 0
    transport.snapshot = async (...args) => {
      const result = await original(...args)
      if (++calls === 1) await waiting.promise
      return { ...result, boundary: { ...result.boundary, eventSequence: calls === 1 ? 10 : 11 } }
    }
    const state = new TrajectoryPanelState(() => {})
    try {
      state.connect(
        "sequence",
        "project",
        fixture.directory,
        { kind: "project", sessionID: "ses-owner" },
        transport,
        { taskID, selection: null },
      )
      await waitFor(state, () => calls === 1)
      publish({
        projectID: "project",
        sequence: newerThanSnapshot ? 11 : 10,
        repositoryVersion: 0,
        sourceRevision: 0,
        nativeRevision: 0,
        cause: "native",
        resnapshotRequired: false,
      })
      await tick()
      waiting.resolve()
      await waitFor(state, () => Boolean(state.data.report) && !state.data.loading)
      await tick()
      expect(calls).toBe(newerThanSnapshot ? 2 : 1)
    } finally {
      state.close()
      fixture.close()
    }
  })
}

test("a retired retry callback cannot disown the current view's recovery timer", async () => {
  const fixture = makeFixture()
  const tracker = new ObservationChangeTracker(fixture.repository, cursorSecret, "project")
  tracker.initialize()
  const { transport } = transportFor(fixture, tracker)
  transport.snapshot = () => Promise.reject(new Error("temporary read failure"))
  const clock = recoveryClock()
  const state = new TrajectoryPanelState(
    () => {},
    () => {},
    clock.schedule,
  )
  const connect = (key: string) =>
    state.connect(
      key,
      "project",
      fixture.directory,
      { kind: "project", sessionID: "ses-owner" },
      transport,
      { taskID, selection: null },
    )
  try {
    connect("old")
    await waitFor(state, () => clock.jobs.length === 1)
    connect("new")
    await waitFor(state, () => clock.jobs.length === 2)
    expect(clock.jobs[0]!.cancelled).toBe(true)
    clock.jobs[0]!.run()
    state.close()
    expect(clock.jobs[1]!.cancelled).toBe(true)
  } finally {
    state.close()
    fixture.close()
  }
})

test("a reset stream sequence during reconnect catches up without replacing captured history", async () => {
  const fixture = makeFixture()
  const tracker = new ObservationChangeTracker(fixture.repository, cursorSecret, "project")
  tracker.initialize()
  const { transport, publish } = transportFor(fixture, tracker)
  const original = transport.snapshot
  const waiting = deferred<void>()
  let calls = 0
  transport.snapshot = async (...args) => {
    const result = await original(...args)
    const call = ++calls
    if (call === 2) await waiting.promise
    return {
      ...result,
      boundary: { ...result.boundary, eventSequence: call === 1 ? 100 : call === 2 ? 1 : 2 },
    }
  }
  const state = new TrajectoryPanelState(() => {})
  try {
    state.connect(
      "reset",
      "project",
      fixture.directory,
      { kind: "project", sessionID: "ses-owner" },
      transport,
      { taskID, selection: null },
    )
    await waitFor(state, () => Boolean(state.data.report) && !state.data.loading)
    state.selectAttempt(firstAttemptID)
    const captured = state.data.historyCapturedAt
    const ids = [...state.data.capturedEventIDs]
    publish({
      projectID: "project",
      sequence: 1,
      repositoryVersion: 0,
      sourceRevision: 0,
      nativeRevision: 0,
      cause: "gap",
      resnapshotRequired: true,
    })
    await waitFor(state, () => calls === 2)
    publish({
      projectID: "project",
      sequence: 2,
      repositoryVersion: 0,
      sourceRevision: 0,
      nativeRevision: 0,
      cause: "native",
      resnapshotRequired: false,
    })
    await tick()
    waiting.resolve()
    await waitFor(state, () => calls === 3 && state.data.snapshot?.boundary.eventSequence === 2)
    expect(state.data.historyCapturedAt).toBe(captured)
    expect(state.data.capturedEventIDs).toEqual(ids)
    expect(state.data.selection).toEqual({ kind: "attempt", id: firstAttemptID })
  } finally {
    state.close()
    fixture.close()
  }
})
