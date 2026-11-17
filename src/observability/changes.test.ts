import { expect, test } from "bun:test"
import {
  LIVE_SIGNAL_LIMITS,
  ObservationChangeTracker,
  readSourceStamp,
  sourceStampFromDatabase,
} from "./changes.ts"
import type { ObservationChange } from "./contract.ts"
import { makeFixture, firstAttemptID } from "../../test/trajectory/fixture.ts"
import { ProgressRecorder } from "../progress/recorder.ts"

test("loaded observers share membership reads for the same durable revision and rescan only deltas", async () => {
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
    expect(distinctSecret.sourceFingerprint).toBe(initial.sourceFingerprint)
    initial.sessionIDs.clear()
    expect(read().sessionIDs.size).toBeGreaterThan(0)
    f.store.atomic((db) =>
      db.query("UPDATE runner_plans SET owner=? WHERE id=?").run("ses-new-owner", f.receipt.planID),
    )
    expect(read().sessionIDs.has("ses-new-owner")).toBe(true)
    // Plan owners are re-read; unchanged task rows are not rescanned.
    expect(membershipReads).toBe(1)
    expect(read(secret, "/unrelated-project").sessionIDs.size).toBe(0)
    expect(membershipReads).toBe(1)
    await Promise.resolve()
    // The shared view is keyed by revision, so it survives the microtask boundary.
    expect(read().sessionIDs.has("ses-new-owner")).toBe(true)
    expect(membershipReads).toBe(1)
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

test("bounded native signals retain only allowlisted metadata for selected sessions", () => {
  const fixture = makeFixture()
  try {
    const tracker = new ObservationChangeTracker(
      fixture.repository,
      new Uint8Array(32).fill(61),
      "project",
    )
    tracker.initialize()
    tracker.trackScopedSessions(["ses-architect", "ses-other"], "ses-architect")
    const selected = new Set(["ses-architect"])
    tracker.native({
      id: "evt-architect-step",
      type: "session.step.started",
      created: 42_001,
      durable: { aggregateID: "ses-architect", seq: 1, version: 2 },
      data: {
        sessionID: "ses-architect",
        assistantMessageID: "msg_architect_turn",
        agent: "architect",
        model: { providerID: "openai", id: "gpt-6-luna", variant: "high" },
        started: 42_000,
        text: "PRIVATE MESSAGE DECOY",
        content: "MODEL CONTENT DECOY",
        input: { token: "PRIVATE INPUT TOKEN DECOY" },
        credentials: "PRIVATE CREDENTIAL DECOY",
      },
    })
    tracker.native({
      id: "evt-architect-tool",
      type: "session.tool.input.started",
      created: 42_002,
      durable: { aggregateID: "ses-architect", seq: 2, version: 2 },
      data: {
        sessionID: "ses-architect",
        assistantMessageID: "msg_architect_turn",
        id: "call_architect_list",
        name: "List",
        input: { directory: "PRIVATE ARGUMENT DECOY" },
        content: "PRIVATE TOOL CONTENT DECOY",
      },
    })

    const snapshot = tracker.peekLiveSignals(selected)
    expect(snapshot.truncated).toBe(false)
    expect(snapshot.signals).toEqual([
      {
        sessionID: "ses-architect",
        eventID: "evt-architect-step",
        eventType: "session.step.started",
        sourceNativeRevision: 1,
        messageID: "msg_architect_turn",
        callID: null,
        tool: null,
        agent: "architect",
        providerID: "openai",
        modelID: "gpt-6-luna",
        variant: "high",
        status: "request-started",
        observedAt: 42_001,
      },
      {
        sessionID: "ses-architect",
        eventID: "evt-architect-tool",
        eventType: "session.tool.input.started",
        sourceNativeRevision: 2,
        messageID: "msg_architect_turn",
        callID: "call_architect_list",
        tool: "List",
        agent: null,
        providerID: null,
        modelID: null,
        variant: null,
        status: "input-started",
        observedAt: 42_002,
      },
    ])
    expect(tracker.peekLiveSignals(new Set(["ses-other"])).signals).toEqual([])
    const retained = JSON.stringify(snapshot)
    for (const decoy of [
      "PRIVATE MESSAGE DECOY",
      "MODEL CONTENT DECOY",
      "PRIVATE INPUT TOKEN DECOY",
      "PRIVATE CREDENTIAL DECOY",
      "PRIVATE ARGUMENT DECOY",
      "PRIVATE TOOL CONTENT DECOY",
    ])
      expect(retained).not.toContain(decoy)

    const sequence = tracker.sequence
    tracker.native({
      id: "evt-architect-late",
      type: "session.tool.success",
      created: 42_003,
      durable: { aggregateID: "ses-architect", seq: 1, version: 2 },
      data: {
        sessionID: "ses-architect",
        assistantMessageID: "msg_architect_turn",
        id: "call_architect_list",
        content: [{ type: "text", text: "PRIVATE TERMINAL BODY DECOY" }],
      },
    })
    expect(tracker.sequence).toBe(sequence)
    expect(tracker.peekLiveSignals(selected).signals).toHaveLength(2)
    expect(tracker.peekLiveSignals(selected).signals).toHaveLength(2)
    tracker.streamGap()
    expect(tracker.peekLiveSignals(selected)).toEqual({ signals: [], truncated: false })
  } finally {
    fixture.close()
  }
})

test("pending native signals drain only after exact scope selection and overflow stays bounded", () => {
  const fixture = makeFixture()
  try {
    const tracker = new ObservationChangeTracker(
      fixture.repository,
      new Uint8Array(32).fill(62),
      "project",
    )
    tracker.initialize()
    const finishSelection = tracker.beginScopeSelection()
    tracker.native({
      id: "evt-buffered-architect",
      type: "session.text.ended",
      created: 43_001,
      data: {
        sessionID: "ses-architect-buffered",
        assistantMessageID: "msg_buffered_turn",
        text: "NEVER RETAIN PRIVATE MESSAGE TEXT",
      },
    })
    expect(tracker.peekLiveSignals(new Set(["ses-architect-buffered"])).signals).toEqual([])
    tracker.trackScopedSessions(["ses-architect-buffered"], "ses-architect-buffered")
    finishSelection()
    expect(tracker.peekLiveSignals(new Set(["ses-architect-buffered"])).signals).toMatchObject([
      {
        eventID: "evt-buffered-architect",
        eventType: "session.text.ended",
        messageID: "msg_buffered_turn",
        status: "text-ended",
      },
    ])

    for (let index = 0; index < 270; index++)
      tracker.native({
        id: `evt-bounded-${index}`,
        type: "session.execution.started",
        created: 44_000 + index,
        data: { sessionID: "ses-architect-buffered" },
      })
    const bounded = tracker.peekLiveSignals(new Set(["ses-architect-buffered"]))
    expect(bounded.signals).toHaveLength(256)
    expect(bounded.truncated).toBe(true)
    expect(bounded.signals.at(-1)?.eventID).toBe("evt-bounded-269")

    tracker.streamGap()
    for (let index = 0; index < 256; index++)
      tracker.native({
        id: `evt-byte-cap-${index}-${"x".repeat(180)}`,
        type: "session.step.started",
        created: 45_000 + index,
        durable: { aggregateID: "ses-architect-buffered", seq: index + 1, version: 2 },
        data: {
          sessionID: "ses-architect-buffered",
          assistantMessageID: `msg-${"m".repeat(180)}`,
          agent: "a".repeat(180),
          model: {
            providerID: "p".repeat(180),
            id: "m".repeat(280),
            variant: "v".repeat(180),
          },
        },
      })
    const byteBounded = tracker.peekLiveSignals(new Set(["ses-architect-buffered"]))
    expect(byteBounded.signals.length).toBeLessThan(256)
    expect(byteBounded.truncated).toBe(true)
  } finally {
    fixture.close()
  }
})

test("native signal truncation is session-scoped until bounded omission markers overflow", () => {
  const fixture = makeFixture()
  try {
    const tracker = new ObservationChangeTracker(
      fixture.repository,
      new Uint8Array(32).fill(66),
      "project",
    )
    tracker.initialize()
    tracker.trackScopedSessions(["ses-anchor", "ses-busy"], "ses-anchor")

    for (let index = 0; index < 270; index++)
      tracker.native({
        id: `evt-busy-${index}`,
        type: "session.execution.started",
        created: 46_000 + index,
        data: { sessionID: "ses-busy" },
      })

    expect(tracker.peekLiveSignals(new Set(["ses-anchor"]))).toEqual({
      signals: [],
      truncated: false,
    })
    const busy = tracker.peekLiveSignals(new Set(["ses-busy"]))
    expect(busy.truncated).toBe(true)
    expect(busy.signals).toHaveLength(LIVE_SIGNAL_LIMITS.flowEntries)
    expect(busy.signals[0]).toMatchObject({
      sessionID: "ses-busy",
      eventID: "evt-busy-14",
    })

    tracker.streamGap()
    for (let index = 0; index < LIVE_SIGNAL_LIMITS.truncatedSessions + 257; index++) {
      const sessionID = `ses-cap-${index}`
      tracker.trackScopedSessions([sessionID], sessionID)
      tracker.native({
        id: `evt-cap-${index}`,
        type: "session.execution.started",
        created: 47_000 + index,
        data: { sessionID },
      })
    }
    expect(tracker.peekLiveSignals(new Set(["ses-cap-0"])).truncated).toBe(true)
    tracker.streamGap()
    expect(tracker.peekLiveSignals(new Set(["ses-cap-0"]))).toEqual({
      signals: [],
      truncated: false,
    })
  } finally {
    fixture.close()
  }
})

test("loaded project registrations with distinct secrets share stamps and private reader queues", async () => {
  const fixture = makeFixture()
  const trackers: InstanceType<typeof ObservationChangeTracker>[] = []
  const deliveries: ObservationChange[][] = []
  try {
    const copies = await Promise.all(
      Array.from(
        { length: 13 },
        (_, index) =>
          import(
            new URL(`./changes.ts?location=${index}-${crypto.randomUUID()}`, import.meta.url).href
          ),
      ),
    )
    const constructors = [
      ObservationChangeTracker,
      ...copies.map((copy) => copy.ObservationChangeTracker),
    ]
    const secrets = constructors.map((_, index) => new Uint8Array(32).fill(index + 20))
    for (let index = 0; index < constructors.length; index++) {
      const Tracker = constructors[index]!
      const tracker = new Tracker(fixture.repository, secrets[index]!, "project")
      trackers.push(tracker)
      deliveries.push([])
      tracker.initialize((change: ObservationChange) => deliveries[index]!.push(change))
    }
    const fingerprints = [
      readSourceStamp(fixture.repository.path, fixture.directory, secrets[0]!).sourceFingerprint,
      ...copies.map(
        (copy, index) =>
          copy.readSourceStamp(fixture.repository.path, fixture.directory, secrets[index + 1]!)
            .sourceFingerprint,
      ),
    ]
    expect(new Set(fingerprints).size).toBe(1)
    for (const tracker of trackers) tracker.refreshSource()
    expect(trackers.map((tracker) => tracker.sequence)).toEqual(Array(14).fill(0))
    expect(deliveries.flat()).toEqual([])

    trackers[1]!.trackScopedSessions(["ses-unmanaged-selected"])

    const selectedEvent = {
      id: "event-unmanaged-selected",
      type: "session.tool.progress",
      durable: { aggregateID: "ses-unmanaged-selected", seq: 7 },
      data: { sessionID: "ses-unmanaged-selected" },
    }
    for (const tracker of trackers) tracker.native(selectedEvent)

    expect(deliveries.flat()).toMatchObject([{ sequence: 1, cause: "native" }])
    expect(trackers[0]!.peekLiveEvents(new Set(["ses-unmanaged-selected"]))).toEqual(new Set())
    expect(trackers[1]!.peekLiveEvents(new Set(["ses-unmanaged-selected"]))).toEqual(
      new Set(["event-unmanaged-selected"]),
    )
    trackers[0]!.takeLiveEvents(new Set(["ses-unmanaged-selected"]))
    expect(trackers[1]!.takeLiveEvents(new Set(["ses-unmanaged-selected"]))).toEqual(
      new Set(["event-unmanaged-selected"]),
    )

    const distinctObservation = {
      id: "event-managed-same-sequence",
      type: "session.tool.success",
      durable: { aggregateID: "ses-failed", seq: 7 },
      data: { sessionID: "ses-failed" },
    }
    for (const tracker of trackers) tracker.native(distinctObservation)
    expect(deliveries.flat()).toMatchObject([
      { sequence: 1, cause: "native" },
      { sequence: 2, cause: "native" },
    ])
    expect(deliveries.flat()).toHaveLength(2)

    trackers[0]!.close()
    expect(deliveries[1]).toMatchObject([{ sequence: 3, cause: "gap", resnapshotRequired: true }])
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET tool_count=tool_count+1 WHERE id=?").run(firstAttemptID),
    )
    trackers[1]!.refreshSource()
    expect(deliveries[1]!.at(-1)).toMatchObject({ sequence: 4, cause: "runner" })
  } finally {
    for (const tracker of trackers) tracker.close()
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
