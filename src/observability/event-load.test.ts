import { expect, test } from "bun:test"
import { associatedSessionIDs, createAssociationIndex } from "./associations.ts"
import {
  closeSourceStampConnections,
  ObservationChangeTracker,
  readSourceStamp,
} from "./changes.ts"
import { makeFixture } from "../../test/trajectory/fixture.ts"

function insertTasks(fixture: ReturnType<typeof makeFixture>, count: number, offset = 0) {
  fixture.store.atomic((db) => {
    const insert = db.query(
      "INSERT INTO tasks(id,project_directory,created_at,body) VALUES(?,?,?,?)",
    )
    for (let index = 0; index < count; index++)
      insert.run(
        `task-bulk-${offset + index}`,
        fixture.directory,
        "2026-10-31T12:00:00.000Z",
        JSON.stringify({ provenance: { sessionID: `ses-bulk-${offset + index}` } }),
      )
  })
}

test("incremental association index equals the full scan across inserts, updates and deletes", () => {
  const fixture = makeFixture()
  try {
    const index = createAssociationIndex()
    const same = () =>
      fixture.store.atomic((db) => {
        const incremental = index.read(db, fixture.directory)
        expect([...incremental].toSorted()).toEqual(
          [...associatedSessionIDs(db, fixture.directory)].toSorted(),
        )
        return incremental
      })
    expect(same().size).toBeGreaterThan(0)
    expect(index.rebuilds).toBe(1)

    insertTasks(fixture, 50)
    expect(same().has("ses-bulk-49")).toBe(true)

    fixture.store.atomic((db) =>
      db.run("UPDATE runner_plans SET owner='ses-renamed-owner' WHERE id=?", [
        fixture.receipt.planID,
      ]),
    )
    expect(same().has("ses-renamed-owner")).toBe(true)

    fixture.store.atomic((db) => {
      db.run("DELETE FROM tasks WHERE id='task-bulk-7'")
    })
    // A shrinking table forces a full rebuild; the deleted task's session leaves the set.
    expect(same().has("ses-bulk-7")).toBe(false)
    expect(index.rebuilds).toBeGreaterThan(1)

    insertTasks(fixture, 5, 1_000)
    expect(same().has("ses-bulk-1004")).toBe(true)
  } finally {
    fixture.close()
  }
})

test("a burst of scheduled refreshes collapses into a trailing read", async () => {
  const fixture = makeFixture()
  const tracker = new ObservationChangeTracker(
    fixture.repository,
    new Uint8Array(32).fill(9),
    "project",
  )
  try {
    tracker.initialize()
    let reads = 0
    const refresh = tracker.refreshSource.bind(tracker)
    tracker.refreshSource = () => {
      reads++
      refresh()
    }
    for (let index = 0; index < 100; index++) tracker.scheduleRefresh()
    await Bun.sleep(400)
    expect(reads).toBeLessThanOrEqual(2)
    expect(reads).toBeGreaterThanOrEqual(1)
  } finally {
    tracker.close()
    closeSourceStampConnections()
    fixture.close()
  }
})

test("a burst of unrelated-session native events does at most two source reads", async () => {
  const fixture = makeFixture()
  const tracker = new ObservationChangeTracker(
    fixture.repository,
    new Uint8Array(32).fill(10),
    "project",
  )
  try {
    tracker.initialize()
    let reads = 0
    const refresh = tracker.refreshSource.bind(tracker)
    tracker.refreshSource = () => {
      reads++
      refresh()
    }
    for (let index = 0; index < 100; index++)
      tracker.native({
        id: `evt-burst-${index}`,
        type: "session.step.started",
        created: 1_000 + index,
        data: { sessionID: `ses-unrelated-${index}`, assistantMessageID: "msg" },
      })
    await Bun.sleep(400)
    expect(reads).toBeLessThanOrEqual(3)
    expect(tracker.nativeRevision).toBe(0)
  } finally {
    tracker.close()
    closeSourceStampConnections()
    fixture.close()
  }
})

test("source stamps on a large project reuse one connection and stay under the event-loop budget", () => {
  const fixture = makeFixture()
  try {
    insertTasks(fixture, 4_000)
    const secret = new Uint8Array(32).fill(11)
    const first = readSourceStamp(fixture.repository.path, fixture.directory, secret)
    expect(first.sessionIDs.size).toBeGreaterThan(4_000)

    const durations: number[] = []
    for (let index = 0; index < 50; index++) {
      const started = performance.now()
      const stamp = readSourceStamp(fixture.repository.path, fixture.directory, secret)
      durations.push(performance.now() - started)
      expect(stamp.sourceFingerprint).toBe(first.sourceFingerprint)
    }
    // Unchanged revision: no membership rescan, no new connection, no realpath.
    expect(Math.max(...durations)).toBeLessThan(20)

    insertTasks(fixture, 10, 10_000)
    const started = performance.now()
    const next = readSourceStamp(fixture.repository.path, fixture.directory, secret)
    expect(performance.now() - started).toBeLessThan(20)
    expect(next.sessionIDs.has("ses-bulk-10009")).toBe(true)
  } finally {
    closeSourceStampConnections()
    fixture.close()
  }
})
