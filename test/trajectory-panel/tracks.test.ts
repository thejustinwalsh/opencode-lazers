import { expect, test } from "bun:test"
import {
  buildTimeline,
  displayTitle,
  durationText,
  elapsedDurationLabel,
  eventPayload,
  parseTrajectoryReport,
  tickStep,
} from "../../src/trajectory-panel/projection.ts"
import type {
  ProjectedSnapshot,
  TrajectoryEvent,
  TrajectoryReport,
} from "../../src/trajectory-panel/projection.ts"
import {
  attemptOutcome,
  buildTracks,
  checkOutcome,
  loadedEventHorizon,
  nearestMark,
  neighborMark,
  toolOutcome,
  trackTimes,
} from "../../src/trajectory-panel/tracks.ts"

const origin = 1_000_000
const line = { origin, durationMs: 100_000 }
const finished = new Map([["attempt-1", "failed"]])

function event(value: Partial<TrajectoryEvent> & { id: string; kind: string }): TrajectoryEvent {
  return { attemptID: "attempt-1", sessionID: "ses_1", ...value } as TrajectoryEvent
}

test("native context and LAZERS progress facts for one call become one tool mark", () => {
  const native = event({
    id: "msg_1:tool:call_1",
    kind: "tool",
    at: origin + 10_000,
    completedAt: origin + 12_000,
    tool: "read",
    status: "completed",
  })
  const progress = event({
    id: "progress:7",
    kind: "worker-tool",
    callID: "call_1",
    at: origin + 9_000,
    tool: "read",
    status: "succeeded",
    timing: {
      endpoints: {
        calledAt: { at: origin + 10_000, sourceType: "tool.time.ran" },
        completedAt: { at: null },
      },
    },
    fileTargets: { coverage: "observed", operation: "read", paths: ["src/a.ts"] },
  })
  const tracks = buildTracks(line, [native, progress], finished)
  expect(tracks.tools).toHaveLength(1)
  const [mark] = tracks.tools
  expect(mark).toMatchObject({
    id: "progress:7",
    aliases: ["msg_1:tool:call_1"],
    callID: "call_1",
    outcome: "succeeded",
    start: origin + 10_000,
    end: origin + 12_000,
    startSource: "tool.time.ran",
    left: 10,
    width: 2,
  })
  expect(tracks.files).toEqual([
    {
      id: "progress:7",
      attemptID: "attempt-1",
      operation: "read",
      coverage: "observed",
      paths: ["src/a.ts"],
      tool: "read",
      outcome: "succeeded",
      at: origin + 10_000,
      left: 10,
    },
  ])
})

test("calls in different sessions with the same call ID stay distinct", () => {
  const tracks = buildTracks(
    line,
    [
      event({ id: "a:tool:call_1", kind: "tool", at: origin, sessionID: "ses_a", status: "error" }),
      event({ id: "b:tool:call_1", kind: "tool", at: origin, sessionID: "ses_b", status: "error" }),
    ],
    finished,
  )
  expect(tracks.tools.map((tool) => [tool.id, tool.outcome])).toEqual([
    ["a:tool:call_1", "failed"],
    ["b:tool:call_1", "failed"],
  ])
})

test("outcomes never claim a running call in a finished attempt", () => {
  expect(toolOutcome("running", false)).toBe("unknown")
  expect(toolOutcome("running", true)).toBe("running")
  expect(toolOutcome("error", false)).toBe("failed")
  expect(toolOutcome("unsupported", true)).toBe("unknown")
  expect(attemptOutcome("cancelled")).toBe("unknown")
  expect(attemptOutcome("accepted")).toBe("succeeded")
  expect(attemptOutcome("verifying")).toBe("running")
  expect(checkOutcome("unknown", "running")).toBe("running")
  expect(checkOutcome("failed", "completed")).toBe("failed")
})

test("untimed calls, omitted file paths, gaps and unloaded pages are counted, not placed", () => {
  const tracks = buildTracks(
    line,
    [
      event({ id: "progress:1", kind: "worker-tool", callID: "c1", status: "succeeded" }),
      event({
        id: "progress:2",
        kind: "worker-tool",
        callID: "c2",
        at: origin + 50_000,
        status: "succeeded",
        fileTargets: { coverage: "omitted", operation: "edit", paths: [] },
      }),
      event({ id: "progress:3", kind: "worker-gap", at: origin + 60_000, reason: "restart" }),
      event({ id: "msg:compaction", kind: "compaction", at: origin + 70_000 }),
    ],
    finished,
    origin + 75_000,
  )
  expect(tracks.untimedTools).toBe(1)
  expect(tracks.tools.map((tool) => tool.id)).toEqual(["progress:2"])
  expect(tracks.files).toEqual([])
  expect(tracks.omittedFileTargets).toBe(1)
  expect(tracks.gaps.map((gap) => [gap.kind, gap.label, gap.left])).toEqual([
    ["gap", "Recording gap · restart", 60],
    ["compaction", "Context compacted", 70],
  ])
  expect(tracks.loadedThrough).toBe(75)
})

test("track helpers keep keyboard order and wide hit targets", () => {
  const marks = [
    { id: "a", left: 0, width: 0 },
    { id: "b", left: 10, width: 5 },
    { id: "c", left: 40, width: 0 },
  ]
  expect(neighborMark(marks, null, "ArrowRight")?.id).toBe("a")
  expect(neighborMark(marks, "a", "ArrowRight")?.id).toBe("b")
  expect(neighborMark(marks, "c", "ArrowRight")?.id).toBe("c")
  expect(neighborMark(marks, "b", "Home")?.id).toBe("a")
  expect(neighborMark(marks, "a", "End")?.id).toBe("c")
  expect(neighborMark(marks, "a", "Enter")).toBeUndefined()
  expect(nearestMark(marks, 12, 1)?.id).toBe("b")
  expect(nearestMark(marks, 16, 2)?.id).toBe("b")
  expect(nearestMark(marks, 30, 2)).toBeUndefined()
  expect(
    loadedEventHorizon([event({ id: "x", kind: "tool", at: 5 }), event({ id: "y", kind: "tool" })]),
  ).toBe(5)
  expect(trackTimes([event({ id: "z", kind: "tool", at: 7, completedAt: 9 })])).toEqual([7, 9])
})

test("elapsed axis uses readable second, minute and hour steps", () => {
  expect(tickStep(38 * 60_000)).toBe(10 * 60_000)
  expect(tickStep(45_000)).toBe(10_000)
  expect(tickStep(5 * 3_600_000)).toBe(3_600_000)
  expect([0, 45_000, 90_000, 720_000, 3_600_000, 5_400_000].map(elapsedDurationLabel)).toEqual([
    "0",
    "45s",
    "1m30s",
    "12m",
    "1h",
    "1h30m",
  ])
  expect([240, 4_200, 18_400, 287_000, 3_720_000].map(durationText)).toEqual([
    "240ms",
    "4.2s",
    "18s",
    "4m 47s",
    "1h 02m",
  ])
})

const snapshot = (state: string, endedAt: number | null): ProjectedSnapshot =>
  ({
    plans: [{ id: "plan", title: null, nodes: [{ taskID: "task", ordinal: 0, state }] }],
    unplannedTasks: [],
    attempts: [
      {
        id: "attempt-1",
        planID: "plan",
        taskID: "task",
        number: 1,
        state,
        startedAt: origin,
        endedAt,
        timingBasis: "runner reservation",
        executions: [
          {
            startedAt: origin,
            endedAt,
            startSequence: null,
            endSequence: null,
            timingBasis: "worker lifecycle",
          },
        ],
      },
    ],
    checks: [],
  }) as unknown as ProjectedSnapshot

test("an active attempt is an open bar to the capture time; a finished one keeps its axis", () => {
  const running = buildTimeline(snapshot("running", null), "task", undefined, origin + 90_000)
  expect(running.openEnd).toBe(origin + 90_000)
  expect(running.attempts[0]?.segments[0]).toMatchObject({ open: true, pointOnly: false })
  expect(running.durationMs).toBe(90_000)
  expect(running.attempts[0]?.segments[0]?.width).toBeCloseTo(100, 6)

  // A finished attempt with a missing end stays a point; capture time cannot extend it.
  const unknownEnd = buildTimeline(snapshot("failed", null), "task", undefined, origin + 90_000)
  expect(unknownEnd.openEnd).toBeNull()
  expect(unknownEnd.attempts[0]?.segments[0]).toMatchObject({ open: false, pointOnly: true })

  const finishedLine = buildTimeline(snapshot("failed", origin + 50_000), "task")
  const later = buildTimeline(
    snapshot("failed", origin + 50_000),
    "task",
    undefined,
    origin + 9_000_000,
  )
  expect(later.durationMs).toBe(finishedLine.durationMs)
  expect(later.ticks).toEqual(finishedLine.ticks)
})

test("display title cuts long objectives on a word boundary", () => {
  expect(displayTitle("Progressive worker guidance")).toBe("Progressive worker guidance")
  const long =
    "Show recorded verification timing precisely across every attempt, plan check and receipt in the panel"
  const title = displayTitle(long)
  expect(title.endsWith("…")).toBe(true)
  expect(title.length).toBeLessThanOrEqual(73)
  expect(long.startsWith(title.slice(0, -1))).toBe(true)
  expect(displayTitle("First line\nSecond line")).toBe("First line")
})

test("the panel schema keeps only allow-listed event fields and tolerates new shapes", () => {
  const report = {
    schemaVersion: 1,
    task: { id: "task", status: "running", specification: { objective: "x" } },
    plans: [],
    attempts: [],
    effort: {
      acceptedAt: null,
      firstAttemptAt: null,
      tokenUsage: {
        measuredSubtotal: {
          uncachedInput: null,
          cacheRead: null,
          cacheWrite: null,
          output: null,
          reasoning: null,
        },
        total: null,
        knownSessions: 0,
        totalSessions: 0,
        unknownAttempts: [],
      },
      toolCalls: { count: 0 },
      recordedCost: { apiEquivalentTotalUsd: null },
    },
    coverage: {
      availableSessionContexts: 0,
      unavailableSessionContexts: 0,
      fullSessionHistory: "not guaranteed",
      compacted: false,
      ongoing: true,
      attemptsWithoutRecordedSessions: 0,
    },
    trajectory: {
      totalEvents: 1,
      nextCursor: null,
      hasMore: false,
      events: [
        {
          id: "progress:1",
          kind: "worker-tool",
          reasoning: "private chain of thought",
          native: { raw: "provider data" },
          timing: { endpoints: { calledAt: { at: 5, sourceType: "x", meaning: "m", raw: 1 } } },
          fileTargets: { coverage: "observed", operation: "read", paths: "not-an-array" },
        },
      ],
    },
  }
  const parsed = parseTrajectoryReport({ report } as never) as TrajectoryReport
  const [parsedEvent] = parsed.trajectory.events
  expect(parsedEvent).not.toHaveProperty("reasoning")
  expect(parsedEvent).not.toHaveProperty("native")
  expect(parsedEvent?.timing).toEqual({ endpoints: { calledAt: { at: 5, sourceType: "x" } } })
  expect(parsedEvent?.fileTargets).toBeUndefined()
  expect(JSON.stringify(eventPayload(parsedEvent!))).not.toContain("private chain of thought")
})

test("settled-history plan states mirror the runner's terminal plan states", async () => {
  const { terminalPlanStates } = await import("../../src/runner/plan-control.ts")
  const { SETTLED_PLAN_STATES } = await import("../../src/trajectory-panel/projection.ts")
  expect([...SETTLED_PLAN_STATES].sort()).toEqual([...terminalPlanStates].sort())
})
