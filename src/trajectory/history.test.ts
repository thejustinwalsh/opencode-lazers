import { expect, test } from "bun:test"
import type { ObservationScope } from "../observability/contract.ts"
import {
  DEFAULT_HISTORY_CACHE_MB,
  historyCacheBytes,
  TrajectoryHistoryCache,
  TrajectoryHistoryUnavailableError,
} from "./history.ts"

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

/** Serialised size of one cached `report()` capture, found by probing a large budget. */
const entryBytes = (() => {
  const probe = new TrajectoryHistoryCache(secret, { maxBytes: 1 << 30 }) as unknown as {
    capture: TrajectoryHistoryCache["capture"]
    bytes: number
  }
  probe.capture(identity, report(), boundary, 0)
  return probe.bytes
})()

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
    maxBytes: entryBytes * 1.5,
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

test("an entry larger than the whole budget is served in one page and not cached", () => {
  const cache = new TrajectoryHistoryCache(secret, { ttlMs: 1_000, maxBytes: 2_000 })
  const big = cache.capture(identity, report(300), boundary, 100)
  expect(big.eventIDs).toHaveLength(300)
  expect(big.report.trajectory.events).toHaveLength(300)
  expect(big.report.trajectory.totalEvents).toBe(300)
  expect(big.report.trajectory.nextCursor).toBeNull()
  expect(big.report.trajectory.hasMore).toBe(false)
  // nothing was cached for it, so it evicted nothing
  const small = cache.capture(
    { ...identity, taskID: "00000000-0000-4000-8000-000000000002" },
    report(2),
    boundary,
    101,
  )
  expect(small.report.trajectory.nextCursor).toBeNull()
})

test("eviction is least recently used, and a continuation refreshes recency", () => {
  const cache = new TrajectoryHistoryCache(secret, { ttlMs: 10_000, maxBytes: entryBytes * 2.5 })
  const id = (n: number) => ({ ...identity, taskID: `00000000-0000-4000-8000-00000000000${n}` })
  const a = cache.capture(id(1), report(), boundary, 100)
  const b = cache.capture(id(2), report(), boundary, 101)
  // reading A makes B the least recently used
  cache.continue(id(1), a.report.trajectory.nextCursor!, 102)
  cache.capture(id(3), report(), boundary, 103)
  expect(
    cache.continue(id(1), a.report.trajectory.nextCursor!, 104).report.trajectory.events,
  ).toHaveLength(2)
  expect(thrown(() => cache.continue(id(2), b.report.trajectory.nextCursor!, 104))).toMatchObject({
    reason: "evicted",
  })
})

test("the historyCacheMB option sets the budget; anything unusable is the default", () => {
  expect(historyCacheBytes(64)).toBe(64 * 1024 * 1024)
  expect(historyCacheBytes(0.5)).toBe(512 * 1024)
  for (const value of [undefined, 0, -1, "64", Number.NaN])
    expect(historyCacheBytes(value)).toBe(DEFAULT_HISTORY_CACHE_MB * 1024 * 1024)
})

test("history cache still rejects duplicate event identities", () => {
  const cache = new TrajectoryHistoryCache(secret)
  const duplicate = report(2)
  duplicate.trajectory.events[1]!.id = duplicate.trajectory.events[0]!.id
  expect(() => cache.capture(identity, duplicate, boundary, 100)).toThrow(
    "invalid event identities",
  )
})
