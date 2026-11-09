import { expect, test } from "bun:test"
import { ObservationChangeTracker } from "./changes.ts"
import type { LiveHistoryResponse, LiveRadarResponse } from "./contract.ts"
import { ProgressRecorder } from "../progress/recorder.ts"
import { makeFixture, firstAttemptID } from "../../test/trajectory/fixture.ts"
import { operationalReads } from "../../test/radar/operational.ts"
import { ObservationReads } from "./read.ts"
import type { RadarNativeSession, RadarSessionHost } from "./native.ts"
import { schedulerProjectKey, sharedScheduler } from "../runner/scheduler-coordinator.ts"

function nativeSession(
  id: string,
  projectID: string,
  directory: string,
  agent: string,
  archived = false,
): RadarNativeSession {
  return {
    id,
    projectID,
    parentID: null,
    directory,
    agent,
    model: { providerID: "openai", id: "gpt-6", variant: "high" },
    archived,
    busy: true,
    createdAt: 10,
    updatedAt: 20,
  }
}

test("S8-1 live reads remain available during sustained native events and runner writes", async () => {
  const fixture = makeFixture()
  const secret = new Uint8Array(32).fill(81)
  const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
  tracker.initialize()
  const host: RadarSessionHost = {
    get: async (id) => {
      await Bun.sleep(12)
      return nativeSession(id, "project", fixture.directory, "implementor")
    },
    project: async () => ({ sessions: [], truncated: false }),
    descendants: async () => ({ sessions: [], truncated: false }),
  }
  const reads = new ObservationReads(fixture.store, fixture.host, "project", secret, host)
  let events = 0
  let successes = 0
  let failures = 0
  let olderBoundaries = 0
  const started = performance.now()
  const timer = setInterval(() => {
    events++
    tracker.native({
      id: `event-${events}`,
      type: "session.tool.progress",
      durable: { aggregateID: "ses-failed", seq: events },
      data: { sessionID: "ses-failed", id: "active-tool", name: "edit" },
    })
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET tool_count=tool_count+1 WHERE id=?").run(firstAttemptID),
    )
  }, 4)
  try {
    while (performance.now() - started < 2_000) {
      let response: LiveRadarResponse
      try {
        response = await reads.liveRadar(
          { scope: { kind: "session", sessionID: "ses-failed" }, includeUnmanagedSessions: false },
          tracker,
          new AbortController().signal,
          tracker.streamEpoch,
        )
      } catch {
        failures++
        await Bun.sleep(2)
        continue
      }
      successes++
      expect(response.boundary.eventSequence).toBeLessThanOrEqual(tracker.sequence)
      if (response.boundary.eventSequence < tracker.sequence) olderBoundaries++
    }
    const durationMs = performance.now() - started
    expect(events / (durationMs / 1_000)).toBeGreaterThanOrEqual(100)
    expect(successes / (successes + failures)).toBeGreaterThanOrEqual(0.95)
    expect(olderBoundaries).toBeGreaterThan(0)
    console.info("S8-1 traffic", { events, successes, failures, durationMs })
  } finally {
    clearInterval(timer)
    tracker.close()
    fixture.close()
  }
})

test("bounded live read and separately selected history carry only attributed file targets", async () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
    )
    const recorder = new ProgressRecorder(fixture.store, "project")
    expect(
      recorder.recordToolTargets({
        tool: "edit",
        sessionID: "ses-failed",
        agent: "lazers-implementor",
        messageID: "msg-edit-target",
        callID: "call-edit-target",
        input: {
          path: "src/monitor.tsx",
          oldText: "PRIVATE EDIT BODY",
          newText: "PRIVATE PROPOSED BODY",
          attachment: "PRIVATE ATTACHMENT",
        },
      }),
    ).toBeGreaterThan(0)
    recorder.recordNativeEvent({
      id: "evt-edit-input",
      type: "session.tool.input.started",
      created: 50_000,
      data: {
        sessionID: "ses-failed",
        assistantMessageID: "msg-edit-target",
        id: "call-edit-target",
        name: "edit",
      },
    })

    const reads = operationalReads(fixture)
    const tracker = new ObservationChangeTracker(
      fixture.repository,
      new Uint8Array(32).fill(17),
      "project",
    )
    tracker.initialize()
    const scope = { kind: "session" as const, sessionID: "ses-failed" }
    const live = (await reads.liveRadar(
      { scope, includeUnmanagedSessions: false },
      tracker,
      new AbortController().signal,
      crypto.randomUUID(),
    )) as LiveRadarResponse
    expect(live.coverage.nativeContextLoads).toBe(0)
    expect(live.calls.find((call) => call.callID === "call-edit-target")).toMatchObject({
      sessionID: "ses-failed",
      attemptID: firstAttemptID,
      messageID: "msg-edit-target",
      status: "input-started",
      fileTargets: {
        coverage: "observed",
        operation: "edit",
        paths: ["src/monitor.tsx"],
      },
    })
    expect(JSON.stringify(live)).not.toContain("PRIVATE EDIT BODY")
    expect(JSON.stringify(live)).not.toContain("PRIVATE PROPOSED BODY")
    expect(JSON.stringify(live)).not.toContain("PRIVATE ATTACHMENT")

    const history = reads.liveHistory(
      { scope, sessionID: "ses-failed", limit: 20 },
      new AbortController().signal,
    ) as LiveHistoryResponse
    expect(history.items.find((item) => item.callID === "call-edit-target")).toMatchObject({
      fileTargets: {
        coverage: "observed",
        operation: "edit",
        paths: ["src/monitor.tsx"],
      },
    })
    expect(JSON.stringify(history)).not.toContain("PRIVATE PROPOSED BODY")
  } finally {
    fixture.close()
  }
})

test("Project live read adds only its exact current session and reports exact-key scheduler state", async () => {
  const fixture = makeFixture()
  const root = fixture.directory
  const projectKey = schedulerProjectKey(fixture.repository.path, root, "project")
  const otherProjectKey = schedulerProjectKey(fixture.repository.path, root, "other-project")
  const registration = sharedScheduler.register(
    projectKey,
    { intervalMs: 2_000, run: () => {} },
    100_000,
  )
  const otherRegistration = sharedScheduler.register(
    otherProjectKey,
    { intervalMs: 2_000, run: () => {} },
    100_000,
  )
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
    )
    const inventory = [...fixture.sessions.values()].map((session) =>
      nativeSession(session.id, "project", root, "worker"),
    )
    const exact = new Map<string, RadarNativeSession>([
      ["ses-view-architect", nativeSession("ses-view-architect", "project", root, "architect")],
      ["ses-view-worker", nativeSession("ses-view-worker", "project", root, "worker")],
      ["ses-view-foreign", nativeSession("ses-view-foreign", "foreign-project", root, "architect")],
      ["ses-view-archived", nativeSession("ses-view-archived", "project", root, "architect", true)],
    ])
    const exactGets: string[] = []
    const inventoryCalls: Array<{ projectID: string; limit: number }> = []
    const host: RadarSessionHost = {
      get: async (sessionID) => {
        exactGets.push(sessionID)
        return exact.get(sessionID) ?? inventory.find((session) => session.id === sessionID) ?? null
      },
      project: async (projectID, includeArchived, limit) => {
        inventoryCalls.push({ projectID, limit })
        expect(includeArchived).toBe(false)
        return { sessions: inventory, truncated: false }
      },
      descendants: async () => ({ sessions: [], truncated: false }),
    }
    const reads = new ObservationReads(
      fixture.store,
      fixture.host,
      "project",
      new Uint8Array(32).fill(44),
      host,
    )
    const tracker = new ObservationChangeTracker(
      fixture.repository,
      new Uint8Array(32).fill(44),
      "project",
    )
    tracker.initialize()
    const read = (sessionID: string, includeUnmanagedSessions = false) =>
      reads.liveRadar(
        { scope: { kind: "project", sessionID }, includeUnmanagedSessions },
        tracker,
        new AbortController().signal,
        tracker.streamEpoch,
      )

    const architect = await read("ses-view-architect")
    expect(exactGets.filter((id) => id === "ses-view-architect")).toHaveLength(1)
    expect(inventoryCalls).toEqual([{ projectID: "project", limit: 257 }])
    expect(architect.sessions[0]).toMatchObject({
      sessionID: "ses-view-architect",
      classification: "unmanaged",
      isViewSession: true,
      isCurrentArchitect: true,
      agent: "architect",
      state: "busy",
    })
    expect(architect.scheduler).toEqual({ status: "scheduled", participants: 1 })
    expect(architect.scheduler).not.toHaveProperty("groups")
    expect(architect.scheduler).not.toHaveProperty("runs")
    expect(architect.coverage.nativeContextLoads).toBe(0)

    tracker.native({
      id: "evt-live-architect-step",
      type: "session.step.started",
      created: 12_001,
      durable: { aggregateID: "ses-view-architect", seq: 1, version: 2 },
      data: {
        sessionID: "ses-view-architect",
        assistantMessageID: "msg_live_architect",
        agent: "architect",
        model: { providerID: "openai", id: "gpt-6-luna", variant: "high" },
        text: "PRIVATE ARCHITECT MESSAGE DECOY",
      },
    })
    tracker.native({
      id: "evt-live-architect-text",
      type: "session.text.ended",
      created: 12_002,
      durable: { aggregateID: "ses-view-architect", seq: 2, version: 2 },
      data: {
        sessionID: "ses-view-architect",
        assistantMessageID: "msg_live_architect",
        text: "PRIVATE ARCHITECT OUTPUT DECOY",
      },
    })
    tracker.native({
      id: "evt-live-architect-tool",
      type: "session.tool.input.started",
      created: 12_003,
      durable: { aggregateID: "ses-view-architect", seq: 3, version: 2 },
      data: {
        sessionID: "ses-view-architect",
        assistantMessageID: "msg_live_architect",
        id: "call_live_architect",
        name: "Read",
        input: { path: "PRIVATE TOOL INPUT DECOY" },
      },
    })
    tracker.native({
      id: "evt-live-architect-tool-success",
      type: "session.tool.success",
      created: 12_004,
      durable: { aggregateID: "ses-view-architect", seq: 4, version: 2 },
      data: {
        sessionID: "ses-view-architect",
        assistantMessageID: "msg_live_architect",
        id: "call_live_architect",
        content: [{ type: "text", text: "PRIVATE TOOL RESULT DECOY" }],
      },
    })
    tracker.native({
      id: "evt-live-architect-execution",
      type: "session.execution.started",
      created: 12_005,
      durable: { aggregateID: "ses-view-architect", seq: 5, version: 2 },
      data: { sessionID: "ses-view-architect" },
    })
    tracker.native({
      id: "evt-live-architect-streamed",
      type: "session.step.streamed",
      created: 12_006,
      durable: { aggregateID: "ses-view-architect", seq: 6, version: 2 },
      data: {
        sessionID: "ses-view-architect",
        assistantMessageID: "msg_live_architect",
      },
    })
    const architectFlow = await read("ses-view-architect")
    expect(architectFlow.sessions[0]).toMatchObject({
      isViewSession: true,
      isCurrentArchitect: true,
      routeCoverage: { observed: "available" },
    })
    expect(architectFlow.routes).toContainEqual(
      expect.objectContaining({
        source: "step-event",
        sessionID: "ses-view-architect",
        attemptID: null,
        messageID: "msg_live_architect",
        providerID: "openai",
        modelID: "gpt-6-luna",
        variant: "high",
      }),
    )
    expect(architectFlow.flow).toMatchObject([
      {
        source: "native-event",
        kind: "model-request",
        sessionID: "ses-view-architect",
        messageID: "msg_live_architect",
        routeID: expect.any(String),
        sourceProgressSequence: null,
        sourceNativeRevision: expect.any(Number),
        sourceEventType: "session.step.started",
      },
      {
        source: "native-event",
        kind: "model-response",
        sourceEventType: "session.text.ended",
        messageID: "msg_live_architect",
      },
      {
        source: "native-event",
        kind: "tool-phase",
        callID: "call_live_architect",
        tool: "Read",
        status: "input-started",
      },
      {
        source: "native-event",
        kind: "tool-phase",
        callID: "call_live_architect",
        status: "succeeded",
      },
      {
        source: "native-event",
        kind: "execution",
        status: "execution-started",
        messageID: null,
        sourceEventType: "session.execution.started",
      },
      {
        source: "native-event",
        kind: "model-stream",
        status: "response-streamed",
        messageID: "msg_live_architect",
        sourceEventType: "session.step.streamed",
      },
    ])
    for (const decoy of [
      "PRIVATE ARCHITECT MESSAGE DECOY",
      "PRIVATE ARCHITECT OUTPUT DECOY",
      "PRIVATE TOOL INPUT DECOY",
      "PRIVATE TOOL RESULT DECOY",
    ])
      expect(JSON.stringify(architectFlow)).not.toContain(decoy)

    const broaderProject = await read("ses-view-architect", true)
    expect(
      broaderProject.sessions.filter((session) => session.sessionID === "ses-view-architect"),
    ).toHaveLength(1)
    expect(
      broaderProject.flow.filter((item) => item.sessionID === "ses-view-architect"),
    ).toHaveLength(6)

    const nonArchitect = await read("ses-view-worker")
    expect(
      nonArchitect.sessions.find((session) => session.sessionID === "ses-view-worker"),
    ).toMatchObject({
      isViewSession: true,
      isCurrentArchitect: false,
      agent: "worker",
    })

    const foreign = await read("ses-view-foreign")
    expect(foreign.sessions.some((session) => session.sessionID === "ses-view-foreign")).toBe(false)
    expect(foreign.coverage.foreignSessionsExcluded).toBeGreaterThan(0)

    const archived = await read("ses-view-archived")
    expect(archived.sessions.some((session) => session.sessionID === "ses-view-archived")).toBe(
      false,
    )
    expect(archived.sessions.some((session) => session.isCurrentArchitect === true)).toBe(false)

    const missing = await read("ses-view-missing")
    expect(
      missing.sessions.find((session) => session.sessionID === "ses-view-missing"),
    ).toMatchObject({
      isViewSession: true,
      isCurrentArchitect: null,
      availability: "missing",
      freshness: "unknown",
      state: "unknown",
    })
    expect(missing.freshness.nativeInventory).toBe("complete")
  } finally {
    await registration.dispose()
    await otherRegistration.dispose()
    fixture.close()
  }
})

test("late exact Project-view host result is fenced after cancellation", async () => {
  const fixture = makeFixture()
  let finish!: (value: RadarNativeSession | null) => void
  const pending = new Promise<RadarNativeSession | null>((resolve) => (finish = resolve))
  try {
    const workerInventory = [...fixture.sessions.values()].map((session) =>
      nativeSession(session.id, "project", fixture.directory, "worker"),
    )
    const host: RadarSessionHost = {
      get: async (sessionID) =>
        sessionID === "ses-late-architect"
          ? pending
          : (workerInventory.find((session) => session.id === sessionID) ?? null),
      project: async () => ({ sessions: workerInventory, truncated: false }),
      descendants: async () => ({ sessions: [], truncated: false }),
    }
    const reads = new ObservationReads(
      fixture.store,
      fixture.host,
      "project",
      new Uint8Array(32).fill(55),
      host,
    )
    const tracker = new ObservationChangeTracker(
      fixture.repository,
      new Uint8Array(32).fill(55),
      "project",
    )
    tracker.initialize()
    const controller = new AbortController()
    const result = reads.liveRadar(
      {
        scope: { kind: "project", sessionID: "ses-late-architect" },
        includeUnmanagedSessions: false,
      },
      tracker,
      controller.signal,
      tracker.streamEpoch,
    )
    controller.abort()
    finish(nativeSession("ses-late-architect", "project", fixture.directory, "architect"))
    await expect(result).rejects.toThrow()
  } finally {
    fixture.close()
  }
})

test("S8-6 a large project read cannot leave later session reads truncated or widen their retained scope", async () => {
  const fixture = makeFixture()
  const secret = new Uint8Array(32).fill(93)
  const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
  tracker.initialize()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let hold = false
  const host: RadarSessionHost = {
    get: async (id) => {
      if (hold && id === "ses-owner") {
        entered.resolve()
        await release.promise
      }
      return nativeSession(id, "project", fixture.directory, "implementor")
    },
    project: async () => ({ sessions: [], truncated: false }),
    descendants: async () => ({ sessions: [], truncated: false }),
  }
  const reads = new ObservationReads(fixture.store, fixture.host, "project", secret, host)
  try {
    fixture.store.atomic((db) => {
      for (let index = 0; index < 34; index++)
        db.query(
          `INSERT INTO runner_attempts
        (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at,tool_count,retry_count)
        SELECT ?,plan_id,task_id,?, ?,?,workspace,base_commit,policy,'running',started_at,tool_count,retry_count FROM runner_attempts WHERE id=?`,
        ).run(
          crypto.randomUUID(),
          index + 10,
          `ses-scope-${index}`,
          `msg-scope-${index}`,
          firstAttemptID,
        )
    })
    const read = (kind: "session" | "project", sessionID: string) =>
      reads.liveRadar(
        { scope: { kind, sessionID }, includeUnmanagedSessions: false },
        tracker,
        new AbortController().signal,
        tracker.streamEpoch,
      )
    const wide = await read("project", "ses-owner")
    expect(wide.coverage.retainedStateTruncated).toBe(true)
    for (const sessionID of ["ses-failed", "ses-accepted"]) {
      const narrow = await read("session", sessionID)
      expect(narrow.coverage.retainedStateTruncated).toBe(false)
      expect(narrow.coverage.retainedStateEntries).toBe(1)
      expect(tracker.hasScopedSession(sessionID)).toBe(true)
    }
    hold = true
    const pendingWide = read("project", "ses-owner")
    await entered.promise
    const simultaneousNarrow = await read("session", "ses-failed")
    release.resolve()
    const completedWide = await pendingWide
    expect(simultaneousNarrow.coverage.retainedStateTruncated).toBe(false)
    expect(simultaneousNarrow.coverage.retainedStateEntries).toBe(1)
    expect(completedWide.coverage.retainedStateTruncated).toBe(true)
  } finally {
    tracker.close()
    fixture.close()
  }
})
