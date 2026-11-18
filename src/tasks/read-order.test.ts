import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { TaskReads } from "./read.ts"
import { TaskStateFilter } from "./state-filter.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function open() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-order-"))
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), "/project")
  cleanups.push(() => {
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return repository
}

function insertTask(repository: TaskRepository, name: string) {
  const proposal = validProposal()
  proposal.objective = name
  proposal.writeScope = ["src/tasks/**"]
  return repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: "2026-10-31T00:00:00.000Z",
    provenance: {
      projectID: "global",
      projectDirectory: repository.projectDirectory,
      workspaceDirectory: "/worktree",
      sessionID: "session-a",
      startingRevision: { kind: "unborn" },
    },
    proposal,
  }).id
}

type Spec = {
  node: string
  priority?: number
  /** When the node reached its state, as a recorded transition. */
  finished?: number
  planState?: string
  /** A plan-level transition time, for a task cancelled with its plan. */
  planTransition?: number
}

function seed() {
  const repository = open()
  const reads = new TaskReads(repository)
  const planned = (name: string, spec: Spec) => {
    const id = insertTask(repository, name)
    const plan = reads.runner.submit(
      {
        requestID: `order-${name}`,
        objective: name,
        baseCommit: "a".repeat(40),
        nodes: [{ taskID: id, revision: 1 }],
        dependencies: [],
        integrationOrder: [id],
        verification: validProposal().verification,
        acceptance: validProposal().acceptance,
      },
      "architect",
    )
    repository.atomic((db) => {
      db.query("UPDATE runner_nodes SET state=? WHERE plan_id=?").run(spec.node, plan.planID)
      if (spec.priority !== undefined)
        db.query("UPDATE runner_plans SET body=json_set(body,'$.priority',?) WHERE id=?").run(
          spec.priority,
          plan.planID,
        )
      if (spec.planState)
        db.query("UPDATE runner_plans SET state=? WHERE id=?").run(spec.planState, plan.planID)
      const record = (taskID: string | null, to: string, at: number) =>
        db
          .query(
            "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,?,?,?,?)",
          )
          .run(plan.planID, taskID, 1, "MOVE", JSON.stringify({ from: "queued", to }), at)
      if (spec.finished !== undefined) record(id, spec.node, spec.finished)
      if (spec.planTransition !== undefined) record(null, "cancelled", spec.planTransition)
    })
    return id
  }
  const ids: Record<string, string> = {}
  const add = (name: string, spec: Spec) => {
    ids[name] = planned(name, spec)
  }
  // Created in this order; the read must not follow it.
  add("fail1", { node: "failed", finished: 10 })
  add("acc1", { node: "accepted", priority: 1, finished: 100 })
  add("openA", { node: "queued", priority: 2 })
  add("cancel1", { node: "cancelled", finished: 5 })
  add("integ1", { node: "incorporated", finished: 50 })
  ids.U1 = insertTask(repository, "U1")
  add("openC", { node: "queued" })
  add("acc2", { node: "accepted", priority: 5, finished: 200 })
  add("run1", { node: "running", priority: 3 })
  add("openB", { node: "queued", priority: 1 })
  add("acc3", { node: "accepted", priority: 2, finished: 200 })
  add("cancel2", { node: "queued", planState: "cancelled", planTransition: 300 })
  ids.U2 = insertTask(repository, "U2")
  add("heldRunning", { node: "running", priority: 1, planState: "blocked" })
  return { reads, repository, ids }
}

const ORDER = [
  "run1",
  // Equal priority keeps plan FIFO. A running node under a held plan is open work, not Running.
  "openB",
  "heldRunning",
  "openA",
  "openC",
  "U2",
  "U1",
  "acc3",
  "acc2",
  "acc1",
  "integ1",
  "fail1",
  "cancel2",
  "cancel1",
]

function names(ids: Record<string, string>, taskIDs: string[]) {
  const byID = new Map(Object.entries(ids).map(([name, id]) => [id, name]))
  return taskIDs.map((id) => byID.get(id)!)
}

test("one sort key: state rank, then priority for open work and recency for finished work", () => {
  const { reads, ids } = seed()
  const page = reads.query({ sessionID: "session-a", state: "all", sort: "schedule", limit: 100 })
  expect(
    names(
      ids,
      page.tasks.map((task) => task.taskID),
    ),
  ).toEqual(ORDER)
})

test("paging with a small page size across rank boundaries matches one big page", () => {
  const { reads, ids } = seed()
  for (const limit of [1, 2, 3, 5]) {
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = reads.query({
        sessionID: "session-a",
        state: "all",
        sort: "schedule",
        limit,
        ...(cursor ? { cursor } : {}),
      })
      seen.push(...page.tasks.map((task) => task.taskID))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(names(ids, seen)).toEqual(ORDER)
    expect(new Set(seen).size).toBe(seen.length)
  }
})

test("every state filter keeps the relative order of All restricted to that state", () => {
  const { reads, ids } = seed()
  const all = names(
    ids,
    reads
      .query({ sessionID: "session-a", state: "all", sort: "schedule", limit: 100 })
      .tasks.map((task) => task.taskID),
  )
  let nonEmpty = 0
  for (const state of TaskStateFilter.options) {
    const filtered = names(
      ids,
      reads
        .query({ sessionID: "session-a", state, sort: "schedule", limit: 100 })
        .tasks.map((task) => task.taskID),
    )
    if (filtered.length) nonEmpty++
    expect(filtered).toEqual(all.filter((name) => filtered.includes(name)))
  }
  expect(nonEmpty).toBeGreaterThanOrEqual(6)
})
