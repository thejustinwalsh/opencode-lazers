import { expect, test } from "bun:test"
import { ObservationChangeTracker } from "./changes.ts"
import { makeFixture, firstAttemptID } from "../../test/trajectory/fixture.ts"

test("filtered native sequences deduplicate without inventing gaps; disconnect requires resnapshot", () => {
  const fixture = makeFixture()
  try {
    const tracker = new ObservationChangeTracker(
      fixture.repository,
      new Uint8Array(32).fill(3),
      "project",
    )
    const changes: unknown[] = []
    tracker.initialize((change) => changes.push(change))
    const tool = {
      id: "event-1",
      type: "session.tool.success",
      durable: { aggregateID: "ses-failed", seq: 7, version: 2 },
      data: { sessionID: "ses-failed", id: "tool-1" },
    }
    tracker.native(tool)
    tracker.native(tool)
    tracker.native({ ...tool, id: "event-late", durable: { ...tool.durable, seq: 6 } })
    tracker.native({
      id: "event-gap",
      type: "session.tool.success",
      durable: { aggregateID: "ses-failed", seq: 9, version: 2 },
      data: { sessionID: "ses-failed", id: "tool-2" },
    })
    tracker.native({
      id: "event-usage",
      type: "session.usage.updated",
      data: { sessionID: "ses-failed", cost: 0, tokens: {} },
    })

    expect(changes).toHaveLength(3)
    expect(changes).toMatchObject([
      { cause: "native", resnapshotRequired: false, nativeRevision: 1 },
      { cause: "native", resnapshotRequired: false, nativeRevision: 2 },
      { cause: "native", resnapshotRequired: false, nativeRevision: 3 },
    ])
    expect(JSON.stringify(changes)).not.toContain("tokens")
    tracker.streamGap()
    expect(changes.at(-1)).toMatchObject({
      cause: "gap",
      resnapshotRequired: true,
      nativeRevision: 4,
    })
  } finally {
    fixture.close()
  }
})

test("runner tool-count changes invalidate even when the repository watermark is unchanged", () => {
  const fixture = makeFixture()
  try {
    const tracker = new ObservationChangeTracker(
      fixture.repository,
      new Uint8Array(32).fill(2),
      "project",
    )
    const changes: unknown[] = []
    tracker.initialize((change) => changes.push(change))
    const repositoryVersion = fixture.repository.version()
    fixture.store.atomic((db) => {
      db.query("UPDATE runner_attempts SET tool_count=tool_count+1 WHERE id=?").run(firstAttemptID)
    })
    expect(fixture.repository.version()).toBe(repositoryVersion)
    tracker.refreshSource()
    expect(changes).toMatchObject([
      {
        cause: "runner",
        resnapshotRequired: false,
        repositoryVersion,
        sourceRevision: 1,
      },
    ])
  } finally {
    fixture.close()
  }
})
