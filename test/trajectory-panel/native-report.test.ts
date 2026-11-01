import { expect, test } from "bun:test"
import { ObservationChangeTracker } from "../../src/observability/changes.ts"
import { ObservationReads } from "../../src/observability/read.ts"
import { ProgressRecorder } from "../../src/progress/recorder.ts"
import { eventPayload, parseTrajectoryReport } from "../../src/trajectory-panel/projection.ts"
import { firstAttemptID, makeFixture, taskID } from "../trajectory/fixture.ts"

test("captured and live reports render native execution outcomes with an unknown basis", async () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
    )
    const recorder = new ProgressRecorder(fixture.store, "project")
    const sequence = recorder.recordNativeEvent({
      id: "evt_native-execution-failed",
      type: "session.execution.failed",
      created: 3000,
      data: { sessionID: "ses-failed" },
    })
    expect(sequence).toEqual(expect.any(Number))
    const secret = new Uint8Array(32).fill(6)
    const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
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
      secret,
    )
    const scope = { kind: "project" as const, sessionID: "ses-owner" }
    const captured = await reads.trajectoryHistory({ scope, taskID, limit: 50 }, tracker)
    const live = await reads.trajectoryStatus({ scope, taskID }, tracker)
    for (const response of [captured, live]) {
      const report = parseTrajectoryReport(response)
      const event = report.trajectory.events.find((item) => item.id === `progress:${sequence}`)
      expect(event).toMatchObject({
        kind: "worker-execution-outcome",
        source: "native-event",
        outcome: "failed",
        basis: null,
      })
      expect(eventPayload(event!).basis).toBeNull()
    }

    const invalid = structuredClone(captured)
    const events = (invalid.report.trajectory as { events: Array<Record<string, unknown>> }).events
    events.find((item) => item.id === `progress:${sequence}`)!.basis = { unsupported: true }
    expect(() => parseTrajectoryReport(invalid)).toThrow("unsupported shape")
  } finally {
    fixture.close()
  }
})
