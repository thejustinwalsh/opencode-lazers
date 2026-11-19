import { expect, test } from "bun:test"
import {
  attemptDuration,
  holdReason,
  reportTaskView,
  taskReason,
} from "../../src/trajectory-panel/attempt-state.ts"
import type { TrajectoryAttempt, TrajectoryEvent } from "../../src/trajectory-panel/projection.ts"

const report = (planState: string, status = "running") =>
  ({
    task: { id: "t1", status, recordedState: status, specification: { objective: "x" } },
    plans: [{ id: "p1", state: planState, checks: [] }],
    attempts: [{ id: "a1", planID: "p1" }],
  }) as never
const blocked = {
  id: "e1",
  kind: "runner-transition",
  event: "BLOCKED",
  at: 5,
  reason: "Waiting for a dependency",
} as TrajectoryEvent

test("a running task under a blocked plan is Waiting, the word Tasks and Radar show", () => {
  const held = reportTaskView(report("blocked"), [blocked])
  expect(held.label).toBe("Waiting")
  expect(held.working).toBe(false)
  expect(held.explained).toBe(true)
  const running = reportTaskView(report("running"), [])
  expect(running.label).toBe("Running")
  expect(running.working).toBe(true)
  // A finished task under a blocked plan is not held.
  expect(reportTaskView(report("blocked", "accepted"), []).label).not.toBe("Waiting")
})

test("a held attempt gets the same callout sentence Tasks gives", () => {
  const view = reportTaskView(report("blocked"), [blocked])
  expect(holdReason([blocked])).toBe("Waiting for a dependency")
  expect(taskReason(view, [blocked])).toEqual(expect.any(String))
  expect(taskReason(view, [blocked])!.length).toBeGreaterThan(10)
  expect(taskReason(reportTaskView(report("running"), []), [])).toBeUndefined()
})

test("a held or interrupted attempt stops at its last activity, not now", () => {
  const attempt = {
    state: "running",
    startedAt: 1_000,
    toolCount: { value: 3 },
    intervals: { attempt: { startedAt: 1_000, endedAt: null } },
  } as unknown as TrajectoryAttempt
  const day = 24 * 3_600_000
  expect(attemptDuration(attempt, 1_000 + day)).toEqual({ ms: day, open: true })
  expect(attemptDuration(attempt, 1_000 + day, { lastActivity: 61_000 })).toEqual({
    ms: 60_000,
    open: false,
  })
  // No recorded activity: no duration rather than a guess.
  expect(attemptDuration(attempt, 1_000 + day, { lastActivity: null })).toBeNull()
  const ended = {
    ...attempt,
    intervals: { attempt: { startedAt: 1_000, endedAt: 5_000 } },
  } as unknown as TrajectoryAttempt
  expect(attemptDuration(ended, 9_999, { lastActivity: 2_000 })).toEqual({ ms: 4_000, open: false })
})
