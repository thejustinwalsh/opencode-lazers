import { expect, test } from "bun:test"
import type { SnapshotResponse } from "../observability/contract.ts"
import type { TaskSummary } from "./contract.ts"
import { buildExecutionList } from "./execution-list.ts"

const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`
const planID = id(900)

type FixtureNode = { taskID: string; ordinal: number; state?: string }

function topology(nodes: FixtureNode[], dependencies: Array<[string, string]>): SnapshotResponse {
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
      transitionSequence: 1,
    },
    machine: { id: "lazers-task", version: "lazers-task/1", initialState: "queued", states: [] },
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
    transitions: [],
    attempts: [],
    checks: [],
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
  expect(paged.plans[0]).toMatchObject({ activeCount: 2, totalCount: 3 })
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

test("grouped and context-only rows preserve the effective plan-blocked state", () => {
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
  tasks[0]!.reason = "Plan awaits human evidence"
  const result = buildExecutionList({ topology: observed, tasks })
  const contextualRoot = result.plans[0]?.rows[0]
  expect(contextualRoot).toMatchObject({
    taskID: root,
    contextOnly: true,
    status: "blocked",
    reason: "Plan awaits human evidence",
  })
  expect(contextualRoot?.fork?.branches[0]?.rows[0]).toMatchObject({
    taskID: left,
    contextOnly: false,
    status: "blocked",
    reason: "Plan awaits human evidence",
  })
})
