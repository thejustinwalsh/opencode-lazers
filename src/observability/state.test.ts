import { expect, test } from "bun:test"
import { makeFixture } from "../../test/trajectory/fixture.ts"
import { operationalReads } from "../../test/radar/operational.ts"
import { ObservationChangeTracker } from "./changes.ts"
import { ObservationSyncState } from "./state.ts"

test("Radar and lifecycle observations advance independently while live events keep a shared high-water mark", async () => {
  const fixture = makeFixture()
  try {
    const secret = new Uint8Array(32).fill(5)
    const reads = operationalReads(fixture, "project", secret)
    const tracker = new ObservationChangeTracker(fixture.repository, secret, "project")
    tracker.initialize()
    const scope = { kind: "session" as const, sessionID: "ses-failed" }
    const [snapshot, radar] = await Promise.all([
      reads.snapshot(scope, tracker),
      reads.radar(
        { scope, includeUnmanagedSessions: false },
        tracker,
        new AbortController().signal,
      ),
    ])
    const state = new ObservationSyncState()
    const generation = state.connect("project", scope)
    const base = radar.boundary.eventSequence
    const laterRadar = { ...radar, boundary: { ...radar.boundary, eventSequence: base + 2 } }
    const earlierSnapshot = {
      ...snapshot,
      boundary: { ...snapshot.boundary, eventSequence: base + 1 },
    }

    expect(state.acceptRadar(generation, laterRadar)).toBe(true)
    expect(state.acceptSnapshot(generation, earlierSnapshot)).toBe(true)
    expect(state.radar?.boundary.eventSequence).toBe(base + 2)
    expect(state.snapshot?.boundary.eventSequence).toBe(base + 1)
    expect(state.eventSequence).toBe(base + 2)

    expect(
      state.acceptRadar(generation, {
        ...radar,
        boundary: { ...radar.boundary, eventSequence: base + 1 },
      }),
    ).toBe(false)
    expect(state.radar?.boundary.eventSequence).toBe(base + 2)

    const nextSnapshot = {
      ...snapshot,
      boundary: { ...snapshot.boundary, eventSequence: base + 3 },
    }
    expect(state.acceptSnapshot(generation, nextSnapshot)).toBe(true)
    expect(state.eventSequence).toBe(base + 3)
    expect(
      state.acceptChange(generation, "project", {
        projectID: "project",
        sequence: base + 4,
        repositoryVersion: radar.boundary.repositoryVersion,
        sourceRevision: radar.boundary.sourceRevision,
        nativeRevision: radar.boundary.nativeRevision,
        cause: "runner",
        resnapshotRequired: false,
      }),
    ).toBe(true)
    expect(state.eventSequence).toBe(base + 4)
  } finally {
    fixture.close()
  }
})
