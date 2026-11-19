import { expect, test } from "bun:test"
import {
  attemptDuration,
  holdReason,
  holdReasons,
  lastWorkerActivity,
  reportTaskView,
  taskReason,
} from "../../src/trajectory-panel/attempt-state.ts"
import type { TrajectoryAttempt, TrajectoryEvent } from "../../src/trajectory-panel/projection.ts"

const report = (planState: string, status = "running", planReason: string | null = null) =>
  ({
    task: { id: "t1", status, recordedState: status, specification: { objective: "x" } },
    plans: [{ id: "p1", state: planState, reason: planReason, checks: [] }],
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
  expect(taskReason(view, report("blocked"), [blocked])).toEqual(expect.any(String))
  expect(taskReason(view, report("blocked"), [blocked])!.length).toBeGreaterThan(10)
  expect(taskReason(reportTaskView(report("running"), []), report("running"), [])).toBeUndefined()
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

test("the callout sentence comes from the plan reason, the source Tasks and Radar read", () => {
  const raw = "Worker execution was interrupted and could not resume"
  const held = report("blocked", "running", raw)
  const view = reportTaskView(held, [])
  // No BLOCKED transition carries a reason here; the plan's reason does.
  expect(holdReasons(held, [])).toEqual([raw])
  expect(taskReason(view, held, [])).toBe(
    "The worker was interrupted and the runtime could not resume it. Open Architect to resume or retry it.",
  )
  // The plan reason leads the transition's.
  expect(holdReasons(held, [blocked])).toEqual([raw, "Waiting for a dependency"])
})

test("a late runner event is not worker activity", () => {
  const at = (kind: string, time: number, extra = {}) =>
    ({ id: `${kind}${time}`, kind, at: time, attemptID: "a1", ...extra }) as TrajectoryEvent
  const events = [
    at("worker-tool", 1_000),
    at("worker-step", 2_863_000),
    at("runner-transition", 37_800_000, { event: "WORKER_STOPPED" }),
    at("worker-tool", 99, { attemptID: "other" }),
  ]
  expect(lastWorkerActivity(events, "a1")).toBe(2_863_000)
  expect(lastWorkerActivity([], "a1")).toBeNull()
  const attempt = {
    state: "running",
    startedAt: 0,
    toolCount: { value: 2 },
    intervals: { attempt: { startedAt: 0, endedAt: null } },
  } as unknown as TrajectoryAttempt
  // Held: Duration is the 47m 43s of work, not the 10h to the interruption record.
  expect(
    attemptDuration(attempt, 40_000_000, { lastActivity: lastWorkerActivity(events, "a1") }),
  ).toEqual({ ms: 2_863_000, open: false })
})
