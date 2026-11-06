import { expect, test } from "bun:test"
import { TrajectoryLiveCache } from "./live.ts"

test("live delivery retains unchanged events and updates the same ID across lost responses", () => {
  const cache = new TrajectoryLiveCache()
  const running = { id: "tool:1", kind: "worker-tool", status: "running", at: 100 }
  const first = cache.project("task:a", [running], undefined, 100)
  expect(first.live.mode).toBe("reset")
  const completed = { ...running, status: "succeeded", result: "passed" }
  const lost = cache.project("task:a", [completed], first.live.cursor!, 101)
  expect(lost.events).toEqual([completed])
  const retry = cache.project("task:a", [completed], first.live.cursor!, 102)
  expect(retry.events).toEqual([completed])
  expect(retry.live.baseCursor).toBe(first.live.cursor)
  const unchanged = cache.project("task:a", [completed], retry.live.cursor!, 103)
  expect(unchanged.events).toEqual([])
  expect(unchanged.live.cursor).toBe(retry.live.cursor)
  const removed = cache.project("task:a", [], retry.live.cursor!, 104)
  expect(removed.live.removed).toEqual([running.id])
})

test("foreign, expired, evicted and process-lost baselines reset with the current full data", () => {
  const cache = new TrajectoryLiveCache({ maxEntries: 1, maxBytes: 1000, ttlMs: 10 })
  const a = { id: "a", kind: "worker-tool", text: "private to task a" }
  const b = { id: "b", kind: "worker-tool", text: "task b" }
  const first = cache.project("task:a", [a], undefined, 100)
  const foreign = cache.project("task:b", [b], first.live.cursor!, 101)
  expect(foreign.live.mode).toBe("reset")
  expect(foreign.events).toEqual([b])
  expect(foreign.live.removed).toEqual([])
  const evicted = cache.project("task:a", [a], first.live.cursor!, 102)
  expect(evicted.live.mode).toBe("reset")
  expect(evicted.events).toEqual([a])
  const expired = cache.project("task:a", [a], evicted.live.cursor!, 112)
  expect(expired.live.mode).toBe("reset")
  const restarted = new TrajectoryLiveCache().project("task:a", [a], expired.live.cursor!, 113)
  expect(restarted.live.mode).toBe("reset")
  expect(restarted.events).toEqual([a])
})

test("a projection larger than the delivery cache is returned in full without truncation", () => {
  const cache = new TrajectoryLiveCache({ maxEntries: 1, maxBytes: 1, ttlMs: 10 })
  const events = [{ id: "large", text: "full contents" }]
  const response = cache.project("a", events)
  expect(response.events).toEqual(events)
  expect(response.live.cursor).toBeNull()
})
