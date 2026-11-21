import { expect, test } from "bun:test"
import { buildTimeline, checkTiming } from "../../src/trajectory-panel/projection.ts"
import { visibleTicks } from "../../src/trajectory-panel/panel-layout.ts"
import type { RecordedAttempt, RecordedCheck } from "../../src/trajectory-panel/projection.ts"

const taskA = "11111111-1111-4111-8111-111111111111"

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

/** What the streams give the timeline: one task's attempts and checks. */
function snapshot(): { attempts: RecordedAttempt[]; checks: RecordedCheck[] } {
  return { attempts: [attempt("attempt-a", taskA, 1_000)], checks: [] }
}

test("attempt timeline shares first-reservation origin and leaves recorded end unknown", () => {
  const timeline = buildTimeline(snapshot())
  expect(timeline.origin).toBe(1_000)
  expect(timeline.attempts[0]?.segments).toEqual([
    {
      left: expect.any(Number),
      width: 0,
      pointOnly: true,
      startRecorded: true,
      endRecorded: false,
      open: false,
      visible: true,
      basis: "Recorded worker start; end unavailable",
    },
  ])
  expect(timeline.attempts[0]?.attempt.endedAt).toBeNull()
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
  const timeline = buildTimeline(source)
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
  const epochTimeline = buildTimeline(source)
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
  expect(buildTimeline(source).attempts[0]?.segments).toEqual([
    {
      left: 0,
      width: 0,
      pointOnly: true,
      startRecorded: false,
      endRecorded: false,
      open: false,
      visible: false,
      basis: "No matching worker lifecycle endpoints recorded",
    },
  ])
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
