import { expect, test } from "bun:test"
import { ObservationChangeTracker } from "../../src/observability/changes.ts"
import { ObservationReads } from "../../src/observability/read.ts"
import { ProgressRecorder } from "../../src/progress/recorder.ts"
import { parseTrajectoryReport } from "../../src/trajectory-panel/projection.ts"
import { makeFixture, taskID, cursorSecret } from "../trajectory/fixture.ts"

test("native status deltas preserve mutable tool progress, retry delivery and scoped full recovery", async () => {
  const f = makeFixture()
  try {
    const tracker = new ObservationChangeTracker(f.repository, cursorSecret, "project")
    tracker.initialize()
    const host = {
      session: (id: string) => f.host.session(id),
      status: async (id: string) => {
        const session = await f.host.session(id)
        return session && { ...session, messages: null, messageStatus: "not-read" as const }
      },
    }
    const reads = new ObservationReads(f.store, host, "project", cursorSecret)
    const scope = { kind: "project" as const, sessionID: "ses-owner" }
    const legacy = await reads.trajectoryStatus({ scope, taskID }, tracker)
    const initial = await reads.trajectoryStatus({ scope, taskID, live: {} }, tracker)
    expect(initial.live?.mode).toBe("reset")
    expect(initial.report).toEqual(legacy.report)
    const cursor = initial.live!.cursor!
    const unchanged = await reads.trajectoryStatus({ scope, taskID, live: { cursor } }, tracker)
    expect(parseTrajectoryReport(unchanged).trajectory.events).toEqual([])
    expect(unchanged.live?.mode).toBe("patch")

    const recorder = new ProgressRecorder(f.store, "project")
    const record = (type: "session.tool.called" | "session.tool.success", id: string) =>
      recorder.recordNativeEvent({
        id,
        type,
        created: 3000,
        data: {
          sessionID: "ses-failed",
          assistantMessageID: "msg-delta",
          id: "same-call",
          executed: true,
          ...(type === "session.tool.success"
            ? { content: [{ type: "text", text: "passed" }] }
            : {}),
        },
      })
    const sequence = record("session.tool.called", "delta-running")
    const running = await reads.trajectoryStatus({ scope, taskID, live: { cursor } }, tracker)
    const progressID = `progress:${sequence}`
    expect(parseTrajectoryReport(running).trajectory.events).toContainEqual(
      expect.objectContaining({ id: progressID, status: "running" }),
    )
    record("session.tool.success", "delta-done")
    const completed = await reads.trajectoryStatus(
      { scope, taskID, live: { cursor: running.live!.cursor! } },
      tracker,
    )
    expect(parseTrajectoryReport(completed).trajectory.events).toContainEqual(
      expect.objectContaining({ id: progressID, status: "succeeded", result: "passed" }),
    )
    // Ignore the last response and retry the original baseline.
    const retry = await reads.trajectoryStatus({ scope, taskID, live: { cursor } }, tracker)
    expect(parseTrajectoryReport(retry).trajectory.events).toContainEqual(
      expect.objectContaining({ id: progressID, status: "succeeded" }),
    )
    const restarted = new ObservationReads(f.store, host, "project", cursorSecret)
    const reset = await restarted.trajectoryStatus(
      { scope, taskID, live: { cursor: completed.live!.cursor! } },
      tracker,
    )
    expect(reset.live?.mode).toBe("reset")
    const full = await reads.trajectoryStatus({ scope, taskID }, tracker)
    expect(reset.report).toEqual(full.report)
    const smaller = await restarted.trajectoryStatus(
      { scope, taskID, live: { cursor: reset.live!.cursor! } },
      tracker,
    )
    expect(JSON.stringify(smaller).length).toBeLessThan(JSON.stringify(reset).length)
    await expect(
      reads.trajectoryStatus(
        {
          scope: { kind: "session", sessionID: "unassociated" },
          taskID,
          live: { cursor },
        },
        tracker,
      ),
    ).rejects.toThrow("No observation in this scope")
    f.store.atomic((db) =>
      db
        .query(
          `INSERT INTO tasks(id,project_directory,created_at,body)
        SELECT ?,project_directory,created_at,'{invalid' FROM tasks WHERE id=?`,
        )
        .run("aa53fd1c-85cc-4d67-932d-b8b69a197d8b", taskID),
    )
    for (const view of [scope, { kind: "session" as const, sessionID: "ses-owner" }]) {
      expect(
        parseTrajectoryReport(
          await reads.trajectoryStatus({ scope: view, taskID, live: {} }, tracker),
        ).task.id,
      ).toBe(taskID)
      expect(
        parseTrajectoryReport(
          await reads.trajectoryHistory({ scope: view, taskID, limit: 20 }, tracker),
        ).task.id,
      ).toBe(taskID)
    }
    await expect(
      reads.trajectoryStatus({ scope, taskID: "aa53fd1c-85cc-4d67-932d-b8b69a197d8b" }, tracker),
    ).rejects.toThrow()
    expect(() => reads.snapshot(scope, tracker)).toThrow()
  } finally {
    f.close()
  }
})
