import { expect, test } from "bun:test"
import { ObservationChangeTracker, sourceStampFromDatabase } from "./changes.ts"
import { makeFixture, firstAttemptID } from "../../test/trajectory/fixture.ts"
import { ProgressRecorder } from "../progress/recorder.ts"

test("loaded observers share membership reads only within the same durable revision and synchronous batch", async () => {
  const f = makeFixture()
  try {
    const copy = await import(
      new URL(`./changes.ts?copy=${crypto.randomUUID()}`, import.meta.url).href
    )
    let membershipReads = 0
    const secret = new Uint8Array(32).fill(3)
    const otherSecret = new Uint8Array(32).fill(4)
    const read = (key = secret, directory = f.directory) =>
      f.store.atomic((db) => {
        const observed = new Proxy(db, {
          get(target, property) {
            if (property === "query")
              return (sql: string) => {
                if (sql.includes("$.provenance.sessionID")) membershipReads++
                return target.query(sql)
              }
            return Reflect.get(target, property, target)
          },
        })
        return sourceStampFromDatabase(observed, directory, key)
      })
    const initial = read()
    expect(membershipReads).toBe(1)
    for (let index = 0; index < 14; index++) expect(read().sessionIDs).toEqual(initial.sessionIDs)
    f.store.atomic((db) => {
      expect(copy.sourceStampFromDatabase(db, f.directory, secret).sessionIDs).toEqual(
        initial.sessionIDs,
      )
    })
    expect(membershipReads).toBe(1)
    const distinctSecret = read(otherSecret)
    expect(distinctSecret.sourceFingerprint).not.toBe(initial.sourceFingerprint)
    initial.sessionIDs.clear()
    expect(read().sessionIDs.size).toBeGreaterThan(0)
    f.store.atomic((db) =>
      db.query("UPDATE runner_plans SET owner=? WHERE id=?").run("ses-new-owner", f.receipt.planID),
    )
    expect(read().sessionIDs.has("ses-new-owner")).toBe(true)
    expect(membershipReads).toBe(2)
    expect(read(secret, "/unrelated-project").sessionIDs.size).toBe(0)
    expect(membershipReads).toBe(3)
    await Promise.resolve()
    expect(read().sessionIDs.has("ses-new-owner")).toBe(true)
    expect(membershipReads).toBe(4)
  } finally {
    f.close()
  }
})

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

test("progress, continuation, and outbox inserts and updates change Radar source fingerprints", () => {
  const fixture = makeFixture()
  try {
    const tracker = new ObservationChangeTracker(
      fixture.repository,
      new Uint8Array(32).fill(31),
      "project",
    )
    tracker.initialize()
    const recorder = new ProgressRecorder(fixture.store, "project")
    const stepStart = {
      id: "evt-fingerprint-step-start",
      type: "session.step.started",
      created: 10_000,
      data: {
        sessionID: "ses-failed",
        assistantMessageID: "msg-fingerprint",
        agent: "lazers-implementor",
        model: { providerID: "openai", id: "gpt-6-luna" },
        started: 9_999,
      },
    }
    const assertChanged = (previous: number) => {
      tracker.refreshSource()
      expect(tracker.sourceRevision).toBe(previous + 1)
      return tracker.sourceRevision
    }

    let revision = tracker.sourceRevision
    recorder.recordNativeEvent(stepStart)
    revision = assertChanged(revision)
    recorder.recordNativeEvent(stepStart)
    tracker.refreshSource()
    expect(tracker.sourceRevision).toBe(revision)
    recorder.recordNativeEvent({
      id: "evt-fingerprint-step-end",
      type: "session.step.ended",
      created: 10_100,
      data: { sessionID: "ses-failed", assistantMessageID: "msg-fingerprint" },
    })
    revision = assertChanged(revision)

    fixture.store.atomic((db) =>
      db
        .query(
          `INSERT INTO runner_continuations(plan_id,session_id,parent_id,directory,model,generation)
         VALUES(?,?,?,?,?,?)`,
        )
        .run(
          fixture.receipt.planID,
          "ses-continuation",
          "ses-owner",
          fixture.directory,
          JSON.stringify({ providerID: "openai", id: "gpt-6-luna" }),
          1,
        ),
    )
    revision = assertChanged(revision)
    fixture.store.atomic((db) =>
      db
        .query("UPDATE runner_continuations SET generation=generation+1 WHERE plan_id=?")
        .run(fixture.receipt.planID),
    )
    revision = assertChanged(revision)

    fixture.store.atomic((db) =>
      db
        .query(
          `INSERT INTO runner_outbox
         (id,plan_id,session_id,message_id,payload,state,resume,metadata,receipt)
         VALUES(?,?,?,?,?,'pending',0,NULL,NULL)`,
        )
        .run(
          "outbox-fingerprint",
          fixture.receipt.planID,
          "ses-owner",
          "msg-outbox-fingerprint",
          "private payload",
        ),
    )
    revision = assertChanged(revision)
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_outbox SET state='admitted' WHERE id=?").run("outbox-fingerprint"),
    )
    assertChanged(revision)
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
