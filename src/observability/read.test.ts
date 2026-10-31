import { expect, test } from "bun:test"
import { ObservationChangeTracker } from "./changes.ts"
import { ObservationReads } from "./read.ts"
import { makeFixture, taskID, firstAttemptID } from "../../test/trajectory/fixture.ts"

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
