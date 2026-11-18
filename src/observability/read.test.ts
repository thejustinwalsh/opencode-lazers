import { expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { ObservationChangeTracker } from "./changes.ts"
import { ObservationReads } from "./read.ts"
import { RadarOutput, SnapshotOutput } from "./contract.ts"
import {
  makeFixture,
  taskID,
  firstAttemptID,
  secondAttemptID,
} from "../../test/trajectory/fixture.ts"
import { AssociationTaskReads } from "./task-reads.ts"
import { ProgressRecorder } from "../progress/recorder.ts"
import { validProposal } from "../../test/proposal.ts"
import type { TrajectoryHost, TrajectorySession } from "../trajectory/native.ts"
import type { RadarNativeSession, RadarSessionHost } from "./native.ts"
import { ObservationSyncState } from "./state.ts"

function metadataOnlyHost(fixture: ReturnType<typeof makeFixture>): TrajectoryHost {
  return {
    session: (id) => fixture.host.session(id),
    status: async (id) => {
      const session = fixture.sessions.get(id)
      return session
        ? { ...session, messages: null, messageStatus: "not-read", messageError: null }
        : null
    },
  }
}

function radarSession(
  id: string,
  options: {
    projectID?: string
    parentID?: string | null
    directory?: string
    archived?: boolean
    model?: RadarNativeSession["model"]
  } = {},
): RadarNativeSession {
  return {
    id,
    projectID: options.projectID ?? "project",
    parentID: options.parentID ?? null,
    directory: options.directory ?? "/workspace/project",
    agent: "architect",
    model: options.model ?? { providerID: "google", id: "gemini-current", variant: "high" },
    archived: options.archived ?? false,
    busy: false,
    createdAt: 1_000,
    updatedAt: 2_000,
  }
}

function radarHost(values: RadarNativeSession[]): RadarSessionHost {
  const byID = new Map(values.map((session) => [session.id, session]))
  return {
    get: async (id) => byID.get(id) ?? null,
    project: async (projectID, includeArchived, limit) => {
      const matching = [...byID.values()].filter(
        (session) => session.projectID === projectID && (includeArchived || !session.archived),
      )
      return { sessions: matching.slice(0, limit), truncated: matching.length > limit }
    },
    descendants: async (projectID, rootID, includeArchived, limit) => {
      const sessions: RadarNativeSession[] = []
      const visited = new Set([rootID])
      let changed = true
      while (changed) {
        changed = false
        for (const session of byID.values()) {
          if (
            session.projectID === projectID &&
            session.parentID &&
            visited.has(session.parentID) &&
            !visited.has(session.id) &&
            (includeArchived || !session.archived)
          ) {
            visited.add(session.id)
            sessions.push(session)
            changed = true
          }
        }
      }
      return { sessions: sessions.slice(0, limit), truncated: sessions.length > limit }
    },
  }
}

function radarReads(
  fixture: ReturnType<typeof makeFixture>,
  sessions: RadarSessionHost,
  secret = new Uint8Array(32).fill(12),
) {
  return new ObservationReads(fixture.store, fixture.host, "project", secret, sessions)
}

test("session snapshots expose actual machine topology and recorded transitions separately, read-only", () => {
  const fixture = makeFixture()
  try {
    const secret = new Uint8Array(32).fill(9)
    const reads = new ObservationReads(fixture.store, fixture.host, "project", secret)
    const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
    tracker.initialize()
    const before = fixture.store.atomic((db) => ({
      taskChanges: db.query("SELECT id FROM task_changes ORDER BY id").all(),
      auditTables: db.query("SELECT name FROM sqlite_master WHERE name LIKE '%audit%'").all(),
      transitions: db.query("SELECT id FROM runner_transitions ORDER BY id").all(),
    }))

    const snapshot = reads.snapshot({ kind: "session", sessionID: "ses-failed" }, tracker)
    expect(SnapshotOutput.safeParse(snapshot).success).toBe(true)
    expect(snapshot.scope).toEqual({ kind: "session", sessionID: "ses-failed" })
    expect(snapshot.machine).toMatchObject({ id: "lazers-task", version: "lazers-task/1" })
    expect(snapshot.machine.states.some((state) => state.id === "running")).toBe(true)
    expect(snapshot.plans).toHaveLength(1)
    expect(snapshot.plans[0]?.nodes.map((node) => node.taskID)).toEqual([taskID])
    expect(snapshot.plans[0]?.nodes[0]).toMatchObject({
      state: "accepted",
      snapshot: { status: "active", value: "queued" },
      snapshotMatchesState: false,
    })
    expect(snapshot.transitions.map((transition) => transition.sequence)).toEqual([1, 2, 3])
    expect(snapshot.transitions.map((transition) => transition.kind)).toEqual([
      "runtime",
      "runtime",
      "machine",
    ])
    expect(snapshot.transitions[2]).toMatchObject({
      event: "ACCEPT",
      from: "verifying",
      to: "accepted",
      attemptID: "509e5ba7-6b7e-40eb-8f49-25b3789c1ba6",
    })
    expect(snapshot.boundary.transitionSequence).toBe(3)
    expect(JSON.stringify(snapshot)).not.toContain("api_key")
    expect(JSON.stringify(snapshot)).not.toContain('"policy"')
    expect(JSON.stringify(snapshot)).not.toContain("/private/")

    const after = fixture.store.atomic((db) => ({
      taskChanges: db.query("SELECT id FROM task_changes ORDER BY id").all(),
      auditTables: db.query("SELECT name FROM sqlite_master WHERE name LIKE '%audit%'").all(),
      transitions: db.query("SELECT id FROM runner_transitions ORDER BY id").all(),
    }))
    expect(after).toEqual(before)
  } finally {
    fixture.close()
  }
})

test("Radar reads legacy progress rows without recorded_at and performs no schema migration", async () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) => {
      db.query(
        `INSERT INTO runner_progress
         (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,source,
          sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        fixture.directory,
        "project",
        fixture.attempts[0]!.plan_id,
        taskID,
        firstAttemptID,
        "ses-failed",
        4321,
        "recovery",
        '["recovery"]',
        "tool",
        "[]",
        "legacy-call",
        "msg-legacy-radar",
        "legacy-radar-row",
        '{"tool":"Bash","status":"unknown","observations":[]}',
      )
      db.exec("ALTER TABLE runner_progress DROP COLUMN recorded_at")
    })
    const secret = new Uint8Array(32).fill(17)
    const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
    tracker.initialize()
    const reads = radarReads(
      fixture,
      radarHost([
        radarSession("ses-owner"),
        radarSession("ses-failed", { parentID: "ses-owner", directory: fixture.directory }),
      ]),
      secret,
    )
    const result = await reads.radar(
      { scope: { kind: "session", sessionID: "ses-failed" }, includeUnmanagedSessions: false },
      tracker,
      new AbortController().signal,
    )
    expect(RadarOutput.safeParse(result).success).toBe(true)
    const columns = fixture.store.atomic((db) =>
      db.query<{ name: string }, []>("PRAGMA table_info(runner_progress)").all(),
    )
    expect(columns.some((column) => column.name === "recorded_at")).toBe(false)
  } finally {
    fixture.close()
  }
})

test("trajectory projection preserves unique-session effort and refuses out-of-scope attempts", async () => {
  const fixture = makeFixture()
  try {
    const secret = new Uint8Array(32).fill(8)
    const reads = new ObservationReads(fixture.store, fixture.host, "project", secret)
    const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
    tracker.initialize()
    const result = await reads.trajectory(
      { scope: { kind: "session", sessionID: "ses-failed" }, taskID, limit: 20 },
      tracker,
    )
    const report = result.report as {
      effort: {
        toolCalls: { count: number }
        tokenUsage: {
          total: { uncachedInput: number } | null
          totalSessions: number
          unknownAttempts: string[]
        }
        recordedCost: { apiEquivalentTotalUsd: number | null }
      }
      attempts: Array<{
        intervals: {
          attempt: { endedAt: number | null; basis: string }
          modelActivity: { endedAt: number | null; basis: string }
        }
        checks: Array<{ startedAt: number | null; endedAt: number | null; timingBasis: string }>
      }>
      trajectory: { events: unknown[] }
    }
    expect(report.effort.toolCalls.count).toBe(5)
    expect(report.effort.tokenUsage.totalSessions).toBe(2)
    expect(report.effort.tokenUsage.total?.uncachedInput).toBe(30)
    expect(report.effort.tokenUsage.unknownAttempts).toEqual([])
    expect(report.effort.recordedCost.apiEquivalentTotalUsd).toBeNull()
    expect(report.attempts).toHaveLength(2)
    expect(report.attempts.every((attempt) => attempt.intervals.attempt.endedAt === null)).toBe(
      true,
    )
    expect(report.attempts[0]?.intervals.attempt.basis).toContain("no attempt end is inferred")
    expect(report.attempts[0]?.intervals.modelActivity.endedAt).toBe(1200)
    expect(report.attempts[0]?.intervals.modelActivity.basis).toContain(
      "idle is not task acceptance",
    )
    expect(report.attempts[0]?.checks[0]).toMatchObject({
      startedAt: 1100,
      endedAt: 1200,
      timingBasis: expect.stringContaining("Verification receipt"),
    })
    expect(report.trajectory.events.length).toBeGreaterThan(0)

    await expect(
      reads.trajectory(
        {
          scope: { kind: "session", sessionID: "ses-unrelated" },
          attemptID: firstAttemptID,
          limit: 20,
        },
        tracker,
      ),
    ).rejects.toThrow("No observation in this scope")
  } finally {
    fixture.close()
  }
})

test("snapshot supplies complete task labels and recorded Timeline intervals without native history", () => {
  const fixture = makeFixture()
  try {
    const secret = new Uint8Array(32).fill(6)
    let nativeReads = 0
    fixture.host.session = async () => {
      nativeReads++
      throw new Error("Timeline snapshot must not fetch native transcripts")
    }
    fixture.store.atomic((db) => {
      for (const [event, observedAt] of [
        ["WORKER_STARTED", 1010],
        ["WORKER_STOPPED", 1090],
      ] as const)
        db.query(
          "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) SELECT plan_id,task_id,1,?,?,? FROM runner_attempts WHERE id=?",
        ).run(
          event,
          JSON.stringify({ attemptID: firstAttemptID, observedAt }),
          observedAt + 1,
          firstAttemptID,
        )
    })
    const reads = new ObservationReads(fixture.store, fixture.host, "project", secret)
    const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
    tracker.initialize()
    const snapshot = reads.snapshot({ kind: "session", sessionID: "ses-failed" }, tracker)
    expect(snapshot.plans[0]?.nodes[0]).toMatchObject({
      taskID,
      revision: 1,
      objective: "Inspect a worker attempt without disclosing private data",
    })
    const timeline = snapshot as unknown as {
      attempts: Array<{
        id: string
        startedAt: number
        endedAt: number | null
        executions: Array<{ startedAt: number | null; endedAt: number | null }>
      }>
      checks: Array<{
        id: string
        attemptID: string | null
        startedAt: number | null
        endedAt: number | null
        exitCode: number | null
      }>
    }
    expect(timeline.attempts).toHaveLength(2)
    expect(timeline.attempts.every((attempt) => attempt.endedAt === null)).toBe(true)
    expect(timeline.attempts.find((attempt) => attempt.id === firstAttemptID)).toMatchObject({
      startedAt: 1000,
      endedAt: null,
      executions: [{ startedAt: 1010, endedAt: 1090 }],
    })
    expect(timeline.checks.find((check) => check.id === "check-failed")).toMatchObject({
      attemptID: firstAttemptID,
      startedAt: 1100,
      endedAt: 1200,
      exitCode: 7,
    })
    expect(timeline.checks.find((check) => check.id === "check-combined")).toMatchObject({
      attemptID: null,
      startedAt: 3600,
      endedAt: 3800,
      exitCode: 0,
    })
    expect(nativeReads).toBe(0)
    expect(JSON.stringify(snapshot)).not.toContain("logged-secret")
    expect(JSON.stringify(snapshot)).not.toContain("stdout")
    expect(JSON.stringify(snapshot)).not.toContain("policy")
  } finally {
    fixture.close()
  }
})

test("associated task reads resolve references consistently for session queries and gets", () => {
  const fixture = makeFixture()
  try {
    const reads = new AssociationTaskReads(fixture.repository)
    fixture.store.updatePlanOwner(fixture.receipt.planID, "ses-owner", "ses-reviewer")
    for (const sessionID of ["ses-owner", "ses-reviewer", "ses-failed", "ses-accepted"]) {
      expect(
        reads.query({ sessionID, search: "LZ-1", includeCompleted: true }).tasks,
      ).toMatchObject([
        { taskID, reference: "LZ-1", matches: [{ field: "reference", snippet: "LZ-1" }] },
      ])
      expect(reads.get({ taskID: "LZ-1", sessionID })).toMatchObject({
        status: "found",
        reference: "LZ-1",
        task: { id: taskID },
      })
    }
    expect(
      reads.query({ sessionID: "ses-unrelated", search: "LZ-1", includeCompleted: true }).tasks,
    ).toEqual([])
    expect(reads.get({ taskID: "LZ-1", sessionID: "ses-unrelated" })).toEqual({
      status: "not_found",
    })
  } finally {
    fixture.close()
  }
})

test("captured history pages stay fixed while ten live status reads use no native context", async () => {
  const fixture = makeFixture()
  const secret = new Uint8Array(32).fill(5)
  const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
  tracker.initialize()
  let contextReads = 0
  let statusReads = 0
  const host: TrajectoryHost = {
    session: async (id: string) => {
      contextReads++
      return fixture.host.session(id)
    },
    status: async (id: string) => {
      statusReads++
      const session = fixture.sessions.get(id)
      return session
        ? { ...session, messages: null, messageStatus: "not-read", messageError: null }
        : null
    },
  }
  const reads = new ObservationReads(fixture.store, host, "project", secret)
  const scope = { kind: "project" as const, sessionID: "ses-owner" }
  const pageView = (response: Awaited<ReturnType<typeof reads.trajectoryHistory>>) =>
    response.report.trajectory as {
      events: Array<{ id: string }>
      nextCursor: string | null
      totalEvents: number
    }

  try {
    const first = await reads.trajectoryHistory({ scope, taskID, limit: 2 }, tracker)
    const capturedIDs = first.eventIDs!
    const contextMessages = [...fixture.sessions.values()].reduce(
      (total, session) => total + (session.messages?.length ?? 0),
      0,
    )
    expect(capturedIDs.length).toBeGreaterThanOrEqual(8)
    expect(contextReads).toBe(2)

    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
    )
    const failedSession = fixture.sessions.get("ses-failed")!
    failedSession.tokens = {
      input: 11,
      output: 4,
      reasoning: 3,
      cache: { read: 6, write: 1 },
    }
    failedSession.model = { providerID: "openai", id: "gpt-6.1-sol", variant: "high" }

    const recorder = new ProgressRecorder(fixture.store, "project")
    const native = (type: string, id: string, created: number, content?: string) =>
      recorder.recordNativeEvent({
        id,
        type,
        created,
        data: {
          sessionID: "ses-failed",
          assistantMessageID: "msg-live",
          id: "live-tool-call",
          executed: true,
          ...(content ? { content: [{ type: "text", text: content }] } : {}),
        },
      })

    const loadedIDs = pageView(first).events.map((event) => event.id)
    let cursor = pageView(first).nextCursor
    let finalStatus: Awaited<ReturnType<typeof reads.trajectoryStatus>> | undefined
    let runningSequence: number | undefined
    for (let refresh = 0; refresh < 10; refresh++) {
      if (refresh === 1) runningSequence = native("session.tool.called", "live-running", 3000)
      if (refresh === 3) native("session.tool.success", "live-success", 3010, "finished safely")
      finalStatus = await reads.trajectoryStatus({ scope, taskID }, tracker)
      if (refresh === 1) {
        const statusReport = finalStatus.report as {
          trajectory: { events: Array<{ id: string; status?: string }> }
        }
        expect(
          statusReport.trajectory.events.find((event) => event.id === `progress:${runningSequence}`)
            ?.status,
        ).toBe("running")
      }
      if (refresh === 3) {
        const statusReport = finalStatus.report as {
          trajectory: { events: Array<{ id: string; status?: string; result?: string }> }
        }
        expect(
          statusReport.trajectory.events.find(
            (event) => event.id === `progress:${runningSequence}`,
          ),
        ).toMatchObject({ status: "succeeded", result: "finished safely" })
      }
      if (refresh === 0 || refresh === 2 || refresh === 5) {
        if (cursor) {
          const page = await reads.trajectoryHistory({ scope, taskID, limit: 2, cursor }, tracker)
          loadedIDs.push(...pageView(page).events.map((event) => event.id))
          cursor = pageView(page).nextCursor
        }
      }
    }
    expect(statusReads).toBe(20)
    expect(contextReads).toBe(2)
    expect(loadedIDs).toEqual(capturedIDs.slice(0, 8))
    expect(new Set(loadedIDs).size).toBe(loadedIDs.length)
    expect(capturedIDs).not.toContain(`progress:${runningSequence}`)

    const latest = finalStatus!.report as {
      attempts: Array<{
        id: string
        observedCurrentModel: { providerID: string; id: string; variant?: string } | null
      }>
      effort: { tokenUsage: { totalSessions: number }; toolCalls: { count: number } }
      plans: Array<{ checks: unknown[] }>
      coverage: { sessionRead: string; fullSessionHistory: string }
    }
    expect(
      latest.attempts.find((attempt) => attempt.id === firstAttemptID)?.observedCurrentModel,
    ).toEqual({ providerID: "openai", id: "gpt-6.1-sol", variant: "high" })
    expect(latest.effort.tokenUsage.totalSessions).toBe(2)
    expect(latest.effort.toolCalls.count).toBe(5)
    expect(latest.plans[0]?.checks.length).toBeGreaterThan(0)
    expect(latest.coverage.sessionRead).toContain("session.context was not read")
    expect(latest.coverage.fullSessionHistory).toBe(
      "not guaranteed; use explicit warnings and do not infer omitted history",
    )

    const recaptured = await reads.trajectoryHistory({ scope, taskID, limit: 2 }, tracker)
    expect(contextReads).toBe(4)
    expect(recaptured.eventIDs).toContain(`progress:${runningSequence}`)
    expect(pageView(recaptured).totalEvents).toBeGreaterThan(pageView(first).totalEvents)
    expect({
      initial: { contextCalls: 2, messages: contextMessages, events: capturedIDs.length },
      statusAndPages: {
        statusRefreshes: 10,
        continuations: 3,
        additionalContextCalls: contextReads - 4,
      },
      explicitRecapture: {
        contextCalls: contextReads - 2,
        messages: contextMessages,
        events: recaptured.eventIDs!.length,
      },
    }).toEqual({
      initial: { contextCalls: 2, messages: contextMessages, events: capturedIDs.length },
      statusAndPages: { statusRefreshes: 10, continuations: 3, additionalContextCalls: 0 },
      explicitRecapture: {
        contextCalls: 2,
        messages: contextMessages,
        events: recaptured.eventIDs!.length,
      },
    })
  } finally {
    fixture.close()
  }
})

test("history and status reads leave durable audits and repository watermarks unchanged", async () => {
  const fixture = makeFixture()
  try {
    const secret = new Uint8Array(32).fill(3)
    const reads = new ObservationReads(fixture.store, metadataOnlyHost(fixture), "project", secret)
    const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
    tracker.initialize()
    const before = fixture.repository.atomic((db) => ({
      watermark: fixture.repository.version(),
      audit: db.query<{ count: number }, []>("SELECT count(*) AS count FROM runner_audits").get()!
        .count,
      progress: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_progress")
        .get()!.count,
    }))
    const scope = { kind: "project" as const, sessionID: "ses-owner" }
    const first = await reads.trajectoryHistory({ scope, taskID, limit: 2 }, tracker)
    const cursor = (first.report.trajectory as { nextCursor: string | null }).nextCursor
    if (cursor) await reads.trajectoryHistory({ scope, taskID, limit: 2, cursor }, tracker)
    await reads.trajectoryStatus({ scope, taskID }, tracker)
    const after = fixture.repository.atomic((db) => ({
      watermark: fixture.repository.version(),
      audit: db.query<{ count: number }, []>("SELECT count(*) AS count FROM runner_audits").get()!
        .count,
      progress: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_progress")
        .get()!.count,
    }))
    expect(after).toEqual(before)
  } finally {
    fixture.close()
  }
})

test("target trajectory reads survive unrelated project transition volume and keep scope boundaries truthful", async () => {
  const fixture = makeFixture()
  try {
    const secret = new Uint8Array(32).fill(21)
    const reads = new ObservationReads(fixture.store, metadataOnlyHost(fixture), "project", secret)
    const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
    tracker.initialize()
    const scope = { kind: "session" as const, sessionID: "ses-failed" }
    const unrelatedTransitions = JSON.stringify(Array.from({ length: 10_001 }, (_, index) => index))
    fixture.store.atomic((db) =>
      db
        .query(
          `INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at)
           SELECT ?,NULL,1,'UNRELATED','{}',5000+CAST(key AS INTEGER) FROM json_each(?)`,
        )
        .run(fixture.receipt.planID, unrelatedTransitions),
    )
    const maxSequence = () =>
      fixture.store.atomic(
        (db) =>
          db
            .query<{ sequence: number }, [string]>(
              "SELECT MAX(id) AS sequence FROM runner_transitions WHERE plan_id=?",
            )
            .get(fixture.receipt.planID)!.sequence,
      )
    const fullScopeSequence = maxSequence()

    // The broad projection remains bounded; targeted reads must not inherit its failure.
    expect(() => reads.snapshot(scope, tracker)).toThrow(
      "Observation scope is too large; narrow it",
    )
    const taskTrajectory = await reads.trajectory({ scope, taskID, limit: 20 }, tracker)
    expect(taskTrajectory.boundary.transitionSequence).toBe(fullScopeSequence)
    expect(taskTrajectory.report).toMatchObject({ task: { id: taskID } })
    expect(JSON.stringify(taskTrajectory.report)).not.toContain("UNRELATED")
    expect(
      (
        taskTrajectory.report as {
          trajectory: { events: Array<{ kind: string; event?: string }> }
        }
      ).trajectory.events.some(
        (event) => event.kind === "runner-transition" && event.event === "ACCEPT",
      ),
    ).toBe(true)

    const attemptTrajectory = await reads.trajectory(
      { scope, attemptID: firstAttemptID, limit: 20 },
      tracker,
    )
    expect(attemptTrajectory.boundary.transitionSequence).toBe(fullScopeSequence)
    expect(attemptTrajectory.report).toMatchObject({
      task: { id: taskID },
      focusedAttemptID: firstAttemptID,
      attempts: [{ id: firstAttemptID }],
    })
    expect(JSON.stringify(attemptTrajectory.report)).not.toContain("UNRELATED")

    const firstPage = await reads.trajectoryHistory({ scope, taskID, limit: 2 }, tracker)
    const firstTrajectory = firstPage.report.trajectory as {
      nextCursor: string | null
    }
    expect(firstPage.boundary.transitionSequence).toBe(fullScopeSequence)
    expect(firstTrajectory.nextCursor).not.toBeNull()
    expect(JSON.stringify(firstPage.report)).not.toContain("UNRELATED")

    // Unrelated writes do not change the identity or sequence of a captured page set.
    fixture.store.atomic((db) =>
      db
        .query(
          `INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at)
           VALUES(?,NULL,1,'UNRELATED','{}',20000)`,
        )
        .run(fixture.receipt.planID),
    )
    const pinnedBoundary = firstPage.boundary
    const beforeReads = fixture.store.atomic((db) => ({
      tasks: db.query("SELECT id,body FROM tasks ORDER BY id").all(),
      taskChanges: db.query("SELECT id FROM task_changes ORDER BY id").all(),
      dispositions: db.query("SELECT id FROM task_dispositions ORDER BY id").all(),
      audits: db.query("SELECT id FROM runner_audits ORDER BY id").all(),
      progress: db.query("SELECT seq FROM runner_progress ORDER BY seq").all(),
      attempts: db.query("SELECT id FROM runner_attempts ORDER BY id").all(),
      effects: db.query("SELECT id FROM runner_effects ORDER BY id").all(),
      transitions: db.query("SELECT id FROM runner_transitions ORDER BY id").all(),
    }))
    const continuation = await reads.trajectoryHistory(
      {
        scope,
        taskID,
        limit: 2,
        cursor: firstTrajectory.nextCursor!,
      },
      tracker,
    )
    const continuationTrajectory = continuation.report.trajectory as { page: number }
    expect(continuation.capturedAt).toBe(firstPage.capturedAt)
    expect(continuation.boundary).toEqual(pinnedBoundary)
    expect(continuationTrajectory.page).toBe(2)
    expect(JSON.stringify(continuation.report)).not.toContain("UNRELATED")

    const status = await reads.trajectoryStatus({ scope, taskID }, tracker)
    expect(status.boundary.transitionSequence).toBe(maxSequence())
    expect(status.boundary.transitionSequence).toBeGreaterThan(fullScopeSequence)
    expect(status.report).toMatchObject({
      task: { id: taskID },
      effort: {
        tokenUsage: {
          total: { uncachedInput: 30 },
          totalSessions: 2,
          unknownAttempts: [],
        },
        toolCalls: { count: 5 },
      },
    })
    expect(JSON.stringify(status.report)).not.toContain("UNRELATED")

    await expect(
      reads.trajectory(
        {
          scope: { kind: "session", sessionID: "ses-unrelated" },
          attemptID: firstAttemptID,
          limit: 20,
        },
        tracker,
      ),
    ).rejects.toThrow("No observation in this scope")
    await expect(
      reads.trajectoryHistory({ scope, taskID: crypto.randomUUID(), limit: 2 }, tracker),
    ).rejects.toThrow("No observation in this scope")
    const afterReads = fixture.store.atomic((db) => ({
      tasks: db.query("SELECT id,body FROM tasks ORDER BY id").all(),
      taskChanges: db.query("SELECT id FROM task_changes ORDER BY id").all(),
      dispositions: db.query("SELECT id FROM task_dispositions ORDER BY id").all(),
      audits: db.query("SELECT id FROM runner_audits ORDER BY id").all(),
      progress: db.query("SELECT seq FROM runner_progress ORDER BY seq").all(),
      attempts: db.query("SELECT id FROM runner_attempts ORDER BY id").all(),
      effects: db.query("SELECT id FROM runner_effects ORDER BY id").all(),
      transitions: db.query("SELECT id FROM runner_transitions ORDER BY id").all(),
    }))
    expect(afterReads).toEqual(beforeReads)
  } finally {
    fixture.close()
  }
})

for (const change of ["source", "native"] as const)
  test(`target status rejects a ${change} change during its read`, async () => {
    const fixture = makeFixture()
    try {
      const secret = new Uint8Array(32).fill(change === "source" ? 24 : 25)
      const started = Promise.withResolvers<void>()
      const pending = Promise.withResolvers<TrajectorySession | null>()
      const host: TrajectoryHost = {
        session: (id) => fixture.host.session(id),
        status: (id) => {
          if (id === "ses-failed") {
            started.resolve()
            return pending.promise
          }
          const session = fixture.sessions.get(id)
          return Promise.resolve(
            session
              ? { ...session, messages: null, messageStatus: "not-read", messageError: null }
              : null,
          )
        },
      }
      const reads = new ObservationReads(fixture.store, host, "project", secret)
      const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
      tracker.initialize()
      const scope = { kind: "session" as const, sessionID: "ses-failed" }
      const reading = reads.trajectoryStatus({ scope, taskID }, tracker)
      await started.promise
      if (change === "source") {
        fixture.store.atomic((db) =>
          db
            .query("UPDATE runner_attempts SET tool_count=tool_count+1 WHERE id=?")
            .run(firstAttemptID),
        )
      } else {
        tracker.native({ id: "native-status-change", data: { sessionID: "ses-failed" } })
      }
      pending.resolve({
        ...fixture.sessions.get("ses-failed")!,
        messages: null,
        messageStatus: "not-read",
        messageError: null,
      })
      await expect(reading).rejects.toThrow("Observation changed while reading status")
    } finally {
      fixture.close()
    }
  })

test("metadata status fails explicitly instead of falling back to session context", async () => {
  const fixture = makeFixture()
  try {
    let fullSessionReads = 0
    const reads = new ObservationReads(
      fixture.store,
      {
        session: async (id) => {
          fullSessionReads++
          return fixture.host.session(id)
        },
      },
      "project",
      new Uint8Array(32).fill(4),
    )
    const tracker = new ObservationChangeTracker(
      fixture.repository,
      new Uint8Array(32).fill(4),
      "project",
    )
    tracker.initialize()
    await expect(
      reads.trajectoryStatus(
        { scope: { kind: "project", sessionID: "ses-owner" }, taskID },
        tracker,
      ),
    ).rejects.toThrow("Metadata-only trajectory status is unavailable")
    expect(fullSessionReads).toBe(0)
  } finally {
    fixture.close()
  }
})

test("Radar default and opt-in inventories preserve exact Project and Session identity scope", async () => {
  const fixture = makeFixture()
  try {
    const sessions = radarHost([
      radarSession("ses-owner"),
      radarSession("ses-failed", { parentID: "ses-owner" }),
      radarSession("ses-accepted", { parentID: "ses-owner" }),
      radarSession("ses-unrelated", { parentID: "ses-owner" }),
      radarSession("ses-descendant", { parentID: "ses-failed" }),
      radarSession("ses-deep-descendant", { parentID: "ses-descendant" }),
      radarSession("ses-foreign", { projectID: "another-project" }),
    ])
    const reads = radarReads(fixture, sessions)
    const tracker = new ObservationChangeTracker(
      fixture.repository,
      new Uint8Array(32).fill(12),
      "project",
    )
    tracker.initialize()

    const projectDefault = await reads.radar(
      { scope: { kind: "project", sessionID: "ses-owner" }, includeUnmanagedSessions: false },
      tracker,
      new AbortController().signal,
    )
    expect(projectDefault.sessions.map((session) => session.sessionID).sort()).toEqual([
      "ses-accepted",
      "ses-failed",
      "ses-owner",
    ])
    expect(projectDefault.freshness.nativeInventory).toBe("managed-only")

    const projectOptIn = await reads.radar(
      { scope: { kind: "project", sessionID: "ses-owner" }, includeUnmanagedSessions: true },
      tracker,
      new AbortController().signal,
    )
    expect(projectOptIn.freshness.nativeInventory).toBe("complete")
    expect(projectOptIn.coverage).toMatchObject({
      includeUnmanagedSessions: true,
      inventoryTruncated: false,
      workTruncated: false,
      progressTruncated: false,
      routeTruncated: false,
      toolTruncated: false,
      edgeTruncated: false,
    })
    expect(projectOptIn.sessions.map((session) => session.sessionID).sort()).toEqual([
      "ses-accepted",
      "ses-deep-descendant",
      "ses-descendant",
      "ses-failed",
      "ses-owner",
      "ses-unrelated",
    ])
    expect(
      projectOptIn.sessions.find((session) => session.sessionID === "ses-unrelated"),
    ).toMatchObject({ classification: "unmanaged" })
    expect(projectOptIn.sessions.some((session) => session.sessionID === "ses-foreign")).toBe(false)

    const sessionDefault = await reads.radar(
      { scope: { kind: "session", sessionID: "ses-failed" }, includeUnmanagedSessions: false },
      tracker,
      new AbortController().signal,
    )
    expect(sessionDefault.sessions.map((session) => session.sessionID).sort()).toEqual([
      "ses-accepted",
      "ses-failed",
      "ses-owner",
    ])
    expect(sessionDefault.scope).toEqual({ kind: "session", sessionID: "ses-failed" })

    const sessionOptIn = await reads.radar(
      { scope: { kind: "session", sessionID: "ses-failed" }, includeUnmanagedSessions: true },
      tracker,
      new AbortController().signal,
    )
    expect(sessionOptIn.sessions.map((session) => session.sessionID).sort()).toEqual([
      "ses-accepted",
      "ses-deep-descendant",
      "ses-descendant",
      "ses-failed",
      "ses-owner",
    ])
    expect(
      sessionOptIn.sessions.find((session) => session.sessionID === "ses-deep-descendant"),
    ).toMatchObject({ associations: ["native-ancestry"] })
    expect(sessionOptIn.sessions.some((session) => session.sessionID === "ses-unrelated")).toBe(
      false,
    )
    expect(sessionOptIn.sessions.some((session) => session.sessionID === "ses-foreign")).toBe(false)

    const standaloneReads = radarReads(
      fixture,
      radarHost([
        radarSession("ses-scope-root", { parentID: "ses-parent" }),
        radarSession("ses-parent", { parentID: "ses-grandparent" }),
        radarSession("ses-grandparent"),
        radarSession("ses-sibling", { parentID: "ses-parent" }),
        radarSession("ses-child", { parentID: "ses-scope-root" }),
      ]),
    )
    const standaloneTracker = new ObservationChangeTracker(
      fixture.repository,
      new Uint8Array(32).fill(12),
      "project",
    )
    standaloneTracker.initialize()
    const standaloneDefault = await standaloneReads.radar(
      { scope: { kind: "session", sessionID: "ses-scope-root" }, includeUnmanagedSessions: false },
      standaloneTracker,
      new AbortController().signal,
    )
    expect(standaloneDefault.sessions.map((session) => session.sessionID).sort()).toEqual([
      "ses-grandparent",
      "ses-parent",
      "ses-scope-root",
    ])
    expect(
      standaloneDefault.sessions.find((session) => session.sessionID === "ses-parent"),
    ).toMatchObject({ associations: ["native-ancestry"], classification: "associated" })
    const standaloneOptIn = await standaloneReads.radar(
      { scope: { kind: "session", sessionID: "ses-scope-root" }, includeUnmanagedSessions: true },
      standaloneTracker,
      new AbortController().signal,
    )
    expect(standaloneOptIn.sessions.map((session) => session.sessionID).sort()).toEqual([
      "ses-child",
      "ses-grandparent",
      "ses-parent",
      "ses-scope-root",
    ])
    expect(
      standaloneOptIn.sessions.find((session) => session.sessionID === "ses-child"),
    ).toMatchObject({ classification: "unmanaged" })
  } finally {
    fixture.close()
  }
})

test("Radar expands only verified same-project ancestors before loading associated work", async () => {
  const fixture = makeFixture()
  try {
    const addOwnedWork = (owner: string, suffix: string) => {
      const ownedTaskID = crypto.randomUUID()
      const attemptID = crypto.randomUUID()
      const effectID = `effect-prompt-${suffix}`
      const proposal = validProposal()
      fixture.repository.insert({
        schemaVersion: 1,
        id: ownedTaskID,
        revision: 1,
        status: "submitted",
        createdAt: new Date().toISOString(),
        provenance: { ...fixture.task.provenance, sessionID: owner },
        proposal,
      })
      const receipt = fixture.store.submit(
        {
          requestID: `ancestor-work-${suffix}`,
          objective: proposal.objective,
          baseCommit: "a".repeat(40),
          workspaceMode: "shared",
          workerModel: { providerID: "openai", id: "gpt-6-luna" },
          nodes: [{ taskID: ownedTaskID, revision: 1 }],
          dependencies: [],
          integrationOrder: [ownedTaskID],
          verification: proposal.verification,
          acceptance: proposal.acceptance,
        },
        owner,
      )
      const transitionSequence = fixture.store.atomic((db) => {
        db.query(
          `INSERT INTO runner_attempts
           (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,
            state,started_at,token_count,tool_count,retry_count,cost)
           VALUES(?,?,?,1,?,?,?, ?,NULL,?,'running',9000,NULL,0,0,NULL)`,
        ).run(
          attemptID,
          receipt.planID,
          ownedTaskID,
          owner,
          `msg-${suffix}`,
          fixture.directory,
          "a".repeat(40),
          JSON.stringify({ model: { providerID: "openai", id: "gpt-6-luna" } }),
        )
        db.query(
          `INSERT INTO runner_effects
           (id,plan_id,task_id,attempt_id,kind,state,payload,receipt,fence)
           VALUES(?,?,?,?,'prompt','completed',?,NULL,1)`,
        ).run(
          effectID,
          receipt.planID,
          ownedTaskID,
          attemptID,
          JSON.stringify({ messageID: `msg-${suffix}` }),
        )
        db.query(
          `INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at)
           VALUES(?,?,1,'PROMPT_ADMITTED',?,9001)`,
        ).run(receipt.planID, ownedTaskID, JSON.stringify({ effectID, messageID: `msg-${suffix}` }))
        return db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id
      })
      return {
        taskID: ownedTaskID,
        planID: receipt.planID,
        attemptID,
        effectID,
        transitionSequence,
      }
    }

    const verified = addOwnedWork("ses-owner", "verified")
    const unresolved = addOwnedWork("ses-unresolved", "unresolved")
    const foreign = addOwnedWork("ses-foreign", "foreign")
    const tracker = new ObservationChangeTracker(
      fixture.repository,
      new Uint8Array(32).fill(19),
      "project",
    )
    tracker.initialize()

    const verifiedReads = radarReads(
      fixture,
      radarHost([
        radarSession("ses-failed", { parentID: "ses-owner", directory: fixture.directory }),
        radarSession("ses-owner", { directory: fixture.directory }),
      ]),
    )
    const projected = await verifiedReads.radar(
      { scope: { kind: "session", sessionID: "ses-failed" }, includeUnmanagedSessions: false },
      tracker,
      new AbortController().signal,
    )
    expect(projected.plans.some((plan) => plan.id === verified.planID)).toBe(true)
    expect(projected.tasks).toContainEqual({
      id: verified.taskID,
      planID: verified.planID,
      state: "queued",
    })
    expect(projected.attempts).toContainEqual(
      expect.objectContaining({
        id: verified.attemptID,
        planID: verified.planID,
        taskID: verified.taskID,
      }),
    )
    expect(projected.boundary.transitionSequence).toBe(verified.transitionSequence)
    expect(projected.edges.find((edge) => edge.id === `prompt:${verified.effectID}`)).toMatchObject(
      {
        planID: verified.planID,
        taskID: verified.taskID,
        attemptID: verified.attemptID,
        evidence: [
          expect.objectContaining({
            source: "runner-transition",
            event: "PROMPT_ADMITTED",
            effectID: verified.effectID,
          }),
        ],
      },
    )

    for (const [ancestorID, associated] of [
      ["ses-unresolved", unresolved],
      ["ses-foreign", foreign],
    ] as const) {
      const sessions = [
        radarSession("ses-failed", { parentID: ancestorID, directory: fixture.directory }),
        ...(ancestorID === "ses-foreign"
          ? [
              radarSession(ancestorID, {
                projectID: "another-project",
                directory: fixture.directory,
              }),
            ]
          : []),
      ]
      const isolatedReads = radarReads(fixture, radarHost(sessions))
      const isolated = await isolatedReads.radar(
        { scope: { kind: "session", sessionID: "ses-failed" }, includeUnmanagedSessions: false },
        tracker,
        new AbortController().signal,
      )
      expect(isolated.plans.some((plan) => plan.id === associated.planID)).toBe(false)
      expect(isolated.tasks.some((task) => task.id === associated.taskID)).toBe(false)
      expect(isolated.attempts.some((attempt) => attempt.id === associated.attemptID)).toBe(false)
      expect(isolated.edges.some((edge) => edge.id === `prompt:${associated.effectID}`)).toBe(false)
      expect(isolated.boundary.transitionSequence).toBeLessThan(associated.transitionSequence)
    }
  } finally {
    fixture.close()
  }
})

test("Radar marks missing, archived, and moved managed sessions stale without projecting routes", async () => {
  const fixture = makeFixture()
  try {
    const host = radarHost([
      radarSession("ses-failed", { directory: "/different/worktree" }),
      radarSession("ses-accepted", { archived: true }),
    ])
    const reads = radarReads(fixture, host)
    const tracker = new ObservationChangeTracker(
      fixture.repository,
      new Uint8Array(32).fill(13),
      "project",
    )
    tracker.initialize()
    const result = await reads.radar(
      { scope: { kind: "session", sessionID: "ses-failed" }, includeUnmanagedSessions: false },
      tracker,
      new AbortController().signal,
    )
    expect(result.sessions.find((session) => session.sessionID === "ses-failed")).toMatchObject({
      availability: "moved",
      freshness: "stale",
      agent: null,
      state: "unknown",
      currentRouteID: null,
      updatedAt: null,
    })
    expect(result.sessions.find((session) => session.sessionID === "ses-accepted")).toMatchObject({
      availability: "archived",
      freshness: "stale",
      currentRouteID: null,
    })
    expect(result.sessions.find((session) => session.sessionID === "ses-owner")).toMatchObject({
      availability: "missing",
      freshness: "unknown",
      currentRouteID: null,
    })
  } finally {
    fixture.close()
  }
})

test("Radar reports native inventory failures instead of implying complete coverage", async () => {
  const fixture = makeFixture()
  try {
    const host: RadarSessionHost = {
      get: async (id) => radarSession(id, { directory: fixture.directory }),
      project: async () => {
        throw new Error("native inventory unavailable")
      },
      descendants: async () => {
        throw new Error("native inventory unavailable")
      },
    }
    const reads = radarReads(fixture, host)
    const tracker = new ObservationChangeTracker(
      fixture.repository,
      new Uint8Array(32).fill(17),
      "project",
    )
    tracker.initialize()
    const result = await reads.radar(
      { scope: { kind: "project", sessionID: "ses-owner" }, includeUnmanagedSessions: true },
      tracker,
      new AbortController().signal,
    )
    expect(result.freshness.nativeInventory).toBe("unavailable")
    expect(result.coverage).toMatchObject({
      includeUnmanagedSessions: true,
      inventoryTruncated: false,
    })
    expect(result.sessions.every((session) => session.classification !== "unmanaged")).toBe(true)
  } finally {
    fixture.close()
  }
})

test("Radar separates configured, selected, and observed routes and links deduplicated event evidence", async () => {
  const fixture = makeFixture()
  try {
    const secret = new Uint8Array(32).fill(14)
    const metadata = radarHost([
      radarSession("ses-owner"),
      radarSession("ses-failed", {
        parentID: "ses-owner",
        directory: fixture.directory,
        model: { providerID: "google", id: "selection-b", variant: "high" },
      }),
      radarSession("ses-accepted", { parentID: "ses-owner", directory: fixture.directory }),
    ])
    let fullContextReads = 0
    const reads = new ObservationReads(
      fixture.store,
      {
        session: async () => {
          fullContextReads++
          return null
        },
      },
      "project",
      secret,
      metadata,
    )
    const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
    tracker.initialize()
    const recorder = new ProgressRecorder(fixture.store, "project")
    const emit = (event: Record<string, unknown>) => {
      recorder.recordNativeEvent(event)
      tracker.native(event)
    }
    const initialSourceRevision = tracker.sourceRevision
    const stepStarted = {
      id: "evt-step-c-start",
      type: "session.step.started",
      created: 3_000,
      data: {
        sessionID: "ses-failed",
        assistantMessageID: "msg-observed-c",
        agent: "lazers-implementor",
        model: { providerID: "anthropic", id: "observed-route-c", variant: "thinking" },
        started: 2_990,
      },
    }
    emit(stepStarted)
    emit(stepStarted)
    emit({
      id: "evt-step-c-end",
      type: "session.step.ended",
      created: 3_100,
      data: { sessionID: "ses-failed", assistantMessageID: "msg-observed-c" },
    })
    emit({
      id: "evt-tool-start",
      type: "session.tool.input.started",
      created: 3_200,
      data: {
        sessionID: "ses-failed",
        assistantMessageID: "msg-observed-c",
        id: "call-observed-7",
        name: "Read",
      },
    })
    emit({
      id: "evt-tool-call",
      type: "session.tool.called",
      created: 3_210,
      data: {
        sessionID: "ses-failed",
        assistantMessageID: "msg-observed-c",
        id: "call-observed-7",
      },
    })
    emit({
      id: "evt-tool-result",
      type: "session.tool.success",
      created: 3_300,
      data: {
        sessionID: "ses-failed",
        assistantMessageID: "msg-observed-c",
        id: "call-observed-7",
        content: [{ type: "text", text: "PRIVATE_RADAR_TOOL_RESULT_CANARY" }],
      },
    })
    tracker.refreshSource()
    expect(tracker.sourceRevision).toBeGreaterThan(initialSourceRevision)
    const beforeRead = fixture.store.atomic((db) => ({
      dataVersion: db.query<{ data_version: number }, []>("PRAGMA data_version").get()!
        .data_version,
      taskChanges: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM task_changes")
        .get()!.count,
      attempts: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_attempts")
        .get()!.count,
      effects: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_effects")
        .get()!.count,
      outbox: db.query<{ count: number }, []>("SELECT count(*) AS count FROM runner_outbox").get()!
        .count,
      continuations: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_continuations")
        .get()!.count,
      progress: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_progress")
        .get()!.count,
      audits: db.query<{ count: number }, []>("SELECT count(*) AS count FROM runner_audits").get()!
        .count,
      transitions: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_transitions")
        .get()!.count,
    }))
    const first = await reads.radar(
      { scope: { kind: "session", sessionID: "ses-failed" }, includeUnmanagedSessions: false },
      tracker,
      new AbortController().signal,
    )
    const afterRead = fixture.store.atomic((db) => ({
      dataVersion: db.query<{ data_version: number }, []>("PRAGMA data_version").get()!
        .data_version,
      taskChanges: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM task_changes")
        .get()!.count,
      attempts: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_attempts")
        .get()!.count,
      effects: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_effects")
        .get()!.count,
      outbox: db.query<{ count: number }, []>("SELECT count(*) AS count FROM runner_outbox").get()!
        .count,
      continuations: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_continuations")
        .get()!.count,
      progress: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_progress")
        .get()!.count,
      audits: db.query<{ count: number }, []>("SELECT count(*) AS count FROM runner_audits").get()!
        .count,
      transitions: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_transitions")
        .get()!.count,
    }))
    expect(afterRead).toEqual(beforeRead)

    const firstAttempt = first.attempts.find((attempt) => attempt.id === firstAttemptID)!
    const configured = first.routes.find((route) => route.id === firstAttempt.configuredRouteID)
    const selected = first.routes.find(
      (route) =>
        route.id === first.sessions.find((s) => s.sessionID === "ses-failed")?.currentRouteID,
    )
    const observed = first.routes.find((route) => route.eventID === "evt-step-c-start")
    expect(configured).toMatchObject({
      source: "attempt-policy",
      providerID: "openai",
      modelID: "gpt-6-luna",
    })
    expect(selected).toMatchObject({
      source: "session-selection",
      providerID: "google",
      modelID: "selection-b",
    })
    expect(observed).toMatchObject({
      source: "step-event",
      providerID: "anthropic",
      modelID: "observed-route-c",
    })
    expect(new Set([configured?.id, selected?.id, observed?.id]).size).toBe(3)

    const request = first.edges.find(
      (edge) => edge.kind === "model-request" && edge.messageID === "msg-observed-c",
    )
    const response = first.edges.find(
      (edge) => edge.kind === "model-response" && edge.messageID === "msg-observed-c",
    )
    expect(request).toMatchObject({
      kind: "model-request",
      routeID: observed?.id,
      agentID: "lazers-implementor",
      messageID: "msg-observed-c",
      startedAt: 2_990,
      observedAt: 3_000,
      live: true,
      evidence: [{ source: "native-event", eventID: "evt-step-c-start", at: 3_000 }],
    })
    expect(response).toMatchObject({
      kind: "model-response",
      routeID: observed?.id,
      messageID: "msg-observed-c",
      startedAt: 2_990,
      observedAt: 3_100,
      live: true,
      evidence: [{ source: "native-event", eventID: "evt-step-c-end", at: 3_100 }],
    })
    expect(
      first.edges.filter(
        (edge) => edge.kind === "model-request" && edge.messageID === "msg-observed-c",
      ),
    ).toHaveLength(1)
    expect(first.tools).toEqual([{ id: expect.any(String), name: "Read" }])
    expect(
      first.edges.find((edge) => edge.kind === "tool-call" && edge.callID === "call-observed-7")
        ?.evidence,
    ).toMatchObject([{ source: "native-event", eventID: "evt-tool-call", at: 3_210 }])
    expect(
      first.edges.find((edge) => edge.kind === "tool-result" && edge.callID === "call-observed-7")
        ?.evidence,
    ).toMatchObject([{ source: "native-event", eventID: "evt-tool-result", at: 3_300 }])
    expect(JSON.stringify(first)).not.toContain("PRIVATE_RADAR_TOOL_RESULT_CANARY")
    expect(fullContextReads).toBe(0)

    tracker.streamGap()
    recorder.reconcileMessages("ses-failed", [
      {
        id: "msg-observed-c",
        type: "assistant",
        time: { created: 3_400 },
        content: [],
        tokens: { input: 1, output: 1 },
      },
    ])
    tracker.refreshSource()
    const recovered = await reads.radar(
      { scope: { kind: "session", sessionID: "ses-failed" }, includeUnmanagedSessions: false },
      tracker,
      new AbortController().signal,
    )
    expect(
      recovered.edges.find(
        (edge) => edge.kind === "model-request" && edge.messageID === "msg-observed-c",
      )?.live,
    ).toBe(false)
    expect(
      recovered.edges.filter(
        (edge) => edge.kind === "model-request" && edge.messageID === "msg-observed-c",
      ),
    ).toHaveLength(1)
    expect(fullContextReads).toBe(0)
    const observations = fixture.store.atomic((db) =>
      db
        .query<{ payload: string; event_ids_json: string }, [string]>(
          "SELECT payload,event_ids_json FROM runner_progress WHERE dedupe_key=?",
        )
        .get("step:ses-failed:msg-observed-c")!,
    )
    const stored = JSON.parse(observations.payload) as { observations: Array<{ eventID?: string }> }
    expect(
      stored.observations.filter((observation) => observation.eventID === "evt-step-c-start"),
    ).toHaveLength(1)
    expect(JSON.parse(observations.event_ids_json)).toEqual(["evt-step-c-start", "evt-step-c-end"])
    expect(stored.observations.filter((observation) => !observation.eventID)).toHaveLength(1)
  } finally {
    fixture.close()
  }
})

test("Radar keeps newest progress and chronological model/tool evidence at the truncation boundary", async () => {
  const fixture = makeFixture()
  try {
    const secret = new Uint8Array(32).fill(18)
    const planID = fixture.receipt.planID
    const addFillers = (prefix: string, count: number) =>
      fixture.store.atomic((db) => {
        const insert = db.query(
          `INSERT INTO runner_progress
           (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,source,
            sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        for (let index = 0; index < count; index++)
          insert.run(
            fixture.directory,
            "project",
            planID,
            taskID,
            firstAttemptID,
            "ses-failed",
            1,
            "test",
            '["test"]',
            "commentary",
            "[]",
            null,
            null,
            `${prefix}:${index}`,
            '{"text":""}',
          )
      })
    const initialCount = fixture.store.atomic(
      (db) =>
        db
          .query<{ count: number }, [string]>(
            "SELECT count(*) AS count FROM runner_progress WHERE plan_id=?",
          )
          .get(planID)!.count,
    )
    addFillers("before-window-flow", Math.max(0, 5_001 - initialCount))

    const host = radarHost([
      radarSession("ses-owner"),
      radarSession("ses-failed", { parentID: "ses-owner", directory: fixture.directory }),
      radarSession("ses-accepted", { parentID: "ses-owner", directory: fixture.directory }),
    ])
    const reads = radarReads(fixture, host, secret)
    const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
    tracker.initialize()
    const recorder = new ProgressRecorder(fixture.store, "project")
    const emit = (id: string, type: string, created: number, data: Record<string, unknown>) => {
      const event = {
        id,
        type,
        created,
        data: { sessionID: "ses-failed", ...data },
      }
      recorder.recordNativeEvent(event)
      tracker.native(event)
    }
    emit("evt-window-step-start", "session.step.started", 30_100, {
      assistantMessageID: "msg-window-boundary",
      agent: "lazers-implementor",
      model: { providerID: "anthropic", id: "window-model", variant: "high" },
      started: 30_000,
    })
    emit("evt-window-step-end", "session.step.ended", 30_200, {
      assistantMessageID: "msg-window-boundary",
    })
    emit("evt-window-tool-start", "session.tool.input.started", 30_300, {
      assistantMessageID: "msg-window-boundary",
      id: "call-window-boundary",
      name: "Read",
    })
    emit("evt-window-tool-call", "session.tool.called", 30_400, {
      assistantMessageID: "msg-window-boundary",
      id: "call-window-boundary",
      executed: true,
    })
    emit("evt-window-tool-result", "session.tool.success", 30_500, {
      assistantMessageID: "msg-window-boundary",
      id: "call-window-boundary",
    })

    // Place the model fact at the first row retained by the newest-5000 window;
    // its start and end observations share one coalesced record.
    addFillers("after-window-flow", 4_998)
    const boundary = fixture.store.atomic((db) => ({
      firstRetained: db
        .query<{ seq: number }, [string]>(
          "SELECT seq FROM runner_progress WHERE plan_id=? ORDER BY seq DESC LIMIT 1 OFFSET 4999",
        )
        .get(planID)!.seq,
      step: db
        .query<{ seq: number }, [string, string]>(
          "SELECT seq FROM runner_progress WHERE plan_id=? AND dedupe_key=?",
        )
        .get(planID, "step:ses-failed:msg-window-boundary")!.seq,
      count: db
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM runner_progress WHERE plan_id=?",
        )
        .get(planID)!.count,
    }))
    expect(boundary.count).toBeGreaterThan(5_000)
    expect(boundary.step).toBe(boundary.firstRetained)
    tracker.refreshSource()

    const result = await reads.radar(
      { scope: { kind: "session", sessionID: "ses-failed" }, includeUnmanagedSessions: false },
      tracker,
      new AbortController().signal,
    )
    expect(result.coverage.progressTruncated).toBe(true)

    const request = result.edges.find(
      (edge) => edge.kind === "model-request" && edge.messageID === "msg-window-boundary",
    )
    const response = result.edges.find(
      (edge) => edge.kind === "model-response" && edge.messageID === "msg-window-boundary",
    )
    expect(request).toMatchObject({
      routeID: expect.any(String),
      startedAt: 30_000,
      observedAt: 30_100,
      live: true,
      evidence: [{ source: "native-event", eventID: "evt-window-step-start", at: 30_100 }],
    })
    expect(response).toMatchObject({
      routeID: request?.routeID,
      startedAt: 30_000,
      observedAt: 30_200,
      live: true,
      evidence: [{ source: "native-event", eventID: "evt-window-step-end", at: 30_200 }],
    })

    const toolCall = result.edges.find(
      (edge) => edge.kind === "tool-call" && edge.callID === "call-window-boundary",
    )
    const toolResult = result.edges.find(
      (edge) => edge.kind === "tool-result" && edge.callID === "call-window-boundary",
    )
    expect(toolCall).toMatchObject({
      observedAt: 30_400,
      live: true,
      evidence: [{ source: "native-event", eventID: "evt-window-tool-call", at: 30_400 }],
    })
    expect(toolResult).toMatchObject({
      observedAt: 30_500,
      live: true,
      evidence: [{ source: "native-event", eventID: "evt-window-tool-result", at: 30_500 }],
    })
    expect([
      request?.observedAt,
      response?.observedAt,
      toolCall?.observedAt,
      toolResult?.observedAt,
    ]).toEqual([30_100, 30_200, 30_400, 30_500])
  } finally {
    fixture.close()
  }
})

test("Radar retains recently coalesced step and tool observations beyond 5000 later rows", async () => {
  const fixture = makeFixture()
  try {
    const secret = new Uint8Array(32).fill(20)
    const planID = fixture.receipt.planID
    const host = radarHost([
      radarSession("ses-owner"),
      radarSession("ses-failed", { parentID: "ses-owner", directory: fixture.directory }),
      radarSession("ses-accepted", { parentID: "ses-owner", directory: fixture.directory }),
    ])
    const reads = radarReads(fixture, host, secret)
    const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
    tracker.initialize()
    const recorder = new ProgressRecorder(fixture.store, "project")
    const emit = (id: string, type: string, created: number, data: Record<string, unknown>) => {
      const event = { id, type, created, data: { sessionID: "ses-failed", ...data } }
      recorder.recordNativeEvent(event)
      tracker.native(event)
    }
    emit("evt-recency-step-start", "session.step.started", 30_100, {
      assistantMessageID: "msg-recency-step",
      agent: "lazers-implementor",
      model: { providerID: "anthropic", id: "recency-model" },
      started: 30_000,
    })
    emit("evt-recency-tool-input", "session.tool.input.started", 30_300, {
      assistantMessageID: "msg-recency-step",
      id: "call-recency",
      name: "Read",
    })
    emit("evt-recency-tool-call", "session.tool.called", 30_400, {
      assistantMessageID: "msg-recency-step",
      id: "call-recency",
      executed: true,
    })

    fixture.store.atomic((db) => {
      const insert = db.query(
        `INSERT INTO runner_progress
         (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,source,
          sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      for (let index = 0; index < 5_001; index++)
        insert.run(
          fixture.directory,
          "project",
          planID,
          taskID,
          firstAttemptID,
          "ses-failed",
          50_000,
          "test",
          '["test"]',
          "commentary",
          "[]",
          null,
          null,
          `recent-fill:${index}`,
          '{"text":""}',
        )
    })
    emit("evt-recency-step-end", "session.step.ended", 60_000, {
      assistantMessageID: "msg-recency-step",
    })
    emit("evt-recency-tool-result", "session.tool.success", 60_100, {
      assistantMessageID: "msg-recency-step",
      id: "call-recency",
    })
    const oldSequences = fixture.store.atomic((db) =>
      db
        .query<{ seq: number }, [string, string, string]>(
          `SELECT seq FROM runner_progress WHERE plan_id=? AND dedupe_key IN (?,?) ORDER BY seq`,
        )
        .all(planID, "step:ses-failed:msg-recency-step", "tool:ses-failed:call-recency")
        .map((row) => row.seq),
    )
    const newestSequences = fixture.store.atomic((db) =>
      db
        .query<{ seq: number }, [string]>(
          "SELECT seq FROM runner_progress WHERE plan_id=? ORDER BY seq DESC LIMIT 5000",
        )
        .all(planID)
        .map((row) => row.seq),
    )
    expect(oldSequences).toHaveLength(2)
    expect(oldSequences.every((seq) => !newestSequences.includes(seq))).toBe(true)
    tracker.refreshSource()

    const result = await reads.radar(
      { scope: { kind: "session", sessionID: "ses-failed" }, includeUnmanagedSessions: false },
      tracker,
      new AbortController().signal,
    )
    expect(result.coverage.progressTruncated).toBe(true)
    const request = result.edges.find(
      (edge) => edge.kind === "model-request" && edge.messageID === "msg-recency-step",
    )
    const response = result.edges.find(
      (edge) => edge.kind === "model-response" && edge.messageID === "msg-recency-step",
    )
    expect(request).toMatchObject({
      startedAt: 30_000,
      observedAt: 30_100,
      evidence: [{ source: "native-event", eventID: "evt-recency-step-start", at: 30_100 }],
    })
    expect(response).toMatchObject({
      routeID: request?.routeID,
      startedAt: 30_000,
      observedAt: 60_000,
      evidence: [{ source: "native-event", eventID: "evt-recency-step-end", at: 60_000 }],
    })
    expect(
      result.edges.find((edge) => edge.kind === "tool-call" && edge.callID === "call-recency"),
    ).toMatchObject({
      observedAt: 30_400,
      evidence: [{ source: "native-event", eventID: "evt-recency-tool-call", at: 30_400 }],
    })
    expect(
      result.edges.find((edge) => edge.kind === "tool-result" && edge.callID === "call-recency"),
    ).toMatchObject({
      observedAt: 60_100,
      evidence: [{ source: "native-event", eventID: "evt-recency-tool-result", at: 60_100 }],
    })
  } finally {
    fixture.close()
  }
})

test("Radar preserves equal-time step order and ignores malformed observation metadata", async () => {
  const fixture = makeFixture()
  try {
    const secret = new Uint8Array(32).fill(21)
    const planID = fixture.receipt.planID
    const reads = radarReads(
      fixture,
      radarHost([
        radarSession("ses-owner"),
        radarSession("ses-failed", { parentID: "ses-owner", directory: fixture.directory }),
        radarSession("ses-accepted", { parentID: "ses-owner", directory: fixture.directory }),
      ]),
      secret,
    )
    const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
    tracker.initialize()
    const recorder = new ProgressRecorder(fixture.store, "project")
    const emit = (id: string, type: string, data: Record<string, unknown>) => {
      const event = {
        id,
        type,
        created: 70_000,
        data: { sessionID: "ses-failed", ...data },
      }
      recorder.recordNativeEvent(event)
      tracker.native(event)
    }
    emit("evt-equal-start", "session.step.started", {
      assistantMessageID: "msg-equal-time",
      model: { providerID: "anthropic", id: "equal-time-model" },
      started: 70_000,
    })
    emit("evt-equal-end", "session.step.ended", { assistantMessageID: "msg-equal-time" })
    emit("evt-orphan-end", "session.step.ended", { assistantMessageID: "msg-orphan" })
    emit("evt-equal-late-end", "session.step.ended", {
      assistantMessageID: "msg-equal-out-of-order",
    })
    emit("evt-equal-late-start", "session.step.started", {
      assistantMessageID: "msg-equal-out-of-order",
      model: { providerID: "anthropic", id: "equal-order-model" },
      started: 70_000,
    })

    fixture.store.atomic((db) => {
      const insert = db.query(
        `INSERT INTO runner_progress
         (project_directory,project_id,plan_id,task_id,attempt_id,session_id,at,source,
          sources_json,kind,event_ids_json,call_id,message_id,dedupe_key,payload)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      const base = [
        fixture.directory,
        "project",
        planID,
        taskID,
        firstAttemptID,
        "ses-failed",
        71_000,
        "native-event",
        '["native-event"]',
        "step",
        "[]",
        null,
      ] as const
      insert.run(
        ...base,
        "msg-malformed-time",
        "malformed:infinite-time",
        '{"observations":[{"source":"native-event","eventID":"evt-infinite-time","eventType":"session.step.started","at":1e999,"messageID":"msg-malformed-time","route":{"providerID":"anthropic","modelID":"bad-time"}}]}',
      )
      insert.run(...base, "msg-malformed-json", "malformed:json", "{not-json")
      insert.run(
        ...base,
        "msg-malformed-route",
        "malformed:route",
        '{"observations":[{"source":"native-event","eventID":"evt-malformed-route","eventType":"session.step.started","at":72000,"messageID":"msg-malformed-route","route":{"providerID":"","modelID":"model"}},{"source":"native-event","eventID":"evt-malformed-route-end","eventType":"session.step.ended","at":73000,"messageID":"msg-malformed-route"}]}',
      )
    })
    tracker.refreshSource()

    const result = await reads.radar(
      { scope: { kind: "session", sessionID: "ses-failed" }, includeUnmanagedSessions: false },
      tracker,
      new AbortController().signal,
    )
    expect(
      result.edges.find(
        (edge) => edge.kind === "model-request" && edge.messageID === "msg-equal-time",
      ),
    ).toMatchObject({ startedAt: 70_000, observedAt: 70_000 })
    expect(
      result.edges.find(
        (edge) => edge.kind === "model-response" && edge.messageID === "msg-equal-time",
      ),
    ).toMatchObject({ startedAt: 70_000, observedAt: 70_000 })
    expect(
      result.edges.find(
        (edge) => edge.kind === "model-request" && edge.messageID === "msg-equal-out-of-order",
      ),
    ).toBeDefined()
    expect(
      result.edges.find(
        (edge) => edge.kind === "model-response" && edge.messageID === "msg-equal-out-of-order",
      ),
    ).toBeUndefined()
    expect(
      result.edges.filter(
        (edge) =>
          (edge.kind === "model-request" || edge.kind === "model-response") &&
          [
            "msg-orphan",
            "msg-malformed-time",
            "msg-malformed-json",
            "msg-malformed-route",
          ].includes(edge.messageID ?? ""),
      ),
    ).toEqual([])
    expect(
      result.edges.some((edge) =>
        edge.evidence.some(
          (item) => item.source === "native-event" && item.eventID === "evt-infinite-time",
        ),
      ),
    ).toBe(false)
  } finally {
    fixture.close()
  }
})

test("Radar keeps durable effect and outbox delivery stages distinct from structural links", async () => {
  const fixture = makeFixture()
  try {
    const planID = fixture.receipt.planID
    const dependentTaskID = crypto.randomUUID()
    fixture.repository.insert({
      schemaVersion: 1,
      id: dependentTaskID,
      revision: 1,
      status: "submitted",
      createdAt: new Date().toISOString(),
      provenance: { ...fixture.task.provenance, sessionID: "ses-owner" },
      proposal: validProposal(),
    })
    fixture.store.atomic((db) => {
      db.query(
        `INSERT INTO runner_nodes
         (plan_id,task_id,spec_revision,ordinal,state,version,reason,artifact,snapshot,machine_version)
         VALUES(?,?,1,2,'queued',1,NULL,NULL,?,'lazers-task/1')`,
      ).run(planID, dependentTaskID, JSON.stringify({ status: "active", value: "queued" }))
      db.query("INSERT INTO runner_dependencies(plan_id,prerequisite,successor) VALUES(?,?,?)").run(
        planID,
        taskID,
        dependentTaskID,
      )
      const effect = (
        id: string,
        attemptID: string,
        kind: string,
        state: string,
        payload: unknown,
      ) =>
        db
          .query(
            `INSERT INTO runner_effects
           (id,plan_id,task_id,attempt_id,kind,state,payload,receipt,fence)
           VALUES(?,?,?,?,?,?,?,NULL,1)`,
          )
          .run(id, planID, taskID, attemptID, kind, state, JSON.stringify(payload))
      effect("effect-session", firstAttemptID, "session", "completed", { sessionID: "ses-failed" })
      effect("effect-prompt-persisted", firstAttemptID, "prompt", "intended", {
        messageID: "msg-first",
      })
      effect("effect-prompt-admitted", secondAttemptID, "prompt", "completed", {
        messageID: "msg-second",
      })
      const transition = (event: string, payload: unknown, at: number) =>
        db
          .query(
            `INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at)
           VALUES(?,?,1,?,?,?)`,
          )
          .run(planID, taskID, event, JSON.stringify(payload), at)
      transition("SESSION_EFFECT_COMPLETED", { effectID: "effect-session" }, 4_100)
      transition(
        "PROMPT_PERSISTED",
        { effectID: "effect-prompt-persisted", messageID: "msg-first" },
        4_200,
      )
      transition(
        "PROMPT_ADMITTED",
        { effectID: "effect-prompt-admitted", messageID: "msg-second" },
        4_300,
      )
      const outbox = [
        ["outbox-persisted", "pending"],
        ["outbox-admitted", "admitted"],
        ["outbox-consumed", "consumed"],
        ["outbox-unknown", "unknown"],
      ] as const
      for (const [index, [id, state]] of outbox.entries()) {
        const messageID = `message-${id}`
        db.query(
          `INSERT INTO runner_outbox
           (id,plan_id,session_id,message_id,payload,state,resume,metadata,receipt)
           VALUES(?,?,?,?,?,?,0,NULL,NULL)`,
        ).run(id, planID, "ses-owner", messageID, "private outbox payload must stay hidden", state)
        transition(`OUTBOX_${state.toUpperCase()}`, { outboxID: id, messageID }, 4_400 + index)
      }
    })
    const host = radarHost([
      radarSession("ses-owner"),
      radarSession("ses-failed", { directory: fixture.directory }),
      radarSession("ses-accepted", { directory: fixture.directory }),
    ])
    const reads = radarReads(fixture, host)
    const tracker = new ObservationChangeTracker(
      fixture.repository,
      new Uint8Array(32).fill(16),
      "project",
    )
    tracker.initialize()
    const result = await reads.radar(
      { scope: { kind: "project", sessionID: "ses-owner" }, includeUnmanagedSessions: false },
      tracker,
      new AbortController().signal,
    )
    const delivery = new Map(
      result.edges
        .filter((edge) => edge.kind === "outcome")
        .map((edge) => [edge.id.slice("outcome:".length), edge.deliveryStage]),
    )
    expect(delivery).toEqual(
      new Map([
        ["outbox-persisted", "persisted"],
        ["outbox-admitted", "admitted"],
        ["outbox-consumed", "consumed"],
        ["outbox-unknown", "unknown"],
      ]),
    )
    expect(result.edges.find((edge) => edge.id === "prompt:effect-prompt-persisted")).toMatchObject(
      { deliveryStage: "persisted", messageID: "msg-first" },
    )
    expect(result.edges.find((edge) => edge.id === "prompt:effect-prompt-admitted")).toMatchObject({
      deliveryStage: "admitted",
      messageID: "msg-second",
    })
    const assignment = result.edges.find((edge) => edge.id === `assignment:${firstAttemptID}`)
    expect(assignment).toMatchObject({ kind: "assignment", observedAt: 4_100 })
    expect(assignment?.evidence).toContainEqual({
      source: "runner-transition",
      sequence: expect.any(Number),
      event: "SESSION_EFFECT_COMPLETED",
      effectID: "effect-session",
      outboxID: null,
      messageID: null,
      at: 4_100,
    })
    expect(
      result.edges
        .filter((edge) => edge.kind === "architecture")
        .every((edge) => edge.live === false && edge.deliveryStage === null),
    ).toBe(true)
    expect(result.edges.find((edge) => edge.kind === "dependency")).toMatchObject({
      from: `task:${taskID}`,
      to: `task:${dependentTaskID}`,
      live: false,
      deliveryStage: null,
      evidence: [{ source: "runner-record", at: null }],
    })
    expect(JSON.stringify(result)).not.toContain("private outbox payload")
  } finally {
    fixture.close()
  }
})

test("deferred Radar responses from an obsolete scope cannot become fresh in the next scope", async () => {
  const fixture = makeFixture()
  try {
    let entered!: () => void
    let resume!: (value: RadarNativeSession | null) => void
    const waitForRead = new Promise<void>((resolve) => (entered = resolve))
    const deferredHost: RadarSessionHost = {
      get: async (id) => {
        if (id === "ses-failed") {
          entered()
          return await new Promise<RadarNativeSession | null>((resolve) => (resume = resolve))
        }
        return radarSession(id)
      },
      project: async () => ({ sessions: [], truncated: false }),
      descendants: async () => ({ sessions: [], truncated: false }),
    }
    const reads = radarReads(fixture, deferredHost)
    const tracker = new ObservationChangeTracker(
      fixture.repository,
      new Uint8Array(32).fill(15),
      "project",
    )
    tracker.initialize()
    const state = new ObservationSyncState()
    const oldScope = { kind: "session" as const, sessionID: "ses-failed" }
    const oldGeneration = state.connect("project", oldScope)
    const deferred = reads.radar(
      { scope: oldScope, includeUnmanagedSessions: false },
      tracker,
      new AbortController().signal,
    )
    await waitForRead
    const nextScope = { kind: "project" as const, sessionID: "ses-owner" }
    const nextGeneration = state.connect("project", nextScope)
    resume(radarSession("ses-failed"))
    const obsolete = await deferred
    expect(state.acceptRadar(oldGeneration, obsolete)).toBe(false)
    expect(state.radar).toBeUndefined()
    expect(state.scope).toEqual(nextScope)
    expect(nextGeneration).toBeGreaterThan(oldGeneration)
  } finally {
    fixture.close()
  }
})

test("Radar retains observation ordering when the host lacks JSONB iteration", async () => {
  const fixture = makeFixture()
  const original = Database.prototype.query
  let fallback: ReturnType<typeof spyOn> | undefined
  try {
    const secret = new Uint8Array(32).fill(28)
    const reads = radarReads(fixture, radarHost([]), secret)
    const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
    tracker.initialize()
    const recorder = new ProgressRecorder(fixture.store, "project")
    recorder.recordNativeEvent({
      id: "evt-jsonb-fallback",
      type: "session.step.started",
      created: 30_100,
      data: {
        sessionID: "ses-failed",
        assistantMessageID: "msg-jsonb-fallback",
        agent: "lazers-implementor",
        model: { providerID: "anthropic", id: "fallback-model" },
        started: 30_000,
      },
    })
    const input = {
      scope: { kind: "session" as const, sessionID: "ses-failed" },
      includeUnmanagedSessions: false,
    }
    const before = await reads.radar(input, tracker, new AbortController().signal)
    fallback = spyOn(Database.prototype, "query").mockImplementation(function (
      this: Database,
      sql: string,
    ) {
      if (sql === "SELECT value FROM jsonb_each('[]')") throw new Error("no such table: jsonb_each")
      return original.call(this, sql)
    } as typeof original)
    const after = await reads.radar(input, tracker, new AbortController().signal)
    expect(after.edges.some((edge) => edge.messageID === "msg-jsonb-fallback")).toBe(true)
    expect(after.edges).toEqual(before.edges)
    expect(after.routes).toEqual(before.routes)
    expect(after.coverage).toEqual(before.coverage)
  } finally {
    fallback?.mockRestore()
    fixture.close()
  }
})
