import { expect, test } from "bun:test"
import { TrajectoryHistoryCache } from "./history.ts"
import { TrajectoryLiveCache } from "./live.ts"

const secret = new Uint8Array(32).fill(6)
const identity = {
  projectID: "project",
  projectDirectory: "/workspace/project",
  scope: { kind: "project" as const, sessionID: "ses-owner" },
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

function report(count: number) {
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

test("a continued page parses only its own events and never clones or restringifies the capture", () => {
  const cache = new TrajectoryHistoryCache(secret, { maxBytes: 10_000_000 })
  const first = cache.capture(identity, report(200), boundary, 100)
  const stringify = JSON.stringify
  const parse = JSON.parse
  const clone = globalThis.structuredClone
  let stringifies = 0
  let parses = 0
  let clones = 0
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    stringifies++
    return stringify(...args)
  }) as typeof JSON.stringify
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    parses++
    return parse(...args)
  }) as typeof JSON.parse
  globalThis.structuredClone = ((value: unknown) => {
    clones++
    return clone(value)
  }) as typeof structuredClone
  try {
    let cursor = first.report.trajectory.nextCursor
    let pages = 0
    while (cursor) {
      const page = cache.continue(identity, cursor, 101)
      cursor = page.report.trajectory.nextCursor
      pages++
    }
    expect(pages).toBe(99)
    expect(clones).toBe(0)
    // Per page: the report remainder and its two events are parsed (plus the cursor).
    expect(parses).toBeLessThanOrEqual(pages * 4)
    // Only small cursor and identity keys are stringified, a constant per page, never the capture.
    expect(stringifies).toBeLessThanOrEqual(pages * 6)
  } finally {
    JSON.stringify = stringify
    JSON.parse = parse
    globalThis.structuredClone = clone
  }
})

test("resizing the history budget evicts least recently used captures", () => {
  const cache = new TrajectoryHistoryCache(secret, { maxBytes: 10_000_000 })
  cache.capture(identity, report(5), boundary, 100)
  const one = cache.size
  cache.capture(identity, report(5), boundary, 100)
  expect(cache.size).toBe(one * 2)
  cache.setMaxBytes(one)
  expect(cache.size).toBe(one)
  cache.setMaxBytes(0)
  expect(cache.size).toBe(0)
})

test("an unchanged live read sizes nothing and resizing evicts", () => {
  const cache = new TrajectoryLiveCache()
  const events = [
    { id: "a", kind: "worker-tool", at: 1 },
    { id: "b", kind: "worker-tool", at: 2 },
  ]
  const first = cache.project("task:a", events, undefined, 100)
  const stored = cache.size
  expect(stored).toBeGreaterThan(0)
  const unchanged = cache.project("task:a", events, first.live.cursor!, 101)
  expect(unchanged.events).toEqual([])
  expect(cache.size).toBe(stored)
  cache.setMaxBytes(0)
  expect(cache.size).toBe(0)
})
