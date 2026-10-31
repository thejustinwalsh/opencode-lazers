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
  expect(joinCrossEdge.plans[0]?.rows.every((row) => !row.fork)).toBe(true)
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
