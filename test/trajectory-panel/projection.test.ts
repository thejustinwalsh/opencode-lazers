import { expect, test } from "bun:test"
import {
  buildTimeline,
  checkTiming,
  createTrajectoryTransport,
  taskChoices,
} from "../../src/trajectory-panel/projection.ts"
import {
  splitFromKey,
  splitFromPointer,
  visibleTicks,
} from "../../src/trajectory-panel/panel-layout.ts"
import type {
  ProjectedSnapshot,
  RecordedAttempt,
  RecordedCheck,
  TrajectoryReport,
} from "../../src/trajectory-panel/projection.ts"

const taskA = "11111111-1111-4111-8111-111111111111"
const taskB = "22222222-2222-4222-8222-222222222222"

function check(
  planID: string | null | undefined,
  taskID: string | null,
  checkID: string,
  attemptID: string | null = null,
): RecordedCheck {
  return {
    id: `effect-${checkID}`,
    ...(planID === undefined ? {} : { planID }),
    taskID,
    attemptID,
    checkID,
    scope: attemptID ? "attempt" : "plan",
    state: "completed",
    startedAt: 1_100,
    endedAt: 1_200,
    exitCode: 0,
    timingBasis: "Recorded verification receipt endpoints",
  }
}

function attempt(id: string, taskID: string, startedAt: number): RecordedAttempt {
  return {
    id,
    planID: `plan-${id}`,
    taskID,
    number: 1,
    state: "running",
    startedAt,
    endedAt: null,
    timingBasis: "runner attempt start recorded; no end inferred",
    executions: [
      {
        startedAt: startedAt + 100,
        endedAt: null,
        startSequence: 1,
        endSequence: null,
        timingBasis: "Recorded worker start; end unavailable",
      },
    ],
  }
}

function snapshot(): ProjectedSnapshot {
  return {
    projectID: "project",
    scope: { kind: "project" },
    boundary: {
      repositoryVersion: 1,
      sourceRevision: 1,
      sourceFingerprint: "a".repeat(64),
      nativeRevision: 1,
      eventSequence: 1,
      transitionSequence: 1,
    },
    plans: [
      {
        id: "plan-a",
        title: "First related plan",
        nodes: [{ taskID: taskA, revision: 1, objective: "Task A", ordinal: 0, state: "running" }],
      },
      {
        id: "plan-b",
        title: "Unrelated plan",
        nodes: [{ taskID: taskB, revision: 1, objective: "Task B", ordinal: 0, state: "running" }],
      },
      {
        id: "plan-c",
        title: "Second related plan",
        nodes: [{ taskID: taskA, revision: 1, objective: "Task A", ordinal: 0, state: "accepted" }],
      },
    ],
    unplannedTasks: [],
    attempts: [attempt("attempt-a", taskA, 1_000)],
    checks: [
      check("plan-a", null, "check-a"),
      check("plan-b", null, "check-b"),
      check("plan-c", null, "check-c"),
      check("legacy-unscoped-plan", null, "check-unscoped"),
      check(null, null, "check-null-plan"),
      check(undefined, null, "check-missing-plan"),
      check("plan-b", taskA, "check-task-linked"),
    ],
  }
}

test("timeline includes plan checks from every plan containing the task and excludes other plans", () => {
  const source = snapshot()
  const timeline = buildTimeline(source, taskA)
  expect(timeline.checks.map((item) => item.checkID)).toEqual([
    "check-a",
    "check-c",
    "check-task-linked",
  ])
  expect(timeline.checks.map((item) => item.planID)).toEqual(["plan-a", "plan-c", "plan-b"])
  expect(buildTimeline({ ...source, plans: [...source.plans].reverse() }, taskA).checks).toEqual(
    timeline.checks,
  )
})

test("attempt timeline shares first-reservation origin and leaves recorded end unknown", () => {
  const timeline = buildTimeline(snapshot(), taskA)
  expect(timeline.origin).toBe(1_000)
  expect(timeline.attempts[0]?.segments).toEqual([
    {
      left: expect.any(Number),
      width: 0,
      pointOnly: true,
      open: false,
      visible: true,
      basis: "Recorded worker start; end unavailable",
    },
  ])
  expect(timeline.attempts[0]?.attempt.endedAt).toBeNull()
})

test("target timeline renders from the scoped report when no broad snapshot exists", () => {
  const report = {
    effort: { firstAttemptAt: 1_000 },
    plans: [],
    attempts: [
      {
        id: "target-attempt",
        planID: "target-plan",
        number: 1,
        state: "failed",
        startedAt: 1_000,
        intervals: {
          attempt: {
            startedAt: 1_000,
            endedAt: null,
            basis: "runner reservation start; attempt end unavailable",
          },
          modelActivity: {
            startedAt: 1_100,
            endedAt: 2_000,
            basis: "recorded report busy/idle endpoints",
          },
        },
        checks: [
          {
            id: "target-check",
            scope: "attempt",
            attemptID: "target-attempt",
            state: "completed",
            result: "failed",
            startedAt: 1_100,
            endedAt: 1_500,
            timingBasis: "scoped report check interval",
          },
        ],
      },
    ],
  } as unknown as TrajectoryReport

  const timeline = buildTimeline(undefined, taskA, report)
  expect(timeline.origin).toBe(1_000)
  expect(timeline.attempts).toHaveLength(1)
  expect(timeline.attempts[0]?.attempt.id).toBe("target-attempt")
  expect(timeline.attempts[0]?.attempt.planID).toBe("target-plan")
  expect(timeline.attempts[0]?.segments[0]).toMatchObject({ visible: true, pointOnly: false })
  expect(timeline.attempts[0]?.segments[0]?.width).toBeGreaterThan(0)
  expect(timeline.attempts[0]?.segments[0]?.basis).toBe(
    "Report model-activity interval: recorded report busy/idle endpoints",
  )
  expect(timeline.checks).toHaveLength(1)
  expect(timeline.checks[0]).toMatchObject({
    checkID: "target-check",
    attemptID: "target-attempt",
    visible: true,
    pointOnly: false,
  })
  expect(timeline.checks[0]?.width).toBeGreaterThan(0)

  const reportWithActivity = (startedAt: number | null, endedAt: number | null) =>
    ({
      ...report,
      attempts: report.attempts.map((attempt) => ({
        ...attempt,
        intervals: {
          ...attempt.intervals,
          modelActivity: {
            startedAt,
            endedAt,
            basis: "recorded report busy/idle endpoints",
          },
        },
      })),
    }) as TrajectoryReport
  const missingStart = buildTimeline(undefined, taskA, reportWithActivity(null, 1_500))
  expect(missingStart.attempts[0]?.segments[0]).toMatchObject({
    visible: true,
    pointOnly: true,
    basis: "Report model-activity interval: recorded report busy/idle endpoints",
  })
  expect(missingStart.attempts[0]?.segments[0]?.left).toBeGreaterThan(0)
  const missingEnd = buildTimeline(undefined, taskA, reportWithActivity(1_200, null))
  expect(missingEnd.attempts[0]?.segments[0]).toMatchObject({
    visible: true,
    pointOnly: true,
    basis: "Report model-activity interval: recorded report busy/idle endpoints",
  })
  expect(missingEnd.attempts[0]?.segments[0]?.left).toBeGreaterThan(0)
  const bothUnknown = buildTimeline(undefined, taskA, reportWithActivity(null, null))
  expect(bothUnknown.attempts[0]?.segments[0]).toMatchObject({
    visible: true,
    pointOnly: true,
    basis: "Report attempt interval: runner reservation start; attempt end unavailable",
  })
})

test("plan and attempt checks project only recorded intervals and preserve all endpoint states", () => {
  const source = snapshot()
  source.checks = [
    { ...check("plan-a", null, "ordered"), startedAt: 1_100, endedAt: 1_101 },
    { ...check("plan-a", null, "equal"), startedAt: 1_200, endedAt: 1_200 },
    { ...check("plan-a", null, "end-only"), startedAt: null, endedAt: 1_300 },
    { ...check("plan-a", null, "start-only"), startedAt: 1_400, endedAt: null },
    { ...check("plan-a", null, "missing"), startedAt: null, endedAt: null },
    { ...check("plan-a", null, "reversed"), startedAt: 1_600, endedAt: 1_500 },
    {
      ...check("plan-a", taskA, "attempt-interval", "attempt-a"),
      startedAt: 1_700,
      endedAt: 1_701,
    },
  ]
  const timeline = buildTimeline(source, taskA)
  const byID = new Map(timeline.checks.map((item) => [item.checkID, item]))

  const ordered = byID.get("ordered")!
  expect(ordered.width).toBeGreaterThan(0)
  expect(ordered.width).toBeCloseTo((1 / timeline.durationMs) * 100, 12)
  expect(ordered.visible).toBe(true)
  expect(ordered.pointOnly).toBe(false)

  const equal = byID.get("equal")!
  expect(equal.width).toBe(0)
  expect(equal.pointOnly).toBe(true)
  expect(checkTiming(equal)).toEqual({ status: "known", durationMs: 0, reason: null })

  const endOnly = byID.get("end-only")!
  expect(endOnly.left).toBe(endOnly.endLeft!)
  expect(endOnly.pointOnly).toBe(true)
  expect(checkTiming(endOnly).reason).toBe("Start time was not recorded.")

  const startOnly = byID.get("start-only")!
  expect(startOnly.left).toBe(startOnly.startLeft!)
  expect(startOnly.pointOnly).toBe(true)
  expect(checkTiming(startOnly).reason).toBe("End time was not recorded.")

  const missing = byID.get("missing")!
  expect(missing.visible).toBe(false)
  expect(missing.left).toBe(0)
  expect(checkTiming(missing).reason).toBe("Neither start nor end time was recorded.")

  const reversed = byID.get("reversed")!
  expect(reversed.left).toBe(reversed.startLeft!)
  expect(reversed.startLeft).not.toBe(reversed.endLeft)
  expect(reversed.width).toBe(0)
  expect(checkTiming(reversed)).toMatchObject({
    status: "invalid-order",
    durationMs: null,
    reason: "The recorded end time precedes the start time; duration is unavailable.",
  })

  const attemptCheck = byID.get("attempt-interval")!
  expect(attemptCheck.scope).toBe("attempt")
  expect(attemptCheck.width).toBeGreaterThan(0)
})

test("Unix epoch zero is a known endpoint and LZ112 receipt pairs retain millisecond durations", () => {
  const source = snapshot()
  source.attempts[0]!.startedAt = 0
  source.attempts[0]!.executions[0]!.startedAt = 0
  source.checks = [{ ...check("plan-a", taskA, "epoch"), startedAt: 0, endedAt: 1 }]
  const epochTimeline = buildTimeline(source, taskA)
  expect(epochTimeline.origin).toBe(0)
  expect(epochTimeline.checks[0]).toMatchObject({ left: 0, startLeft: 0, visible: true })
  expect(epochTimeline.checks[0]?.width).toBeGreaterThan(0)

  const lz112 = [
    [1_793_792_603_400, 1_793_792_603_688],
    [1_793_792_603_707, 1_793_792_604_783],
    [1_793_792_604_802, 1_793_792_605_042],
    [1_793_792_605_061, 1_793_792_607_233],
  ] as const
  expect(
    lz112.map(([startedAt, endedAt]) => checkTiming({ startedAt, endedAt }).durationMs),
  ).toEqual([288, 1_076, 240, 2_172])
})

test("execution with neither recorded endpoint is not assigned a reservation-time marker", () => {
  const source = snapshot()
  source.attempts[0]!.executions = [
    {
      startedAt: null,
      endedAt: null,
      startSequence: null,
      endSequence: null,
      timingBasis: "No matching worker lifecycle endpoints recorded",
    },
  ]
  expect(buildTimeline(source, taskA).attempts[0]?.segments).toEqual([
    {
      left: 0,
      width: 0,
      pointOnly: true,
      open: false,
      visible: false,
      basis: "No matching worker lifecycle endpoints recorded",
    },
  ])
})

test("task choices retain objective and state from all scoped plans", () => {
  expect(
    taskChoices(snapshot()).map(({ taskID, revision, title, status }) => ({
      taskID,
      revision,
      title,
      status,
    })),
  ).toEqual([
    { taskID: taskA, revision: 1, title: "Task A", status: "running" },
    { taskID: taskB, revision: 1, title: "Task B", status: "running" },
  ])
})

test("transport adapts scoped observation RPC calls without widening task trajectory reads", async () => {
  const calls: unknown[] = []
  const signal = new AbortController().signal
  const rpc = {
    snapshot: async (input: unknown, options: unknown) => {
      calls.push(["snapshot", input, options])
      return {} as never
    },
    trajectory: async (input: unknown, options: unknown) => {
      calls.push(["trajectory", input, options])
      return {} as never
    },
    event: {
      subscribe: () =>
        (async function* () {
          yield {
            type: "rpc.lazers.observability.changed",
            location: { directory: "/workspace" },
            data: {
              projectID: "project",
              sequence: 1,
              repositoryVersion: 1,
              sourceRevision: 1,
              nativeRevision: 1,
              cause: "runner",
              resnapshotRequired: false,
            },
          }
        })(),
    },
  }
  const transport = createTrajectoryTransport(
    rpc as never,
    "/workspace",
    () => true,
    rpc.event,
    "project",
  )
  const scope = { kind: "session", sessionID: "session-a" } as const
  await transport.snapshot(scope, signal)
  await transport.trajectory(scope, taskA, signal)
  await transport.trajectory(scope, taskA, signal, "cursor-a")
  const changes = []
  for await (const event of transport.changes(signal)) changes.push(event)

  expect(calls).toEqual([
    ["snapshot", { scope }, { location: { directory: "/workspace" }, signal }],
    [
      "trajectory",
      { scope, taskID: taskA, limit: 50 },
      { location: { directory: "/workspace" }, signal },
    ],
    [
      "trajectory",
      { scope, taskID: taskA, limit: 50, cursor: "cursor-a" },
      { location: { directory: "/workspace" }, signal },
    ],
  ])
  expect(changes).toEqual([
    {
      projectID: "project",
      sequence: 1,
      repositoryVersion: 1,
      sourceRevision: 1,
      nativeRevision: 1,
      cause: "runner",
      resnapshotRequired: false,
    },
  ])
})

test("timeline split supports repeated pointer moves, keyboard steps and compact bounds", () => {
  const moves = [120, 250, 380, 260].map((pointerY) => splitFromPointer(56, 40, 600, 8, pointerY))
  expect(moves[0]).toBeLessThan(moves[1]!)
  expect(moves[2]).toBeGreaterThan(moves[1]!)
  expect(moves[3]).toBeLessThan(moves[2]!)
  expect(splitFromKey(moves[3]!, "ArrowDown")).toBe(moves[3]! + 5)
  expect(splitFromKey(20, "ArrowUp")).toBe(20)
  expect(splitFromKey(75, "ArrowDown")).toBe(75)
  expect(splitFromKey(40, "Home")).toBe(20)
  expect(splitFromKey(40, "End")).toBe(75)
  expect(splitFromPointer(56, 0, 8, 8, 48)).toBe(56)
})

test("elapsed tick labels thin to fit plot width without moving their times", () => {
  const ticks = Array.from({ length: 6 }, (_, index) => ({
    elapsedMs: index * 10,
    label: `${index * 10}m`,
  }))
  expect(visibleTicks(ticks, 50, 250)).toEqual(ticks)
  expect(visibleTicks(ticks, 50, 150).map((tick) => tick.label)).toEqual(["0m", "20m", "50m"])
  expect(visibleTicks(ticks, 50, 0)).toEqual([ticks[0]!])
})
