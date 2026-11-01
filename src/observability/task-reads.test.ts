import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { AssociationTaskReads } from "./task-reads.ts"
import { TaskReads } from "../tasks/read.ts"

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

function collectPages(
  read: (input: {
    state: "open" | "completed" | "failed" | "cancelled" | "all"
    limit: number
    cursor?: string
  }) => ReturnType<AssociationTaskReads["query"]>,
  state: "open" | "completed" | "failed" | "cancelled" | "all",
) {
  const ids: string[] = []
  let cursor: string | undefined
  let count = -1
  do {
    const page = read({ state, limit: 2, ...(cursor ? { cursor } : {}) })
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

  const associatedInput = (state: "open" | "completed" | "failed" | "cancelled" | "all") => ({
    state,
    sessionID: "session-a",
    limit: 2,
  })
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
      (input) => associationReads.query({ ...associatedInput(input.state), ...input }),
      state,
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
    const found = collectPages((input) => reads.query(input), state)
    expect(found).toEqual(new Set(expected))
  }

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
  const firstProjectOpenPage = reads.query({ state: "open", limit: 2 })
  expect(() =>
    reads.query({ state: "cancelled", limit: 2, cursor: firstProjectOpenPage.nextCursor! }),
  ).toThrow("does not match")
})
