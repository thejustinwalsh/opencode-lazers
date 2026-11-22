import { expect, test } from "bun:test"
import {
  attemptActive,
  attemptDuration,
  attemptName,
  attemptSignals,
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

test("a running task under a blocked plan is Waiting, the word Tasks and Radar show", () => {
  const held = reportTaskView(report("blocked"))
  expect(held.label).toBe("Waiting")
  expect(held.working).toBe(false)
  expect(held.explained).toBe(true)
  const running = reportTaskView(report("running"))
  expect(running.label).toBe("Running")
  expect(running.working).toBe(true)
  // A finished task under a blocked plan is not held.
  expect(reportTaskView(report("blocked", "accepted")).label).not.toBe("Waiting")
})

test("a held attempt gets the same callout sentence Tasks gives", () => {
  const held = report("blocked", "running", "Waiting for a dependency")
  const view = reportTaskView(held)
  expect(taskReason(view, held)).toEqual(expect.any(String))
  expect(taskReason(view, held)!.length).toBeGreaterThan(10)
  expect(taskReason(reportTaskView(report("running")), report("running"))).toBeUndefined()
})

test("the header's hold reason is the stored schedule row's, whatever the timeline window holds", () => {
  // The task's BLOCKED transition is outside every loaded window: no event is passed at all. The
  // schedule row (task_schedule: plan state and reason) says the task is held, and why; the latest
  // attempt's plan is an older one that carries no state or reason.
  const raw = "Worker execution was interrupted and could not resume"
  const stored = {
    task: {
      id: "t1",
      status: "running",
      recordedState: "running",
      hold: { waiting: true, reason: raw },
      specification: { objective: "x" },
    },
    plans: [
      { id: "p0", checks: [] },
      { id: "p1", state: "blocked", reason: raw, checks: [] },
    ],
    attempts: [{ id: "a1", planID: "p0" }],
  } as never
  const view = reportTaskView(stored)
  expect(view.label).toBe("Waiting")
  expect(holdReasons(stored)).toEqual([raw])
  expect(taskReason(view, stored)).toBe(
    "The worker was interrupted and the runtime could not resume it. Open Architect to resume or retry it.",
  )
  // The stored row is not held: no hold reason, whatever an older plan recorded.
  const released = {
    ...(stored as object),
    task: { ...(stored as { task: object }).task, hold: { waiting: false, reason: null } },
  } as never
  expect(reportTaskView(released).label).toBe("Running")
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
  const view = reportTaskView(held)
  expect(holdReasons(held)).toEqual([raw])
  expect(taskReason(view, held)).toBe(
    "The worker was interrupted and the runtime could not resume it. Open Architect to resume or retry it.",
  )
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

test("an attempt with an open concern or an Architect takeover is marked; others show nothing", () => {
  expect(attemptSignals({})).toEqual({})
  expect(attemptSignals({ concern: { line: "Long run" } })).toEqual({
    concern: { line: "Long run" },
  })
  expect(
    attemptSignals({ concern: { line: "Long run", action: "steer", because: "Check in" } }),
  ).toEqual({ concern: { line: "Long run", recommendation: "Recommended: steer. Check in" } })
  expect(attemptSignals({ takeover: { agent: "architect" } })).toEqual({ takeover: true })
  expect(attemptName({ number: 2 })).toBe("Attempt 2")
  expect(attemptName({ number: 3, takeover: { agent: "architect" } })).toBe("Architect takeover")
})

test("a finished attempt's active time is its working time, not start to last event", () => {
  // LZ-216: started, worked 3 h 39 m in steps, accepted, then adopted 33 min later; wall 6 h 37 m.
  const finished = {
    state: "accepted",
    startedAt: 0,
    activeMs: 13_117_095,
    intervals: { attempt: { startedAt: 0, endedAt: 23_820_319 } },
  } as unknown as TrajectoryAttempt
  expect(attemptActive(finished)).toEqual({ ms: 13_117_095, open: false })
  // No completed step: no figure rather than the wall span.
  expect(attemptActive({ ...finished, activeMs: null })).toBeNull()
  // An active attempt shows elapsed time "so far" instead.
  expect(attemptActive({ ...finished, state: "running" })).toBeNull()
})
