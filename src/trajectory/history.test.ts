import { expect, test } from "bun:test"
import type { ObservationScope } from "../observability/contract.ts"
import { TrajectoryHistoryCache } from "./history.ts"

const secret = new Uint8Array(32).fill(6)
const scope: ObservationScope = { kind: "project", sessionID: "ses-owner" }
const identity = {
  projectID: "project",
  projectDirectory: "/workspace/project",
  scope,
  taskID: "bb53fd1c-85cc-4d67-932d-b8b69a197d8b",
  limit: 2,
}
const boundary = {
  repositoryVersion: 1,
  sourceRevision: 2,
  sourceFingerprint: "a".repeat(64),
  nativeRevision: 3,
  eventSequence: 4,
  transitionSequence: 5,
}

function report(count = 5) {
  return {
    task: { id: identity.taskID },
    trajectory: {
      page: 1,
      limit: 2,
      totalEvents: count,
      events: Array.from({ length: count }, (_, index) => ({
        id: `event-${index}`,
        at: index,
        payload: `captured-${index}`,
      })),
      nextCursor: null,
      hasMore: false,
    },
  }
}

test("history cache pages an immutable sanitized capture in exact order", () => {
  const cache = new TrajectoryHistoryCache(secret, {
    ttlMs: 100,
    maxEntries: 2,
    maxEvents: 10,
    maxBytes: 100_000,
  })
  const rawReport = report()
  const first = cache.capture(identity, rawReport, boundary, 100)
  expect(first.report.trajectory.page).toBe(1)
  expect(first.report.trajectory.limit).toBe(2)
  expect(first.report.trajectory.totalEvents).toBe(5)
  expect(first.report.trajectory.nextCursor).toBeTypeOf("string")
  expect(first.report.trajectory.events.map((event) => (event as { id: string }).id)).toEqual([
    "event-0",
    "event-1",
  ])
  expect(first.eventIDs).toEqual(["event-0", "event-1", "event-2", "event-3", "event-4"])

  rawReport.trajectory.events[2]!.payload = "mutated caller input"
  ;(first.report.trajectory.events[0] as { payload: string }).payload = "mutated response"
  const second = cache.continue(identity, first.report.trajectory.nextCursor!, 101)
  expect(second.report.trajectory.events).toEqual([
    { id: "event-2", at: 2, payload: "captured-2" },
    { id: "event-3", at: 3, payload: "captured-3" },
  ])
  expect(second.capturedAt).toBe(100)
  expect(second.expiresAt).toBe(200)
})

test("history cursors reject tampering and every foreign identity dimension", () => {
  const cache = new TrajectoryHistoryCache(secret)
  const first = cache.capture(identity, report(), boundary, 100)
  const cursor = first.report.trajectory.nextCursor!
  const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`
  expect(() => cache.continue(identity, tampered, 101)).toThrow("Invalid or stale")

  const foreignIdentities = [
    { ...identity, projectID: "other-project" },
    { ...identity, projectDirectory: "/other/project" },
    { ...identity, scope: { kind: "session" as const, sessionID: "ses-owner" } },
    { ...identity, scope: { kind: "project" as const, sessionID: "ses-other" } },
    { ...identity, taskID: "00000000-0000-4000-8000-000000000001" },
    { ...identity, limit: 3 },
  ]
  for (const foreign of foreignIdentities)
    expect(() => cache.continue(foreign, cursor, 101)).toThrow("Invalid or stale")
})

test("expired and evicted history cursors require explicit recapture", () => {
  const cache = new TrajectoryHistoryCache(secret, {
    ttlMs: 10,
    maxEntries: 1,
    maxEvents: 10,
    maxBytes: 100_000,
  })
  const expired = cache.capture(identity, report(), boundary, 100)
  expect(() => cache.continue(identity, expired.report.trajectory.nextCursor!, 110)).toThrow(
    "expired; recapture explicitly",
  )

  const retained = cache.capture(identity, report(), boundary, 200)
  const anotherIdentity = { ...identity, taskID: "00000000-0000-4000-8000-000000000002" }
  cache.capture(anotherIdentity, report(), boundary, 201)
  expect(() => cache.continue(identity, retained.report.trajectory.nextCursor!, 202)).toThrow(
    "expired or was evicted; recapture explicitly",
  )
})

test("history cache rejects duplicate or oversized projections rather than serving partial pages", () => {
  const cache = new TrajectoryHistoryCache(secret, {
    ttlMs: 100,
    maxEntries: 2,
    maxEvents: 2,
    maxBytes: 100_000,
  })
  expect(() => cache.capture(identity, report(3), boundary, 100)).toThrow("bounded capture size")
  const duplicate = report(2)
  duplicate.trajectory.events[1]!.id = duplicate.trajectory.events[0]!.id
  expect(() => cache.capture(identity, duplicate, boundary, 100)).toThrow(
    "invalid event identities",
  )
})
