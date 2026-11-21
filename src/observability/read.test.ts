import { expect, test } from "bun:test"
import { ObservationChangeTracker } from "./changes.ts"
import { ObservationReads } from "./read.ts"
import { SnapshotOutput } from "./contract.ts"
import { makeFixture, taskID, firstAttemptID } from "../../test/trajectory/fixture.ts"
import { getTaskDetail } from "../tasks/stream-query.ts"
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

test("associated task reads resolve references for session gets", async () => {
  const fixture = makeFixture()
  try {
    fixture.store.updatePlanOwner(fixture.receipt.planID, "ses-owner", "ses-reviewer")
    for (const sessionID of ["ses-owner", "ses-reviewer", "ses-failed", "ses-accepted"]) {
      expect(
        await getTaskDetail(fixture.repository, { taskID: "LZ-1", session: sessionID }),
      ).toMatchObject({
        status: "found",
        reference: "LZ-1",
        task: { id: taskID },
      })
    }
    expect(
      await getTaskDetail(fixture.repository, { taskID: "LZ-1", session: "ses-unrelated" }),
    ).toEqual({
      status: "not_found",
    })
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
