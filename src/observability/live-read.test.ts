import { expect, test } from "bun:test"
import { ObservationChangeTracker } from "./changes.ts"
import type { LiveHistoryResponse, LiveRadarResponse } from "./contract.ts"
import { ProgressRecorder } from "../progress/recorder.ts"
import { makeFixture, firstAttemptID } from "../../test/trajectory/fixture.ts"
import { operationalReads } from "../../test/radar/operational.ts"
import { ObservationReads } from "./read.ts"
import type { RadarNativeSession, RadarSessionHost } from "./native.ts"
import { HandoffStore } from "../recovery/handoff/store.ts"
import { DETECTOR_ACTOR } from "../recovery/detector.ts"
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

test("live sessions carry parent, task labels, attempt number and recorded workload, omitting what is absent", async () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) => {
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID)
      db.query("UPDATE runner_plans SET state='running'").run()
      db.query("UPDATE runner_nodes SET state='queued'").run()
    })
    const failed = fixture.sessions.get("ses-failed")!
    failed.parentID = "ses-owner"
    const reads = operationalReads(fixture)
    const tracker = new ObservationChangeTracker(
      fixture.repository,
      new Uint8Array(32).fill(23),
      "project",
    )
    tracker.initialize()
    const read = async () =>
      (await reads.liveRadar(
        { scope: { kind: "session", sessionID: "ses-failed" }, includeUnmanagedSessions: false },
        tracker,
        new AbortController().signal,
        crypto.randomUUID(),
      )) as LiveRadarResponse
    const live = await read()
    const worker = live.sessions.find((item) => item.sessionID === "ses-failed")!
    expect(worker.parentSessionID).toBe("ses-owner")
    expect(worker.assignment).toMatchObject({
      attemptNumber: 1,
      taskTitle: "Inspect a worker attempt without disclosing private data",
    })
    expect(worker.assignment?.taskReference).toMatch(/\S/)
    // The task node's and plan's own state ride with the assignment, so a held worker is not
    // "running" in the list, the map or the counts.
    expect(worker.assignment?.task).toMatchObject({ state: "queued", planState: "running" })
    fixture.store.atomic((db) => {
      db.query("UPDATE runner_plans SET state='blocked',reason='held for review'").run()
      db.query("UPDATE runner_nodes SET state='running'").run()
    })
    expect(
      (await read()).sessions.find((item) => item.sessionID === "ses-failed")?.assignment?.task,
    ).toMatchObject({ state: "running", planState: "blocked", planReason: "held for review" })
    fixture.store.atomic((db) => {
      db.query("UPDATE runner_plans SET state='running',reason=NULL").run()
      db.query("UPDATE runner_nodes SET state='queued'").run()
    })
    // The workload is the Tasks panel's own definition: it must equal TaskRepository.stateCounts.
    const tasksCounts = () => {
      const counts = fixture.repository.readPage({
        search: "",
        limit: 1,
        state: "all",
        stateCounts: true,
      }).stateCounts!
      return { queued: counts.queued, needsYou: counts.blocked, failed: counts.failed }
    }
    expect(live.workload).toEqual(tasksCounts())
    expect(live.workload).toEqual({ queued: 1, needsYou: 0, failed: 0 })

    fixture.store.atomic((db) => db.query("UPDATE runner_nodes SET state='blocked'").run())
    expect((await read()).workload).toEqual(tasksCounts())
    expect((await read()).workload).toEqual({ queued: 0, needsYou: 1, failed: 0 })
    fixture.store.atomic((db) => db.query("UPDATE runner_nodes SET state='failed'").run())
    expect((await read()).workload).toEqual(tasksCounts())
    expect((await read()).workload).toEqual({ queued: 0, needsYou: 0, failed: 1 })
    // A paused plan's queued work is Paused, not Queued, exactly as in Tasks.
    fixture.store.atomic((db) => {
      db.query("UPDATE runner_nodes SET state='queued'").run()
      db.query(
        "INSERT INTO runner_dispatch_controls(plan_id,state,reason,until_plans,updated_at) SELECT id,'paused','test','[]',1 FROM runner_plans",
      ).run()
    })
    expect((await read()).workload).toEqual(tasksCounts())
    expect((await read()).workload).toEqual({ queued: 0, needsYou: 0, failed: 0 })
    // A global pause holds the same queued work as Paused, with no plan pause involved.
    fixture.store.atomic((db) => {
      db.query("DELETE FROM runner_dispatch_controls").run()
      db.query(
        "INSERT INTO lazers_dispatch_pause(scope,state,reason,by,updated_at) VALUES('global','paused','test','owner',1)",
      ).run()
    })
    expect((await read()).workload).toEqual(tasksCounts())
    expect((await read()).workload).toEqual({ queued: 0, needsYou: 0, failed: 0 })
    fixture.store.atomic((db) => db.query("DELETE FROM lazers_dispatch_pause").run())
    expect((await read()).workload).toEqual({ queued: 1, needsYou: 0, failed: 0 })

    // A session without a native parent omits the field rather than carrying null.
    const owner = (await read()).sessions.find((item) => item.sessionID !== "ses-failed")
    if (owner) expect("parentSessionID" in owner).toBe(owner.parentSessionID !== undefined)
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

test("the live attempt read carries the call count, model and tick summary of one session's attempt", async () => {
  const fixture = makeFixture()
  try {
    const secret = new Uint8Array(32).fill(83)
    const reads = new ObservationReads(fixture.store, fixture.host, "project", secret)
    fixture.store.atomic((db) => {
      db.query("UPDATE runner_attempts SET tool_count=3,policy=? WHERE id=?").run(
        JSON.stringify({ model: { providerID: "openai", id: "gpt-6-luna", variant: "max" } }),
        firstAttemptID,
      )
      db.query(
        `INSERT INTO runner_progress
           (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,source,sources_json,kind,event_ids_json,call_id,dedupe_key,payload)
         SELECT p.project_directory,'project',a.plan_id,a.task_id,a.id,a.session_id,5000,'native','[]','tool','[]','call-a','dedupe-a',?
           FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id WHERE a.id=?`,
      ).run(
        JSON.stringify({ status: "failed", fileTargets: { operation: "edit", paths: ["a.ts"] } }),
        firstAttemptID,
      )
    })
    const attempt = fixture.store.atomic(
      (db) =>
        db
          .query<{ session_id: string }, [string]>(
            "SELECT session_id FROM runner_attempts WHERE id=?",
          )
          .get(firstAttemptID)!.session_id,
    )
    const response = reads.liveAttempt(
      { scope: { kind: "project", sessionID: "anchor" }, sessionID: attempt },
      new AbortController().signal,
    )
    expect(response.attempt).toMatchObject({
      id: firstAttemptID,
      toolCount: 3,
      model: { providerID: "openai", id: "gpt-6-luna", variant: "max" },
      summary: { lastActivityAt: 5000, ticks: [{ at: 5000, failed: true }], files: 1 },
      task: { state: expect.any(String), planState: expect.any(String) },
    })
    for (const group of ["needs-you", "failed", "queued"] as const) {
      const listed = reads.liveGroup(
        { scope: { kind: "project", sessionID: "anchor" }, group },
        new AbortController().signal,
      )
      expect(listed.group).toBe(group)
      expect(listed.tasks.length).toBeLessThanOrEqual(listed.total)
      for (const task of listed.tasks) expect(task.title).not.toBe("")
    }
    expect(
      reads.liveAttempt(
        { scope: { kind: "project", sessionID: "anchor" }, sessionID: "no-such-session" },
        new AbortController().signal,
      ).attempt,
    ).toBeNull()
    expect(() =>
      reads.liveAttempt(
        { scope: { kind: "session", sessionID: attempt }, sessionID: "another-session" },
        new AbortController().signal,
      ),
    ).toThrow()
  } finally {
    fixture.close()
  }
})

test("the live attempt read carries an open concern with its advice and marks a takeover attempt", () => {
  const fixture = makeFixture()
  try {
    const reads = new ObservationReads(fixture.store, fixture.host, "project", new Uint8Array(32))
    const read = () => {
      const sessionID = fixture.store.atomic(
        (db) =>
          db
            .query<{ session_id: string }, [string]>(
              "SELECT session_id FROM runner_attempts WHERE id=?",
            )
            .get(firstAttemptID)!.session_id,
      )
      return reads.liveAttempt(
        { scope: { kind: "project", sessionID: "anchor" }, sessionID },
        new AbortController().signal,
      ).attempt
    }
    // Nothing is recorded: neither signal is present.
    expect(read()).not.toHaveProperty("concern")
    expect(read()).not.toHaveProperty("takeover")

    fixture.store.atomic((db) => {
      db.query("UPDATE runner_nodes SET state='running'").run()
    })
    new HandoffStore(fixture.store.repository).recordConcern(
      {
        requestID: "concern-request",
        concernID: crypto.randomUUID(),
        sourceAttemptID: firstAttemptID,
        ruleID: "verify-rounds-repeated",
        reason: "3 verification rounds",
        evidenceBoundary: { fromSequence: 0, throughSequence: 1 },
        evidence: [
          {
            kind: "trajectory",
            reference: "runner:1",
            note: "n; magnitude=3; action=takeover; because=Rounds keep failing",
          },
        ],
      },
      DETECTOR_ACTOR,
    )
    expect(read()?.concern).toEqual({
      line: "3 verification rounds",
      action: "takeover",
      because: "Rounds keep failing",
    })

    fixture.store.atomic((db) => {
      db.query("UPDATE runner_attempts SET policy=? WHERE id=?").run(
        JSON.stringify({
          agent: "architect",
          takeover: {
            takeoverID: crypto.randomUUID(),
            architectSessionID: "architect",
            fromAttemptID: crypto.randomUUID(),
          },
        }),
        firstAttemptID,
      )
    })
    expect(read()?.takeover).toBe(true)
  } finally {
    fixture.close()
  }
})
