import { expect, test } from "bun:test"
import { ObservationChangeTracker } from "./changes.ts"
import { ObservationReads } from "./read.ts"
import { SnapshotOutput } from "./contract.ts"
import { makeFixture, taskID, firstAttemptID } from "../../test/trajectory/fixture.ts"
import { AssociationTaskReads } from "./task-reads.ts"
import { ProgressRecorder } from "../progress/recorder.ts"
import type { TrajectoryHost, TrajectorySession } from "../trajectory/native.ts"
import { unavailableTaskValuation } from "../models/task-valuation.ts"

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

test("trajectory projection preserves unique-session effort and refuses out-of-scope attempts", async () => {
  const fixture = makeFixture()
  try {
    const secret = new Uint8Array(32).fill(8)
    let valuationReads = 0
    const reads = new ObservationReads(
      fixture.store,
      fixture.host,
      "project",
      secret,
      async (input) => {
        valuationReads += 1
        return unavailableTaskValuation(input)
      },
    )
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
    expect(valuationReads).toBe(1)
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
    expect(valuationReads).toBe(1)
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

test("associated task reads resolve references for session gets", () => {
  const fixture = makeFixture()
  try {
    const reads = new AssociationTaskReads(fixture.repository)
    fixture.store.updatePlanOwner(fixture.receipt.planID, "ses-owner", "ses-reviewer")
    for (const sessionID of ["ses-owner", "ses-reviewer", "ses-failed", "ses-accepted"]) {
      expect(reads.get({ taskID: "LZ-1", sessionID })).toMatchObject({
        status: "found",
        reference: "LZ-1",
        task: { id: taskID },
      })
    }
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
        const completed = statusReport.trajectory.events.find(
          (event) => event.id === `progress:${runningSequence}`,
        )
        expect(completed).toMatchObject({ status: "succeeded" })
        // Native live observations retain completion metadata, not tool bodies.
        expect(completed?.result).toBeUndefined()
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
    expect(latest.coverage.sessionRead).toContain("native message list was not read")
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
      progress: db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_progress")
        .get()!.count,
    }))
    expect(after).toEqual(before)
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

    // The snapshot reads no plan-level transition, so unrelated volume truncates nothing.
    const broad = reads.snapshot(scope, tracker)
    expect(broad.coverage?.workTruncated).toBe(false)
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

test("session snapshots expose the machine topology and node snapshots, read-only", () => {
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
    // Recorded transitions are the lifecycle view's stream (`radar.planEvents`), not the snapshot's.
    expect("transitions" in snapshot).toBe(false)
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
