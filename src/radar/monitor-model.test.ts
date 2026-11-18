import { expect, test } from "bun:test"
import type { LiveRadarResponse } from "../observability/contract.ts"
import type { RadarMonitorData } from "./monitor-state.ts"
import {
  connectionStatus,
  coverageGaps,
  formatAge,
  formatDuration,
  lineView,
  monitorSegments,
  idleSentence,
  nothingRunning,
  connectionChip,
  clockTime,
  callStatusWord,
  recentFlow,
  sessionActivity,
  sessionGroups,
  sessionModel,
  sessionRole,
  sessionState,
  sessionTask,
} from "./monitor-model.ts"
import type { LiveCall, LiveFlow, LiveSession } from "./monitor-model.ts"

const TASK = "5f0c2a1e-7b3d-4c8e-9a1f-0d2b3c4e5f60"
const ATTEMPT = "6a1d3b2f-8c4e-4d9f-8b2a-1e3c4d5f6a70"

function session(change: Partial<LiveSession> = {}): LiveSession {
  return {
    id: "session:ses-worker",
    sessionID: "ses-worker",
    projectID: "project",
    classification: "managed",
    isViewSession: false,
    isCurrentArchitect: null,
    availability: "available",
    freshness: "current",
    agent: "lazers-implementor",
    state: "busy",
    assignment: {
      planID: TASK,
      taskID: TASK,
      attemptID: ATTEMPT,
      state: "running",
      startedAt: 1_000,
    },
    selectedRouteID: null,
    configuredRouteID: "route:configured",
    observedRouteID: "route:observed",
    routeCoverage: { selected: "unavailable", configured: "available", observed: "available" },
    updatedAt: 5_000,
    observedAt: 9_000,
    ...change,
  }
}

function call(change: Partial<LiveCall>): LiveCall {
  return {
    id: "call:1",
    sessionID: "ses-worker",
    attemptID: ATTEMPT,
    messageID: "msg_1",
    callID: "call-1",
    tool: "read",
    status: "succeeded",
    execution: "executed",
    inputAt: 2_000,
    calledAt: 2_100,
    completedAt: 3_100,
    observedAt: 3_100,
    sourceProgressSequence: 1,
    sourceEventID: null,
    sourceEventType: null,
    result: null,
    error: null,
    payloadAvailable: false,
    ...change,
  }
}

function flow(change: Partial<LiveFlow>): LiveFlow {
  return {
    id: "flow:1",
    kind: "model-request",
    source: "native-event",
    from: null,
    to: null,
    sessionID: "ses-worker",
    messageID: "msg_1",
    callID: null,
    tool: null,
    agent: null,
    routeID: "route:observed",
    toolID: null,
    status: "request-started",
    startedAt: 4_000,
    observedAt: 4_000,
    sourceProgressSequence: null,
    sourceNativeRevision: 1,
    sourceEventID: "evt-1",
    sourceEventType: "session.step.started",
    ...change,
  }
}

function live(change: Partial<LiveRadarResponse> = {}): LiveRadarResponse {
  const route = (id: string, modelID: string, source: "attempt-policy" | "step-event") => ({
    id,
    providerID: "openai",
    modelID,
    variant: "high",
    source,
    sessionID: "ses-worker",
    attemptID: null,
    messageID: null,
    eventID: null,
    observedAt: null,
  })
  return {
    schemaVersion: 1,
    projectID: "project",
    scope: { kind: "project" },
    streamEpoch: "7b2e4c1d-9a3f-4e8b-a1c2-3d4e5f6a7b80",
    observedAt: 9_000,
    boundary: { runnerRevision: 1, nativeRevision: 1, eventSequence: 4 },
    freshness: { runner: "current", nativeInventory: "complete", nativeEvents: "connected" },
    scheduler: { status: "scheduled", participants: 1 },
    coverage: {
      sessionCount: 1,
      managedSessionCount: 1,
      includeUnmanagedSessions: false,
      inventoryTruncated: false,
      assignmentTruncated: false,
      progressTruncated: false,
      payloadTruncated: false,
      routeTruncated: false,
      callsTruncated: false,
      flowTruncated: false,
      journalTruncated: false,
      journal: "available",
      foreignSessionsExcluded: 0,
      sourceQueries: 1,
      sourceRowsRead: 1,
      sourceBytesRead: 1,
      sourcePayloadBytesRead: 0,
      nativeInventoryReads: 1,
      nativeSessionReads: 1,
      nativeMetadataBytesInspected: 0,
      nativeMetadataTruncated: false,
      nativeMetadataBoundary: "raw-selected-fields-after-adapter",
      nativeContextLoads: 0,
      retainedStateEntries: 0,
      retainedStateTruncated: false,
      responseBytes: 1,
    },
    limits: {} as LiveRadarResponse["limits"],
    sessions: [session()],
    routes: [
      route("route:observed", "gpt-6-luna", "step-event"),
      route("route:configured", "gpt-6-sol", "attempt-policy"),
    ],
    calls: [],
    flow: [],
    ...change,
  }
}

test("session identity uses role, short task, assignment state and the observed model", () => {
  const value = session()
  expect(sessionRole(value)).toEqual({ label: "Implementor", icon: "code-slash" })
  expect(sessionRole(session({ agent: null, isCurrentArchitect: true }))).toEqual({
    label: "Architect",
    icon: "brain",
  })
  expect(sessionTask(value)).toBe("Task 5f0c2a1e…")
  expect(sessionState(value)).toBe("Running")
  expect(sessionState(session({ assignment: null, state: "idle", freshness: "stale" }))).toBe(
    "Idle · stale",
  )
  expect(sessionState(session({ availability: "archived" }))).toBe("Archived")
  expect(sessionModel(live(), value)).toMatchObject({
    label: "gpt-6-luna · high",
    basis: "observed",
  })
  expect(sessionModel(live(), session({ observedRouteID: null }))).toMatchObject({
    label: "gpt-6-sol · high",
    basis: "configured",
  })
  expect(
    sessionModel(live(), session({ observedRouteID: null, configuredRouteID: null })),
  ).toBeUndefined()
})

test("concurrent calls stay distinct with the latest finished call and observed targets only", () => {
  const response = live({
    calls: [
      call({
        id: "call:read",
        callID: "call-read",
        fileTargets: { coverage: "observed", operation: "read", paths: ["src/a.ts", "src/b.ts"] },
      }),
      call({
        id: "call:old",
        callID: "call-old",
        inputAt: 500,
        completedAt: 900,
        observedAt: 900,
      }),
      call({
        id: "call:patch",
        callID: "call-patch",
        tool: "patch",
        status: "running",
        inputAt: 3_000,
        completedAt: null,
        observedAt: 3_200,
        fileTargets: { coverage: "partial", operation: "patch", paths: ["src/c.ts"] },
      }),
      call({
        id: "call:bash",
        callID: "call-bash",
        tool: "bash",
        status: "input-started",
        inputAt: 3_500,
        completedAt: null,
        observedAt: 3_500,
      }),
    ],
  })
  const activity = sessionActivity(response, response.sessions[0]!)
  expect(activity.lines.map((line) => line.id)).toEqual(["call:read", "call:patch", "call:bash"])
  const [read, patch, bash] = activity.lines.map(lineView)
  expect(read).toMatchObject({
    label: "read completed",
    current: false,
    target: "src/a.ts",
    extraTargets: 1,
  })
  expect(patch).toMatchObject({
    label: "patch running",
    current: true,
    target: null,
    targetNote: "File targets partly recorded",
  })
  expect(bash).toMatchObject({ label: "bash starting", current: true, icon: "console" })
  expect(activity.lastActivityAt).toBe(5_000)
})

test("failures stay visible and busy sessions without a current call say so", () => {
  const failed = live({
    calls: [
      call({
        status: "failed",
        tool: "patch",
        error: "Patch failed after the request; change is unknown.",
      }),
    ],
  })
  const lines = sessionActivity(failed, failed.sessions[0]!).lines
  expect(lines.map((line) => lineView(line).label)).toEqual([
    "patch failed",
    "Busy · no call in progress",
  ])
  expect(lineView(lines[0]!)).toMatchObject({
    icon: "warning",
    error: "Patch failed after the request; change is unknown.",
  })
  expect(lineView(lines[1]!).selectable).toBe(false)

  const idle = live({ sessions: [session({ state: "idle" })], calls: [call({})] })
  expect(sessionActivity(idle, idle.sessions[0]!).lines.map((line) => line.kind)).toEqual(["call"])
})

test("model phases and native-only tool phases describe sessions without runner calls", () => {
  const architect = session({
    sessionID: "ses-architect",
    classification: "unmanaged",
    agent: "architect",
    assignment: null,
  })
  const response = live({
    sessions: [architect],
    flow: [
      flow({ id: "flow:step", sessionID: "ses-architect", observedAt: 6_000, startedAt: 6_000 }),
      flow({
        id: "flow:tool-start",
        kind: "tool-phase",
        sessionID: "ses-architect",
        callID: "call-a",
        tool: "Read",
        status: "input-started",
        startedAt: 5_000,
        observedAt: 5_000,
      }),
      flow({
        id: "flow:tool-done",
        kind: "tool-phase",
        sessionID: "ses-architect",
        callID: "call-a",
        tool: "Read",
        status: "succeeded",
        startedAt: null,
        observedAt: 5_500,
      }),
    ],
  })
  const lines = sessionActivity(response, architect).lines
  expect(lines.map((line) => [line.id, lineView(line).label])).toEqual([
    ["flow-call:call-a", "Read completed"],
    ["flow:step", "Model request"],
  ])
  expect(lines[0]).toMatchObject({ startedAt: 5_000, endedAt: 5_500, target: null })
  expect(recentFlow(response, 2).map((item) => item.id)).toEqual(["flow:step", "flow:tool-done"])
})

test("summary segments, coverage gaps and the three connection words", () => {
  const response = live({
    sessions: [
      session(),
      session({ sessionID: "ses-idle", state: "idle", assignment: null }),
      session({ sessionID: "ses-gone", state: "unknown", availability: "missing" }),
    ],
  })
  expect(monitorSegments(response)).toEqual([{ count: 1, word: "running" }])
  expect(
    monitorSegments(
      live({ ...response, coverage: { ...response.coverage, journalTruncated: true } }),
    ),
  ).toEqual([
    { count: 1, word: "running" },
    { count: 1, word: "data gap" },
  ])
  expect(
    monitorSegments(
      live({
        sessions: [
          session({ assignment: { ...session().assignment!, state: "verifying" } }),
          session({ sessionID: "ses-two" }),
        ],
      }),
    ),
  ).toEqual([
    { count: 1, word: "running" },
    { count: 1, word: "verifying" },
  ])
  expect(coverageGaps(response)).toEqual([])
  expect(coverageGaps(live({ coverage: { ...response.coverage, callsTruncated: true } }))).toEqual([
    "calls",
  ])

  const data = (change: Partial<RadarMonitorData>): RadarMonitorData => ({
    key: "k",
    live: response,
    loading: false,
    stale: false,
    resynchronizing: false,
    error: "",
    connection: "connected",
    selectedSessionID: null,
    historyLoading: false,
    historyError: "",
    ...change,
  })
  const words = [
    connectionStatus(data({})),
    connectionStatus(data({ stale: true, resynchronizing: true })),
    connectionStatus(data({ connection: "reconnecting" })),
    connectionStatus(data({ connection: "disconnected" })),
    connectionStatus(data({ live: undefined, loading: true, connection: "connecting" })),
    connectionStatus(data({ readError: "Timed out" })),
    connectionStatus(data({ live: undefined, readError: "Timed out" })),
  ].map((chip) => chip.word)
  expect(words).toEqual([
    "Live",
    "Live",
    "Reconnecting",
    "Offline",
    "Reconnecting",
    "Reconnecting",
    "Offline",
  ])
  expect(connectionStatus(data({})).state).toBe("live")
  expect(connectionStatus(data({ connection: "disconnected" })).detail).toContain("Last update")
  expect(connectionChip("live").detail).not.toContain("Last update")
})

test("idle state names what is true and omits what is not", () => {
  const idle = live({
    sessions: [
      session({ sessionID: "ses-arch", isCurrentArchitect: true, state: "idle", assignment: null }),
    ],
  })
  expect(nothingRunning(idle)).toBe(true)
  expect(idleSentence(idle)).toBe("Architect is idle and no workers are active.")
  expect(nothingRunning(live({ sessions: [session()] }))).toBe(false)
  expect(idleSentence(live({ sessions: [] }))).toBe("No sessions are running.")
})

test("missing facts are omitted, never rendered as unknown", () => {
  const bare = session({
    state: "unknown",
    assignment: null,
    observedRouteID: null,
    configuredRouteID: null,
    selectedRouteID: null,
  })
  expect(sessionState(bare)).toBeUndefined()
  expect(sessionModel(live(), bare)).toBeUndefined()
  expect(clockTime(null)).toBe("")
  expect(callStatusWord("unknown")).toBe("")
  expect(sessionModel(live(), session({ observedRouteID: null }))?.detail).not.toContain(
    "not yet observed",
  )
  const toolless = live({ calls: [call({ tool: null })], sessions: [session()] })
  const lines = sessionActivity(toolless, session()).lines
  expect(JSON.stringify(lines.map((line) => lineView(line)))).not.toMatch(/nknown|navailable/)
})

test("durations and ages are compact and labelled", () => {
  expect(formatDuration(1_149)).toBe("1.1s")
  expect(formatDuration(40_000)).toBe("40s")
  expect(formatDuration(252_000)).toBe("4m 12s")
  expect(formatDuration(3_780_000)).toBe("1h 3m")
  expect(formatAge(2_000)).toBe("now")
  expect(formatAge(8_000)).toBe("8s ago")
  expect(formatAge(180_000)).toBe("3m ago")
  expect(formatAge(7_200_000)).toBe("2h ago")
})

test("active and assigned sessions lead; unavailable historical sessions are grouped apart", () => {
  const response = live({
    sessions: [
      session({ sessionID: "ses-gone-1", state: "unknown", availability: "missing" }),
      session({ sessionID: "ses-idle", state: "idle", assignment: null }),
      session({ sessionID: "ses-unknown", state: "unknown", assignment: null }),
      session({ sessionID: "ses-gone-2", state: "idle", availability: "archived" }),
      session({ sessionID: "ses-assigned", state: "idle" }),
      session({ sessionID: "ses-busy", state: "busy", assignment: null }),
    ],
  })
  const groups = sessionGroups(response)
  expect(groups.leading).toEqual(["ses-assigned", "ses-busy", "ses-idle", "ses-unknown"])
  expect(groups.unavailable).toEqual(["ses-gone-1", "ses-gone-2"])
  expect(groups.children.size).toBe(0)
  expect(monitorSegments(response)).toEqual([{ count: 2, word: "running" }])
})

test("workers nest under the current Architect, in rank order", () => {
  const response = live({
    sessions: [
      session({ sessionID: "ses-w1" }),
      session({ sessionID: "ses-arch", isCurrentArchitect: true, state: "idle", assignment: null }),
      session({ sessionID: "ses-other", state: "idle", assignment: null }),
      session({ sessionID: "ses-w2" }),
    ],
  })
  const groups = sessionGroups(response)
  expect(groups.leading).toEqual(["ses-arch", "ses-other"])
  expect(groups.children.get("ses-arch")).toEqual(["ses-w1", "ses-w2"])
})
