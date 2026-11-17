import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { AssociationTaskReads } from "./task-reads.ts"
import { TaskReads } from "../tasks/read.ts"
import type { TaskPage } from "../tasks/contract.ts"
import type { TaskStateFilter } from "../tasks/state-filter.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-task-filters-"))
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), "/project")
  cleanups.push(() => {
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return repository
}

function addTask(repository: TaskRepository, title: string, sessionID: string) {
  const proposal = validProposal()
  proposal.objective = title
  return repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: new Date().toISOString(),
    provenance: {
      projectID: "project",
      projectDirectory: repository.projectDirectory,
      workspaceDirectory: "/worktree",
      sessionID,
      startingRevision: { kind: "unborn" },
    },
    proposal,
  })
}

function addExecution(
  reads: TaskReads,
  taskID: string,
  planState: string,
  nodeState: string,
  owner = "session-a",
) {
  const proposal = validProposal()
  const plan = reads.runner.submit(
    {
      requestID: `plan-${taskID}`,
      objective: `Plan for ${taskID}`,
      baseCommit: "a".repeat(40),
      nodes: [{ taskID, revision: 1 }],
      dependencies: [],
      integrationOrder: [taskID],
      verification: proposal.verification,
      acceptance: proposal.acceptance,
    },
    owner,
  )
  reads.repository.atomic((db) => {
    db.query("UPDATE runner_plans SET state=?,reason=? WHERE id=?").run(
      planState,
      planState === "cancelled" ? "Plan cancelled by owner" : null,
      plan.planID,
    )
    db.query("UPDATE runner_nodes SET state=? WHERE plan_id=? AND task_id=?").run(
      nodeState,
      plan.planID,
      taskID,
    )
  })
}

type PageFilter = { state?: TaskStateFilter; includeCompleted?: boolean }
function collectPages(
  read: (input: PageFilter & { limit: number; cursor?: string }) => TaskPage,
  filter: PageFilter,
) {
  const ids: string[] = []
  let cursor: string | undefined
  let count = -1
  do {
    const page = read({ ...filter, limit: 2, ...(cursor ? { cursor } : {}) })
    if (count === -1) count = page.count
    expect(page.count).toBe(count)
    ids.push(...page.tasks.map((task) => task.taskID))
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  expect(ids).toHaveLength(count)
  expect(new Set(ids).size).toBe(count)
  return new Set(ids)
}

test("state filters paginate exact effective task states in project and associated session reads", () => {
  const repository = fixture()
  const reads = new TaskReads(repository)
  const associationReads = new AssociationTaskReads(repository)
  const unplannedA = addTask(repository, "Unplanned session A", "session-a")
  const unplannedB = addTask(repository, "Unplanned session B", "session-b")
  const accepted = addTask(repository, "Accepted", "session-b")
  const incorporated = addTask(repository, "Incorporated", "session-b")
  const failed = addTask(repository, "Failed", "session-b")
  const exhausted = addTask(repository, "Exhausted", "session-b")
  const cancelledPlan = addTask(repository, "Cancelled by plan", "session-b")
  const cancelledNode = addTask(repository, "Cancelled node", "session-b")
  const blockedPlan = addTask(repository, "Blocked by plan", "session-b")
  const running = addTask(repository, "Running", "session-b")
  const retired = addTask(repository, "Retired", "session-a")

  addExecution(reads, accepted.id, "accepted", "accepted")
  addExecution(reads, incorporated.id, "accepted", "incorporated")
  addExecution(reads, failed.id, "failed", "failed")
  addExecution(reads, exhausted.id, "exhausted", "exhausted")
  addExecution(reads, cancelledPlan.id, "cancelled", "ready")
  addExecution(reads, cancelledNode.id, "running", "cancelled")
  addExecution(reads, blockedPlan.id, "blocked", "ready")
  addExecution(reads, running.id, "running", "running")
  repository.recordDisposition(
    {
      taskID: retired.id,
      requestID: "retire-filter-fixture",
      disposition: "superseded",
      reason: "Replaced by a current task.",
      evidence: [{ kind: "human", reference: "fixture" }],
    },
    { sessionID: "architect", agent: "architect" },
  )

  for (const [state, expected] of [
    ["open", [unplannedA.id, blockedPlan.id, running.id]],
    ["completed", [accepted.id, incorporated.id]],
    ["failed", [failed.id, exhausted.id]],
    ["cancelled", [cancelledPlan.id, cancelledNode.id]],
    [
      "all",
      [
        unplannedA.id,
        accepted.id,
        incorporated.id,
        failed.id,
        exhausted.id,
        cancelledPlan.id,
        cancelledNode.id,
        blockedPlan.id,
        running.id,
      ],
    ],
  ] as const) {
    const found = collectPages(
      (input) => associationReads.query({ ...input, sessionID: "session-a" }),
      { state },
    )
    expect(found).toEqual(new Set(expected))
  }

  for (const [state, expected] of [
    ["open", [unplannedA.id, unplannedB.id, blockedPlan.id, running.id]],
    ["completed", [accepted.id, incorporated.id]],
    ["failed", [failed.id, exhausted.id]],
    ["cancelled", [cancelledPlan.id, cancelledNode.id]],
    [
      "all",
      [
        unplannedA.id,
        unplannedB.id,
        accepted.id,
        incorporated.id,
        failed.id,
        exhausted.id,
        cancelledPlan.id,
        cancelledNode.id,
        blockedPlan.id,
        running.id,
      ],
    ],
  ] as const) {
    const found = collectPages((input) => reads.query(input), { state })
    expect(found).toEqual(new Set(expected))
  }

  const legacySessionIDs = new Set([
    unplannedA.id,
    failed.id,
    exhausted.id,
    blockedPlan.id,
    running.id,
  ])
  expect(
    collectPages((input) => associationReads.query({ ...input, sessionID: "session-a" }), {}),
  ).toEqual(legacySessionIDs)
  expect(
    collectPages((input) => associationReads.query({ ...input, sessionID: "session-a" }), {
      includeCompleted: false,
    }),
  ).toEqual(legacySessionIDs)
  const legacyProjectIDs = new Set([
    unplannedA.id,
    unplannedB.id,
    failed.id,
    exhausted.id,
    blockedPlan.id,
    running.id,
  ])
  expect(collectPages((input) => reads.query(input), {})).toEqual(legacyProjectIDs)
  expect(collectPages((input) => reads.query(input), { includeCompleted: false })).toEqual(
    legacyProjectIDs,
  )

  const sessionAll = associationReads.query({ sessionID: "session-a", state: "all", limit: 100 })
  expect(sessionAll.count).toBe(9)
  expect(sessionAll.tasks.map((task) => task.taskID)).not.toContain(retired.id)
  expect(sessionAll.tasks.map((task) => task.taskID)).not.toContain(unplannedB.id)
  expect(sessionAll.tasks.find((task) => task.taskID === blockedPlan.id)?.status).toBe("blocked")
  expect(sessionAll.tasks.find((task) => task.taskID === cancelledPlan.id)).toMatchObject({
    status: "cancelled",
    reason: "Plan cancelled by owner",
  })

  const projectAll = reads.query({ state: "all", limit: 100 })
  expect(projectAll.count).toBe(10)
  expect(projectAll.tasks.map((task) => task.taskID)).toContain(unplannedB.id)
  expect(projectAll.tasks.map((task) => task.taskID)).not.toContain(retired.id)

  const associatedTask = associationReads
    .query({ sessionID: "session-a", state: "all" })
    .tasks.find((task) => task.taskID === unplannedA.id)
  expect(associatedTask?.classification).toMatchObject({
    revision: 1,
    classification: { taxonomy: "task-kind/v1", primaryKind: "feature-implementation" },
    provenance: { kind: "embedded", sessionID: "session-a" },
  })
  expect(
    associationReads.get({
      taskID: unplannedA.id,
      sessionID: "session-a",
      classificationRevision: 1,
    }),
  ).toMatchObject({
    status: "found",
    classification: { revision: 1 },
    classificationAtRevision: { revision: 1 },
  })

  const legacyHistory = associationReads.query({ sessionID: "session-a", includeCompleted: true })
  expect(new Set(legacyHistory.tasks.map((task) => task.taskID))).toEqual(
    new Set(sessionAll.tasks.map((task) => task.taskID)),
  )
  expect(
    associationReads.query({ sessionID: "session-a", state: "all", includeRetired: true }).tasks,
  ).toContainEqual(expect.objectContaining({ taskID: retired.id }))

  const firstOpenPage = associationReads.query({ sessionID: "session-a", state: "open", limit: 2 })
  expect(firstOpenPage.nextCursor).toBeTruthy()
  expect(() =>
    associationReads.query({
      sessionID: "session-a",
      state: "failed",
      limit: 2,
      cursor: firstOpenPage.nextCursor!,
    }),
  ).toThrow("does not match")
  const firstLegacyPage = associationReads.query({ sessionID: "session-a", limit: 2 })
  expect(firstLegacyPage.nextCursor).toBeTruthy()
  expect(
    associationReads.query({
      sessionID: "session-a",
      includeCompleted: false,
      limit: 2,
      cursor: firstLegacyPage.nextCursor!,
    }).count,
  ).toBe(firstLegacyPage.count)
  expect(() =>
    associationReads.query({
      sessionID: "session-a",
      state: "open",
      limit: 2,
      cursor: firstLegacyPage.nextCursor!,
    }),
  ).toThrow("does not match")
  const firstProjectOpenPage = reads.query({ state: "open", limit: 2 })
  expect(() =>
    reads.query({ state: "cancelled", limit: 2, cursor: firstProjectOpenPage.nextCursor! }),
  ).toThrow("does not match")
  const firstProjectLegacyPage = reads.query({ limit: 2 })
  expect(firstProjectLegacyPage.nextCursor).toBeTruthy()
  expect(() =>
    reads.query({
      state: "open",
      limit: 2,
      cursor: firstProjectLegacyPage.nextCursor!,
    }),
  ).toThrow("does not match")
})

test("lifecycle filters retain raw states while held plans stay in the waiting filter", () => {
  const repository = fixture()
  const reads = new TaskReads(repository)
  const associationReads = new AssociationTaskReads(repository)
  const cases = [
    { name: "Queued under hold one", plan: "blocked", node: "queued" },
    { name: "Queued under hold two", plan: "blocked", node: "queued" },
    { name: "Queued on running plan", plan: "running", node: "queued" },
    { name: "Running under hold one", plan: "blocked", node: "running" },
    { name: "Running under hold two", plan: "blocked", node: "running" },
    { name: "Running on active plan", plan: "running", node: "running" },
    { name: "Ready under hold", plan: "blocked", node: "ready" },
    { name: "Node hold", plan: "running", node: "blocked" },
    { name: "Verifying under hold", plan: "blocked", node: "verifying" },
    { name: "Accepted under hold", plan: "blocked", node: "accepted" },
    { name: "Incorporated under hold", plan: "blocked", node: "incorporated" },
    { name: "Failed under hold", plan: "blocked", node: "failed" },
    { name: "Exhausted under hold", plan: "blocked", node: "exhausted" },
    { name: "Cancelled plan", plan: "cancelled", node: "queued" },
  ] as const
  const tasks = cases.map(({ name, plan, node }) => {
    const task = addTask(repository, name, "session-a")
    addExecution(reads, task.id, plan, node)
    return { ...task, node, plan }
  })
  const expected = {
    // S8: waiting plans do not masquerade as dispatchable or running work.
    queued: tasks.filter((task) => task.node === "queued" && task.plan === "running"),
    running: tasks.filter((task) => task.node === "running" && task.plan === "running"),
    blocked: tasks.filter(
      (task) =>
        task.plan !== "cancelled" &&
        (task.node === "blocked" ||
          (task.plan === "blocked" &&
            !["accepted", "incorporated", "failed", "exhausted", "cancelled"].includes(task.node))),
    ),
    completed: tasks.filter((task) => task.node === "accepted" || task.node === "incorporated"),
  }

  for (const state of ["queued", "running", "blocked", "completed"] as const) {
    const ids = new Set(expected[state].map((task) => task.id))
    expect(collectPages((input) => reads.query(input), { state })).toEqual(ids)
    expect(
      collectPages((input) => associationReads.query({ ...input, sessionID: "session-a" }), {
        state,
      }),
    ).toEqual(ids)
  }

  const queued = reads.query({ state: "queued", limit: 100 })
  expect(queued.count).toBe(1)
  expect(queued.tasks.every((task) => task.recordedState === "queued")).toBe(true)
  expect(queued.tasks.filter((task) => task.status === "blocked")).toHaveLength(0)
  const running = reads.query({ state: "running", limit: 100 })
  expect(running.count).toBe(1)
  expect(running.tasks.every((task) => task.recordedState === "running")).toBe(true)
  const blocked = reads.query({ state: "blocked", limit: 100 })
  expect(blocked.count).toBe(7)
  expect(blocked.tasks.some((task) => task.recordedState === "accepted")).toBe(false)
  expect(blocked.tasks.some((task) => task.recordedState === "incorporated")).toBe(false)
  expect(reads.query({ state: "completed", limit: 100 }).count).toBe(2)
})

test("scheduler ordering is global across pages and identical for project and associated-session reads", () => {
  const repository = fixture()
  const reads = new TaskReads(repository)
  const associated = new AssociationTaskReads(repository)
  const add = (name: string, priority: number, planState = "running", nodeState = "queued") => {
    const task = addTask(repository, name, "session-a")
    addExecution(reads, task.id, planState, nodeState)
    repository.atomic((db) =>
      db
        .query(
          "UPDATE runner_plans SET body=json_set(body,'$.priority',?) WHERE id=(SELECT plan_id FROM runner_nodes WHERE task_id=?)",
        )
        .run(priority, task.id),
    )
    return task.id
  }
  const running = add("Old running worker", 0, "running", "running")
  const high = add("High priority", 2)
  const firstTie = add("First equal priority", 3)
  const secondTie = add("Second equal priority", 3)
  const held = add("Held worker is not running", 1, "blocked", "running")
  const tail = Array.from(
    { length: 35 },
    (_, index) => addTask(repository, `Unplanned ${index}`, "session-a").id,
  )
  for (const query of [
    (input: unknown) => reads.query(input),
    (input: object) => associated.query({ ...input, sessionID: "session-a" }),
  ]) {
    const ids: string[] = []
    let cursor: string | undefined
    do {
      const page = query({
        sort: "schedule",
        state: "open",
        limit: 2,
        ...(cursor ? { cursor } : {}),
      })
      ids.push(...page.tasks.map((task) => task.taskID))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(ids).toEqual([running, held, high, firstTie, secondTie, ...tail])
  }
  const page = reads.query({ sort: "schedule", limit: 2 })
  expect(() => reads.query({ sort: "recent", cursor: page.nextCursor! })).toThrow("does not match")
  expect(reads.query({ sort: "recent", limit: 1 }).tasks[0]!.taskID).toBe(tail.at(-1)!)
})
