import { expect, test } from "bun:test"
import { buildAxis, linearAxis } from "../../src/trajectory-panel/axis.ts"
import { buildTimeline } from "../../src/trajectory-panel/projection.ts"
import { buildTracks } from "../../src/trajectory-panel/tracks.ts"
import type { TrajectoryEvent } from "../../src/trajectory-panel/projection.ts"

const origin = 1_700_000_000_000
const MIN = 60_000

test("a linear axis is the identity on percent", () => {
  const axis = linearAxis(10 * MIN)
  expect(axis.place(0)).toBe(0)
  expect(axis.place(5 * MIN)).toBe(50)
  expect(axis.place(10 * MIN)).toBe(100)
  expect(axis.idle).toEqual([])
})

test("only stretches of a minute or more without activity compress", () => {
  const axis = buildAxis(10 * MIN, [0, 30_000, 59_000, 2 * MIN, 9 * MIN], true)
  expect(axis.idle).toEqual([
    { startMs: 59_000, endMs: 2 * MIN },
    { startMs: 2 * MIN, endMs: 9 * MIN },
  ])
  expect(buildAxis(10 * MIN, [0, 30_000, 59_000, 100_000], true).idle).toEqual([])
  expect(buildAxis(10 * MIN, [0, 9 * MIN], false).idle).toEqual([])
})

test("compression is monotonic, keeps endpoints and shrinks idle below its real share", () => {
  const axis = buildAxis(10 * MIN, [0, 30_000, 9 * MIN, 9 * MIN + 30_000, 10 * MIN], true)
  expect(axis.place(0)).toBe(0)
  expect(axis.place(10 * MIN)).toBe(100)
  let previous = -1
  for (let at = 0; at <= 10 * MIN; at += 5_000) {
    expect(axis.place(at)).toBeGreaterThanOrEqual(previous)
    previous = axis.place(at)
  }
  expect(axis.idle).toEqual([{ startMs: 30_000, endMs: 9 * MIN }])
  const shown = axis.place(9 * MIN) - axis.place(30_000)
  // 8.5 of 10 real minutes, drawn in a small fraction of the width.
  expect(shown).toBeLessThan(20)
  expect(shown).toBeGreaterThan(0)
})

test("idle breaks and every mark are placed by the same transform", () => {
  const events = [
    {
      id: "msg_1:tool:call_1",
      kind: "tool",
      at: origin + 10_000,
      attemptID: "attempt-1",
      sessionID: "ses_1",
      status: "completed",
      tool: "bash",
    },
    {
      id: "msg_2:tool:call_2",
      kind: "tool",
      at: origin + 6 * MIN,
      attemptID: "attempt-1",
      sessionID: "ses_1",
      status: "completed",
      tool: "bash",
    },
  ] as unknown as TrajectoryEvent[]
  const recorded = {
    attempts: [
      {
        id: "attempt-1",
        planID: "plan",
        taskID: "task",
        number: 1,
        state: "completed",
        startedAt: origin,
        endedAt: origin + 6 * MIN + 30_000,
        timingBasis: "test",
        executions: [],
      },
    ],
    checks: [],
    firstAttemptAt: origin,
  }
  const timeline = buildTimeline(recorded, null, [origin + 10_000, origin + 6 * MIN], true)
  expect(timeline.breaks).toHaveLength(1)
  const idle = timeline.breaks![0]!
  expect(idle.label).toBe("5m50s idle")
  const tracks = buildTracks(timeline, events, new Map([["attempt-1", "completed"]]))
  const [first, second] = tracks.tools
  // The marks on either side of the break sit exactly on the break's edges.
  expect(first!.left).toBeCloseTo(idle.left, 6)
  expect(second!.left).toBeCloseTo(idle.left + idle.width, 6)
  // The attempt rail ends where the same transform puts its recorded end.
  const segment = timeline.attempts[0]!.segments[0]!
  expect(timeline.axis!.place(6 * MIN + 30_000)).toBeCloseTo(segment.left + segment.width, 6)
  // Without compression the same marks are placed linearly.
  const linear = buildTimeline(recorded, null, [origin + 6 * MIN], false)
  expect(linear.breaks).toEqual([])
})
