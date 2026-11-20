import { expect, test } from "bun:test"
import { trajectoryCachePair } from "./cache-pair.ts"

test("history and live caches share one budget", () => {
  const pair = trajectoryCachePair(new Uint8Array(32), 1000)
  const identity = {
    projectID: "p",
    projectDirectory: "/p",
    scope: { kind: "project" as const, sessionID: "s" },
    taskID: "t",
    limit: 1,
  }
  const report = {
    trajectory: {
      page: 1,
      limit: 1,
      totalEvents: 1,
      events: [{ id: "a", pad: "x".repeat(2000) }],
      nextCursor: null,
      hasMore: false,
    },
  }
  const boundary = {
    repositoryVersion: 1,
    sourceRevision: 1,
    sourceFingerprint: "f",
    nativeRevision: 1,
    eventSequence: 1,
    transitionSequence: 1,
  }
  // Larger than the budget: served whole, not retained.
  pair.history.capture(identity, report, boundary)
  expect(pair.history.size).toBe(0)
  pair.live.project("k", [{ id: "a", pad: "x".repeat(2000) }])
  expect(pair.live.size).toBe(0)
  const small = trajectoryCachePair(new Uint8Array(32), 100_000)
  small.live.project("k", [{ id: "a" }])
  expect(small.live.size).toBeGreaterThan(0)
  small.history.setMaxBytes(0)
  expect(small.history.size).toBe(0)
})
