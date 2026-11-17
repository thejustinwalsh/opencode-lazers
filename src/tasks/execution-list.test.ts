import { expect, test } from "bun:test"
import type { TopologyResponse } from "../observability/contract.ts"
import type { TaskSummary } from "./contract.ts"
import { buildExecutionList } from "./execution-list.ts"
import type { SchedulingSnapshot } from "./scheduling-contract.ts"

const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`
const planID = id(900)

type FixtureNode = { taskID: string; ordinal: number; state?: string }

function topology(nodes: FixtureNode[], dependencies: Array<[string, string]>): TopologyResponse {
  return {
    schemaVersion: 1,
    projectID: "project",
    scope: { kind: "project" },
    observedAt: "2026-10-31T00:00:00.000Z",
    boundary: {
      repositoryVersion: 1,
      sourceRevision: 1,
      sourceFingerprint: "a".repeat(64),
      nativeRevision: 1,
      eventSequence: 1,
    },
    plans: [
      {
        id: planID,
        revision: 1,
        version: 1,
        state: "running",
        reason: null,
        title: null,
        afterPlans: [],
        nodes: nodes.map((node) => ({
          taskID: node.taskID,
          revision: 1,
          objective: `Task ${node.ordinal}`,
          ordinal: node.ordinal,
          state: (node.state ?? "ready") as "ready",
          version: 1,
          reason: null,
          machineVersion: "lazers-task/1",
          machineSupported: true,
          snapshot: null,
          snapshotMatchesState: false,
          waitingOn: [],
        })),
        dependencies: dependencies.map(([prerequisite, successor]) => ({
          prerequisite,
          successor,
        })),
      },
    ],
    unplannedTasks: [],
  }
}

function summaries(ids: string[]): TaskSummary[] {
  return ids.map((taskID, ordinal) => ({
    taskID,
    reference: `LZ-${ordinal + 1}`,
    revision: 1,
    status: "ready",
    reason: null,
    classification: {
      revision: 1,
      classification: { taxonomy: "task-kind/v1", primaryKind: "feature-implementation" },
      provenance: {
        kind: "embedded",
        sessionID: "session",
        createdAt: "2026-10-31T00:00:00.000Z",
      },
    },
    title: `Task ${ordinal}`,
    objective: `Task ${ordinal}`,
    createdAt: "2026-10-31T00:00:00.000Z",
    sessionID: "session",
    matches: [],
  }))
}

function scheduling(
  nodes: FixtureNode[],
  dependencies: Array<[string, string]>,
): SchedulingSnapshot {
  return {
    schemaVersion: 1,
    snapshotID: id(901),
    repositoryVersion: 1,
    scope: { kind: "project", sessionID: "session" },
    observedAt: 1,
    coverage: {
      status: "complete",
      planCount: 1,
      coveredPlanCount: 1,
      nodeCount: nodes.length,
      coveredNodeCount: nodes.length,
      activeReservationCount: 0,
      reservationsComplete: true,
      reason: null,
    },
    next: { status: "none" },
    selectedTaskIDs: [],
    selectionComplete: true,
    plans: [
      {
        planID,
        planVersion: 1,
        planOrder: 0,
        priority: 0,
        title: "Fixture plan",
        lifecycle: "running",
        decision: "eligible",
        reason: null,
        afterPlans: [],
        nodes: nodes.map((node) => ({
          taskID: node.taskID,
          title: `Task ${node.ordinal}`,
          objective: `Task ${node.ordinal}`,
          ordinal: node.ordinal,
          order: node.ordinal,
          lifecycle: (node.state ?? "ready") as "ready",
          decision: "eligible",
          reason: null,
          prerequisites: dependencies
            .filter(([, successor]) => successor === node.taskID)
            .map(([prerequisite]) => prerequisite),
          waitingOn: [],
          reservationTaskIDs: [],
        })),
        nodesComplete: true,
      },
    ],
  }
}

test("chains keep admitted ordinals without implying parallel work and preserve off-page prerequisites", () => {
  const a = id(1)
  const b = id(2)
  const c = id(3)
  const result = buildExecutionList({
    topology: topology(
      [
        { taskID: a, ordinal: 0 },
        { taskID: b, ordinal: 1 },
        { taskID: c, ordinal: 2 },
      ],
      [
        [a, b],
        [b, c],
      ],
    ),
    tasks: summaries([c, a, b]),
  })
  expect(result.plans[0]?.rows.map((row) => row.taskID)).toEqual([a, b, c])

  const paged = buildExecutionList({
    topology: topology(
      [
        { taskID: a, ordinal: 0, state: "accepted" },
        { taskID: b, ordinal: 1 },
        { taskID: c, ordinal: 2 },
      ],
      [
        [a, b],
        [b, c],
      ],
    ),
    tasks: summaries([c]),
  })
  expect(paged.plans[0]?.rows.map((row) => row.taskID)).toEqual([c])
  expect(paged.plans[0]?.rows[0]?.prerequisites).toEqual([b])
  expect(paged.plans[0]).toMatchObject({ nonterminalCount: 2, totalCount: 3 })
})

test("planless and unavailable topology remain honest ungrouped task rows", () => {
  const task = summaries([id(50)])[0]!
  const noPlans = buildExecutionList({ topology: topology([], []), tasks: [task] })
  expect(noPlans.plans).toEqual([])
  expect(noPlans.unplanned.map((row) => row.taskID)).toEqual([task.taskID])

  const selectedPlanless = topology([], [])
  const selectedID = id(51)
  selectedPlanless.unplannedTasks.push({
    taskID: selectedID,
    revision: 1,
    status: "submitted",
    title: "Selected planless task",
  })
  expect(
    buildExecutionList({
      topology: selectedPlanless,
      tasks: [],
      revealTaskIDs: new Set([selectedID]),
    }).unplanned,
  ).toMatchObject([{ taskID: selectedID, title: "Selected planless task", contextOnly: true }])

  const unavailable = buildExecutionList({ tasks: [task] })
  expect(unavailable.topologyAvailable).toBe(false)
  expect(unavailable.unplanned).toMatchObject([{ taskID: task.taskID, prerequisites: [] }])
})

test("selecting an already visible planless task emits its canonical row once", () => {
  const task = summaries([id(50)])[0]!
  const observed = topology([], [])
  observed.unplannedTasks.push({
    taskID: task.taskID,
    revision: 1,
    status: "submitted",
    title: task.title,
  })
  const result = buildExecutionList({
    topology: observed,
    tasks: [task],
    revealTaskIDs: new Set([task.taskID]),
  })
  expect(result.unplanned.map((row) => row.taskID)).toEqual([task.taskID])
  expect(result.unplanned[0]?.contextOnly).toBe(false)
})

test("grouped and context-only rows preserve recorded lifecycle beside plan holds", () => {
  const [root, left, right, join] = [id(1), id(2), id(3), id(4)]
  const observed = topology(
    [root, left, right, join].map((taskID, ordinal) => ({ taskID, ordinal })),
    [
      [root, left],
      [root, right],
      [left, join],
      [right, join],
    ],
  )
  observed.plans[0]!.state = "blocked"
  observed.plans[0]!.reason = "Plan awaits human evidence"
  const tasks = summaries([left])
  tasks[0]!.status = "blocked"
  tasks[0]!.recordedState = "ready"
  tasks[0]!.reason = "Plan awaits human evidence"
  const result = buildExecutionList({ topology: observed, tasks })
  expect(result.plans[0]?.rows).toMatchObject([
    {
      taskID: left,
      contextOnly: false,
      status: "ready",
      reason: "Plan awaits human evidence",
      waiting: true,
      holdReason: "Plan awaits human evidence",
    },
  ])
  expect(result.related.find((row) => row.taskID === root)).toMatchObject({
    contextOnly: true,
    status: "ready",
    reason: "Plan awaits human evidence",
    waiting: true,
  })
})

test("rows keep raw recorded node state when an older summary contains effective held status", () => {
  const taskID = id(1)
  const observed = topology([{ taskID, ordinal: 0 }], [])
  observed.plans[0]!.state = "blocked"
  const task = summaries([taskID])[0]!
  task.status = "blocked"
  expect(buildExecutionList({ topology: observed, tasks: [task] }).plans[0]?.rows[0]).toMatchObject(
    {
      status: "ready",
      waiting: true,
    },
  )
  task.recordedState = "ready"
  expect(buildExecutionList({ tasks: [task] }).unplanned[0]).toMatchObject({ status: "ready" })
})

test("cross-plan waits retain off-page references and distinguish acceptance from integration", () => {
  const a = id(1),
    b = id(2)
  const source = topology([{ taskID: a, ordinal: 0, state: "accepted" }], [])
  source.plans[0]!.state = "accepted"
  source.plans[0]!.nodes[0]!.reference = "LZ-185"
  const dependent = topology([{ taskID: b, ordinal: 0, state: "queued" }], []).plans[0]!
  dependent.id = id(901)
  dependent.afterPlans = [planID]
  source.plans.push(dependent)
  const build = () =>
    buildExecutionList({ topology: source, tasks: summaries([b]) }).plans[0]!.rows[0]!
  expect(build()).toMatchObject({
    waiting: true,
    dependencyTasks: [
      { taskID: a, reference: "LZ-185", state: "awaiting integration", waiting: true },
    ],
  })
  source.plans[0]!.state = "cleanup-blocked"
  expect(build()).toMatchObject({
    waiting: false,
    dependencyTasks: [{ taskID: a, state: "integrated", waiting: false }],
  })
  source.plans[0]!.state = "cancelled"
  expect(build().dependencyTasks?.[0]).toMatchObject({ state: "cancelled", waiting: true })
})

test("same-plan rows expose sequential blockers without calling completed predecessors blockers", () => {
  const a = id(1),
    b = id(2)
  const source = topology(
    [
      { taskID: a, ordinal: 0, state: "running" },
      { taskID: b, ordinal: 1, state: "queued" },
    ],
    [[a, b]],
  )
  source.plans[0]!.nodes[0]!.reference = "LZ-1"
  const build = () =>
    buildExecutionList({ topology: source, tasks: summaries([b]) }).plans[0]!.rows[0]!
  expect(build()).toMatchObject({
    waiting: true,
    dependencyTasks: [{ reference: "LZ-1", state: "running", waiting: true }],
  })
  source.plans[0]!.nodes[0]!.state = "accepted"
  expect(build()).toMatchObject({ waiting: false, dependencyTasks: [{ waiting: false }] })
})

test("plan groups sort by priority (1 first, none last), then scheduler plan order", () => {
  const source = topology([], [])
  source.plans = [
    { id: id(901), taskID: id(1), priority: 5, queuePosition: 0 },
    { id: id(902), taskID: id(2), priority: 0, queuePosition: 1 },
    { id: id(903), taskID: id(3), priority: 1, queuePosition: 2 },
    { id: id(904), taskID: id(4), priority: 5, queuePosition: 3 },
    { id: id(905), taskID: id(5), priority: 2, queuePosition: 4 },
  ].map((value) => ({
    ...topology([{ taskID: value.taskID, ordinal: 0, state: "queued" }], []).plans[0]!,
    id: value.id,
    priority: value.priority,
    queuePosition: value.queuePosition,
  }))
  const list = buildExecutionList({
    topology: source,
    tasks: summaries(source.plans.map((plan) => plan.nodes[0]!.taskID)),
  })
  expect(list.plans.map((plan) => plan.rows[0]!.taskID)).toEqual([
    id(3),
    id(5),
    id(1),
    id(4),
    id(2),
  ])
})

test("rows stay in node order within a plan; running work is not pinned above queued work", () => {
  const a = id(1),
    b = id(2)
  const source = topology(
    [
      { taskID: a, ordinal: 0, state: "queued" },
      { taskID: b, ordinal: 1, state: "running" },
    ],
    [],
  )
  const build = () =>
    buildExecutionList({ topology: source, tasks: summaries([a, b]) }).plans[0]!.rows.map(
      (row) => row.taskID,
    )
  expect(build()).toEqual([a, b])
  source.plans[0]!.state = "blocked"
  expect(build()).toEqual([a, b])
})

test("tasks outside the listed page are available as dependency rows, never listed", () => {
  const [a, b, c] = [id(1), id(2), id(3)]
  const nodes = [
    { taskID: a, ordinal: 0, state: "accepted" },
    { taskID: b, ordinal: 1 },
    { taskID: c, ordinal: 2 },
  ]
  const edges: Array<[string, string]> = [
    [a, b],
    [b, c],
  ]
  for (const list of [
    buildExecutionList({ topology: topology(nodes, edges), tasks: summaries([c]) }),
    buildExecutionList({ tasks: summaries([c]), scheduling: scheduling(nodes, edges) }),
  ]) {
    expect(list.plans[0]!.rows.map((row) => row.taskID)).toEqual([c])
    expect(list.related.map((row) => row.taskID).toSorted()).toEqual([a, b].toSorted())
    expect(list.related.every((row) => row.contextOnly)).toBe(true)
  }
})

test("dispatch pause applies to queued rows while active workers remain running", () => {
  const a = id(1),
    b = id(2)
  const source = topology(
    [
      { taskID: a, ordinal: 0, state: "queued" },
      { taskID: b, ordinal: 1, state: "running" },
    ],
    [],
  )
  source.plans[0]!.dispatchPause = { reason: "Coordinate release", untilPlans: [] }
  const rows = buildExecutionList({ topology: source, tasks: summaries([a, b]) }).plans[0]!.rows
  expect(rows.find((row) => row.taskID === a)?.dispatchPause?.reason).toBe("Coordinate release")
  expect(rows.find((row) => row.taskID === b)?.dispatchPause).toBeUndefined()
})

test("without topology, a dispatch pause still marks queued and ready rows", () => {
  const [a, b, c, d] = [id(1), id(2), id(3), id(4)]
  const pause = { reason: "Coordinate release", untilPlans: [] }
  const tasks = summaries([a, b, c, d]).map((task, index) => ({
    ...task,
    // The task page reports the plan's pause on queued work; one listed row is already running.
    status: index === 1 ? ("running" as const) : ("ready" as const),
    ...(index === 0 ? { dispatchPause: pause } : {}),
  }))
  const nodes = [
    { taskID: a, ordinal: 0 },
    { taskID: b, ordinal: 1, state: "running" },
    { taskID: c, ordinal: 2 },
  ]
  // Scheduling-backed groups: the plan's pause marks every queued or ready row of that plan.
  const grouped = buildExecutionList({
    tasks: tasks.slice(0, 3),
    scheduling: scheduling(nodes, []),
  })
  const rows = grouped.plans[0]!.rows
  expect(rows.find((row) => row.taskID === a)?.dispatchPause).toEqual(pause)
  expect(rows.find((row) => row.taskID === c)?.dispatchPause).toEqual(pause)
  expect(rows.find((row) => row.taskID === b)?.dispatchPause).toBeUndefined()
  // Ungrouped (no scheduling either): each task keeps the pause the task page reported.
  const ungrouped = buildExecutionList({ tasks: [tasks[0]!, tasks[3]!] })
  expect(ungrouped.unplanned.find((row) => row.taskID === a)?.dispatchPause).toEqual(pause)
  expect(ungrouped.unplanned.find((row) => row.taskID === d)?.dispatchPause).toBeUndefined()
})
