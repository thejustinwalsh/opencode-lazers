import { expect, test } from "bun:test"
import {
  buildTimeline,
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
      visible: true,
      basis: "Recorded worker start; end unavailable",
    },
  ])
  expect(timeline.attempts[0]?.attempt.endedAt).toBeNull()
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
