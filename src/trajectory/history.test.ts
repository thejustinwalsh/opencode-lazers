import { expect, test } from "bun:test"
import type { ObservationScope } from "../observability/contract.ts"
import { TrajectoryHistoryCache, TrajectoryHistoryUnavailableError } from "./history.ts"

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

function thrown(action: () => unknown) {
  try {
    action()
  } catch (error) {
    return error
  }
  throw new Error("Expected history continuation to fail")
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
  const tamperedFailure = thrown(() => cache.continue(identity, tampered, 101))
  expect(tamperedFailure).toBeInstanceOf(TrajectoryHistoryUnavailableError)
  expect(tamperedFailure).toMatchObject({ reason: "invalid-cursor" })

  const foreignIdentities = [
    { ...identity, projectID: "other-project" },
    { ...identity, projectDirectory: "/other/project" },
    { ...identity, scope: { kind: "session" as const, sessionID: "ses-owner" } },
    { ...identity, scope: { kind: "project" as const, sessionID: "ses-other" } },
    { ...identity, taskID: "00000000-0000-4000-8000-000000000001" },
    { ...identity, limit: 3 },
  ]
  for (const foreign of foreignIdentities) {
    const failure = thrown(() => cache.continue(foreign, cursor, 101))
    expect(failure).toBeInstanceOf(TrajectoryHistoryUnavailableError)
    expect(failure).toMatchObject({ reason: "invalid-cursor" })
  }
})

test("expired and evicted history cursors require explicit recapture", () => {
  const cache = new TrajectoryHistoryCache(secret, {
    ttlMs: 10,
    maxEntries: 1,
    maxBytes: 100_000,
  })
  const expired = cache.capture(identity, report(), boundary, 100)
  const expiredFailure = thrown(() =>
    cache.continue(identity, expired.report.trajectory.nextCursor!, 110),
  )
  expect(expiredFailure).toBeInstanceOf(TrajectoryHistoryUnavailableError)
  expect(expiredFailure).toMatchObject({ reason: "expired" })

  const retained = cache.capture(identity, report(), boundary, 200)
  const anotherIdentity = { ...identity, taskID: "00000000-0000-4000-8000-000000000002" }
  cache.capture(anotherIdentity, report(), boundary, 201)
  const evictedFailure = thrown(() =>
    cache.continue(identity, retained.report.trajectory.nextCursor!, 202),
  )
  expect(evictedFailure).toBeInstanceOf(TrajectoryHistoryUnavailableError)
  expect(evictedFailure).toMatchObject({ reason: "evicted" })
})

test("an over-limit capture is served and pages every event; only older captures are evicted", () => {
  const cache = new TrajectoryHistoryCache(secret, {
    ttlMs: 1_000,
    maxEntries: 4,
    maxBytes: 2_000,
  })
  const other = { ...identity, taskID: "00000000-0000-4000-8000-000000000002" }
  const small = cache.capture(other, report(2), boundary, 100)
  const big = cache.capture(identity, report(300), boundary, 101)
  expect(big.eventIDs).toHaveLength(300)
  expect(big.report.trajectory.totalEvents).toBe(300)
  // the older capture made room; the oversize one is still reachable
  expect(small.report.trajectory.nextCursor).toBeNull()
  const seen: string[] = big.report.trajectory.events.map((e) => (e as { id: string }).id)
  let cursor = big.report.trajectory.nextCursor
  while (cursor) {
    const page = cache.continue(identity, cursor, 102)
    seen.push(...page.report.trajectory.events.map((e) => (e as { id: string }).id))
    cursor = page.report.trajectory.nextCursor
  }
  expect(seen).toEqual(big.eventIDs!)
  // a second oversize capture evicts the first instead of failing
  const second = cache.capture(other, report(300), boundary, 103)
  expect(second.eventIDs).toHaveLength(300)
  expect(
    thrown(() => cache.continue(identity, big.report.trajectory.nextCursor!, 104)),
  ).toMatchObject({
    reason: "evicted",
  })
})

test("history cache still rejects duplicate event identities", () => {
  const cache = new TrajectoryHistoryCache(secret)
  const duplicate = report(2)
  duplicate.trajectory.events[1]!.id = duplicate.trajectory.events[0]!.id
  expect(() => cache.capture(identity, duplicate, boundary, 100)).toThrow(
    "invalid event identities",
  )
})
