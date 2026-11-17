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

function renderedIDs(list: ReturnType<typeof buildExecutionList>) {
  return [
    ...list.plans.flatMap((group) => [
      ...group.rows.map((row) => row.taskID),
      ...group.rows.flatMap(
        (row) =>
          row.fork?.branches.flatMap((branch) => branch.rows.map((child) => child.taskID)) ?? [],
      ),
    ]),
    ...list.unplanned.map((row) => row.taskID),
  ]
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
  expect(result.plans[0]?.rows.every((row) => !row.fork)).toBe(true)

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

test("a diamond is one real expandable fork and its shared join stays on the root lane", () => {
  const [root, left, right, join] = [id(1), id(2), id(3), id(4)]
  const result = buildExecutionList({
    topology: topology(
      [
        { taskID: root, ordinal: 0 },
        { taskID: left, ordinal: 1 },
        { taskID: right, ordinal: 2 },
        { taskID: join, ordinal: 3 },
      ],
      [
        [root, left],
        [root, right],
        [left, join],
        [right, join],
      ],
    ),
    tasks: summaries([root, left, right, join]),
  })
  const group = result.plans[0]!
  expect(group.rows.map((row) => row.taskID)).toEqual([root, join])
  expect(group.rows[0]?.fork?.joinID).toBe(join)
  expect(group.rows[0]?.fork?.branches.map((branch) => branch.taskIDs)).toEqual([[left], [right]])
  expect(new Set(renderedIDs(result)).size).toBe(4)
  expect(renderedIDs(result)).toHaveLength(4)

  const searched = buildExecutionList({
    topology: topology(
      [
        { taskID: root, ordinal: 0 },
        { taskID: left, ordinal: 1 },
        { taskID: right, ordinal: 2 },
        { taskID: join, ordinal: 3 },
      ],
      [
        [root, left],
        [root, right],
        [left, join],
        [right, join],
      ],
    ),
    tasks: summaries([left]),
    search: "Task",
  })
  expect(searched.plans[0]?.rows[0]).toMatchObject({ taskID: root, contextOnly: true })
  expect(searched.plans[0]?.rows[0]?.fork?.branches).toMatchObject([
    { taskIDs: [left] },
    { taskIDs: [], hiddenCount: 1 },
  ])
})

test("scheduling-only fallback preserves flat chains and expandable diamond forks", () => {
  const [root, left, right, join] = [id(1), id(2), id(3), id(4)]
  const nodes = [root, left, right, join].map((taskID, ordinal) => ({ taskID, ordinal }))
  const diamondEdges: Array<[string, string]> = [
    [root, left],
    [root, right],
    [left, join],
    [right, join],
  ]
  const complete = buildExecutionList({
    tasks: summaries([root, left, right, join]),
    scheduling: scheduling(nodes, diamondEdges),
  })
  expect(complete.plans[0]?.rows.map((row) => row.taskID)).toEqual([root, join])
  expect(complete.plans[0]?.rows[0]?.fork?.branches.map((branch) => branch.taskIDs)).toEqual([
    [left],
    [right],
  ])
  expect(new Set(renderedIDs(complete)).size).toBe(4)

  const filtered = buildExecutionList({
    tasks: summaries([left]),
    search: "Task",
    scheduling: scheduling(nodes, diamondEdges),
  })
  expect(filtered.plans[0]?.rows[0]).toMatchObject({ taskID: root, contextOnly: true })
  expect(filtered.plans[0]?.rows[0]?.fork?.branches).toMatchObject([
    { taskIDs: [left] },
    { taskIDs: [], hiddenCount: 1 },
  ])

  const chain = buildExecutionList({
    tasks: summaries([join, left, root]),
    scheduling: scheduling(
      [root, left, join].map((taskID, ordinal) => ({ taskID, ordinal })),
      [
        [root, left],
        [left, join],
      ],
    ),
  })
  expect(chain.plans[0]?.rows.map((row) => row.taskID)).toEqual([root, left, join])
  expect(chain.plans[0]?.rows.every((row) => !row.fork)).toBe(true)
})

test("disjoint forks remain separate and an overlapping cross-edge is never forced into a tree", () => {
  const [rootA, a1, a2, joinA, rootB, b1, b2, joinB] = [
    id(1),
    id(2),
    id(3),
    id(4),
    id(5),
    id(6),
    id(7),
    id(8),
  ]
  const disjoint = buildExecutionList({
    topology: topology(
      [rootA, a1, a2, joinA, rootB, b1, b2, joinB].map((taskID, ordinal) => ({
        taskID,
        ordinal,
      })),
      [
        [rootA, a1],
        [rootA, a2],
        [a1, joinA],
        [a2, joinA],
        [rootB, b1],
        [rootB, b2],
        [b1, joinB],
        [b2, joinB],
      ],
    ),
    tasks: summaries([rootA, a1, a2, joinA, rootB, b1, b2, joinB]),
  })
  expect(disjoint.plans[0]?.rows.filter((row) => row.fork).map((row) => row.taskID)).toEqual([
    rootA,
    rootB,
  ])
  expect(new Set(renderedIDs(disjoint)).size).toBe(8)

  const overlap = buildExecutionList({
    topology: topology(
      [rootA, a1, a2, joinA, rootB, b1].map((taskID, ordinal) => ({ taskID, ordinal })),
      [
        [rootA, a1],
        [rootA, a2],
        [a1, joinA],
        [a2, joinA],
        [rootB, a1],
        [rootB, b1],
        [b1, joinA],
      ],
    ),
    tasks: summaries([rootA, a1, a2, joinA, rootB, b1]),
  })
  expect(overlap.plans[0]?.rows.every((row) => !row.fork)).toBe(true)
  expect(overlap.plans[0]?.rows.find((row) => row.taskID === joinA)?.prerequisites).toEqual([
    a1,
    a2,
    b1,
  ])
})

test("real b50-shaped branches fold while external speech remains a join dependency", () => {
  const projection = "efd8459f-1dbe-4472-968b-f26f59504291"
  const speech = "3af64c61-ff16-43a9-8983-a11763ccf415"
  const radar = "c1cc0d39-42d7-4845-bcce-8d91aee4935b"
  const trajectory = "f1b1a687-31b7-4edb-a6bc-1865f61e0bdd"
  const assembly = "8db1b281-c288-4c2e-abaa-f846dd642246"
  const ids = [projection, speech, radar, trajectory, assembly]
  const observed = topology(
    ids.map((taskID, ordinal) => ({ taskID, ordinal })),
    [
      [projection, radar],
      [projection, trajectory],
      [radar, assembly],
      [trajectory, assembly],
      [speech, assembly],
    ],
  )
  observed.plans[0]!.id = "b50a1a71-1a54-4d89-8ef2-0644bcccc327"
  const result = buildExecutionList({ topology: observed, tasks: summaries(ids) })
  const group = result.plans[0]!
  expect(group.title).toBe("Plan b50a1a71")
  expect(group.rows.map((row) => row.taskID)).toEqual([projection, speech, assembly])
  expect(group.rows.filter((row) => row.fork)).toHaveLength(1)
  expect(group.rows[0]?.fork?.joinID).toBe(assembly)
  expect(group.rows[0]?.fork?.branches.map((branch) => branch.taskIDs)).toEqual([
    [radar],
    [trajectory],
  ])
  expect(group.rows.find((row) => row.taskID === assembly)?.prerequisites).toEqual([
    radar,
    trajectory,
    speech,
  ])
  expect(renderedIDs(result)).toHaveLength(5)
  expect(new Set(renderedIDs(result)).size).toBe(5)

  observed.plans[0]!.title = "Observation panels"
  expect(buildExecutionList({ topology: observed, tasks: summaries(ids) }).plans[0]?.title).toBe(
    "Observation panels",
  )
})

test("extra edges into branch heads and interiors and nonlinear branches remain flat", () => {
  const [root, left, interior, right, join, external] = [id(1), id(2), id(3), id(4), id(5), id(6)]
  const ids = [root, left, interior, right, join, external]
  const base: Array<[string, string]> = [
    [root, left],
    [root, right],
    [left, interior],
    [interior, join],
    [right, join],
  ]
  for (const extra of [
    [external, left],
    [external, interior],
    [left, right],
  ] as Array<[string, string]>) {
    const result = buildExecutionList({
      topology: topology(
        ids.map((taskID, ordinal) => ({ taskID, ordinal })),
        [...base, extra],
      ),
      tasks: summaries(ids),
    })
    expect(result.plans[0]?.rows.every((row) => !row.fork)).toBe(true)
    expect(new Set(renderedIDs(result)).size).toBe(ids.length)
  }
})

test("an external join prerequisite stays on the root lane with both branches folded", () => {
  const [rootA, a1, a2, joinA, rootB] = [id(1), id(2), id(3), id(4), id(5)]
  const joinCrossEdge = buildExecutionList({
    topology: topology(
      [rootA, a1, a2, joinA, rootB].map((taskID, ordinal) => ({ taskID, ordinal })),
      [
        [rootA, a1],
        [rootA, a2],
        [a1, joinA],
        [a2, joinA],
        [rootB, joinA],
      ],
    ),
    tasks: summaries([rootA, a1, a2, joinA, rootB]),
  })
  expect(joinCrossEdge.plans[0]?.rows.map((row) => row.taskID)).toEqual([rootA, joinA, rootB])
  expect(joinCrossEdge.plans[0]?.rows[0]?.fork?.branches.map((branch) => branch.taskIDs)).toEqual([
    [a1],
    [a2],
  ])
  expect(joinCrossEdge.plans[0]?.rows.find((row) => row.taskID === joinA)?.prerequisites).toEqual([
    a1,
    a2,
    rootB,
  ])
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
  const contextualRoot = result.plans[0]?.rows[0]
  expect(contextualRoot).toMatchObject({
    taskID: root,
    contextOnly: true,
    status: "ready",
    reason: "Plan awaits human evidence",
    waiting: true,
    holdReason: "Plan awaits human evidence",
  })
  expect(contextualRoot?.fork?.branches[0]?.rows[0]).toMatchObject({
    taskID: left,
    contextOnly: false,
    status: "ready",
    reason: "Plan awaits human evidence",
    waiting: true,
    holdReason: "Plan awaits human evidence",
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

test("plan groups put genuine running work first, then scheduler priority and FIFO", () => {
  const source = topology([], [])
  source.plans = [
    {
      id: id(901),
      taskID: id(1),
      priority: 5,
      queuePosition: 0,
      state: "queued",
      planState: "running",
    },
    {
      id: id(902),
      taskID: id(2),
      priority: 100,
      queuePosition: 1,
      state: "queued",
      planState: "running",
    },
    {
      id: id(903),
      taskID: id(3),
      priority: -100,
      queuePosition: 2,
      state: "running",
      planState: "running",
    },
    {
      id: id(904),
      taskID: id(4),
      priority: 5,
      queuePosition: 3,
      state: "queued",
      planState: "running",
    },
    {
      id: id(905),
      taskID: id(5),
      priority: 200,
      queuePosition: 4,
      state: "running",
      planState: "blocked",
    },
  ].map((value) => ({
    ...topology([{ taskID: value.taskID, ordinal: 0, state: value.state }], []).plans[0]!,
    id: value.id,
    priority: value.priority,
    queuePosition: value.queuePosition,
    state: value.planState,
  }))
  const list = buildExecutionList({
    topology: source,
    tasks: summaries(source.plans.map((plan) => plan.nodes[0]!.taskID)),
  })
  expect(list.plans.map((plan) => plan.rows[0]!.taskID)).toEqual([
    id(3),
    id(5),
    id(2),
    id(1),
    id(4),
  ])
})

test("running siblings precede queued siblings without treating held history as activity", () => {
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
  expect(build()).toEqual([b, a])
  source.plans[0]!.state = "blocked"
  expect(build()).toEqual([a, b])
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
  expect(rows[0]!.taskID).toBe(b)
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
