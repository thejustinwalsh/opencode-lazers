import { expect, test } from "bun:test"
import { ObservationChangeTracker } from "../../src/observability/changes.ts"
import { ObservationReads } from "../../src/observability/read.ts"
import { currentTaskState, parseTrajectoryReport } from "../../src/trajectory-panel/projection.ts"
import { taskStatePresentation } from "../../src/trajectory-panel/state-presentation.ts"
import { cursorSecret, makeFixture, taskID } from "../trajectory/fixture.ts"

test("the head shows the node's current recorded state, not the proposal's own status", async () => {
  const fixture = makeFixture()
  try {
    const tracker = new ObservationChangeTracker(fixture.repository, cursorSecret, "project")
    tracker.initialize()
    const reads = new ObservationReads(
      fixture.store,
      {
        session: (id) => fixture.host.session(id),
        status: async (id) => {
          const session = fixture.sessions.get(id)
          return session
            ? { ...session, messages: null, messageStatus: "not-read", messageError: null }
            : null
        },
      },
      "project",
      cursorSecret,
    )
    const scope = { kind: "project" as const, sessionID: "ses-owner" }
    const response = await reads.trajectoryHistory({ scope, taskID, limit: 50 }, tracker)
    const report = parseTrajectoryReport(response)
    // The proposal-level status stays where it was submitted; the node was accepted.
    expect(report.task.status).toBe("submitted")
    expect(report.task.recordedState).toBe("accepted")
    expect(currentTaskState(report)).toBe("accepted")
    const state = taskStatePresentation(currentTaskState(report))
    expect([state.label, state.tone, state.glyph]).toEqual(["Accepted", "accepted", "ring-check"])
    // What the old head showed.
    expect(taskStatePresentation(report.task.status).label).toBe("Proposed")

    // An older server omits the field: the proposal status is all there is.
    const older = { task: { ...report.task, recordedState: undefined } }
    expect(currentTaskState(older as never)).toBe("submitted")

    // The live status read carries the same field.
    const status = parseTrajectoryReport(await reads.trajectoryStatus({ scope, taskID }, tracker))
    expect(status.task.recordedState).toBe("accepted")
  } finally {
    fixture.close()
  }
})
