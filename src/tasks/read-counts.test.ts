import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { TaskReads } from "./read.ts"
import { preferredTaskStateFilter } from "./state-filter.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function open() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-counts-"))
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), "/project")
  cleanups.push(() => {
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return repository
}

function addTask(
  repository: TaskRepository,
  reads: TaskReads,
  name: string,
  node: string,
  options: { startedAt?: number; sessionID?: string } = {},
) {
  const proposal = validProposal()
  proposal.objective = name
  proposal.writeScope = ["src/tasks/**"]
  const task = repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: "2026-10-31T00:00:00.000Z",
    provenance: {
      projectID: "global",
      projectDirectory: repository.projectDirectory,
      workspaceDirectory: "/worktree",
      sessionID: options.sessionID ?? "session-a",
      startingRevision: { kind: "unborn" },
    },
    proposal,
  })
  const plan = reads.runner.submit(
    {
      requestID: `counts-${name}`,
      objective: name,
      baseCommit: "a".repeat(40),
      nodes: [{ taskID: task.id, revision: 1 }],
      dependencies: [],
      integrationOrder: [task.id],
      verification: validProposal().verification,
      acceptance: validProposal().acceptance,
    },
    "architect",
  )
  repository.atomic((db) => {
    db.query("UPDATE runner_nodes SET state=? WHERE plan_id=?").run(node, plan.planID)
    if (options.startedAt !== undefined)
      db.query(
        `INSERT INTO runner_attempts
          (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,state,started_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        crypto.randomUUID(),
        plan.planID,
        task.id,
        1,
        `worker-${name}`,
        `message-${name}`,
        "/worktree",
        "a".repeat(40),
        null,
        "{}",
        "running",
        options.startedAt,
      )
  })
  return task.id
}

function seed() {
  const repository = open()
  const reads = new TaskReads(repository)
  const ids = {
    queued: addTask(repository, reads, "queued one", "queued"),
    running: addTask(repository, reads, "running one", "running", { startedAt: 1_700_000_000_000 }),
    accepted: addTask(repository, reads, "accepted one", "accepted"),
    accepted2: addTask(repository, reads, "accepted two", "accepted"),
    integrated: addTask(repository, reads, "integrated one", "incorporated"),
    failed: addTask(repository, reads, "failed one", "failed"),
    other: addTask(repository, reads, "other session", "queued", { sessionID: "session-b" }),
  }
  return { repository, reads, ids }
}

test("the first page counts every state filter for the scope in one read", () => {
  const { reads } = seed()
  const counts = reads.query({ sessionID: "session-a", state: "queued" }).stateCounts
  expect(counts).toMatchObject({
    open: 2,
    queued: 1,
    running: 1,
    accepted: 2,
    integrated: 1,
    failed: 1,
    cancelled: 0,
    all: 6,
  })
  // Project scope sees the other session too, and a search narrows every count.
  expect(reads.query({ state: "all" }).stateCounts).toMatchObject({ all: 7, queued: 2 })
  expect(reads.query({ state: "all", search: "accepted" }).stateCounts).toMatchObject({
    all: 2,
    accepted: 2,
    open: 0,
  })
})

test("later pages carry no counts", () => {
  const { reads } = seed()
  const first = reads.query({ sessionID: "session-a", state: "all", limit: 2 })
  expect(first.stateCounts).toBeDefined()
  const next = reads.query({
    sessionID: "session-a",
    state: "all",
    limit: 2,
    cursor: first.nextCursor!,
  })
  expect(next.stateCounts).toBeUndefined()
})

test("accepted and integrated are separate filters whose counts match their pages", () => {
  const { reads, ids } = seed()
  const accepted = reads.query({ sessionID: "session-a", state: "accepted" })
  expect(accepted.count).toBe(2)
  expect(new Set(accepted.tasks.map((task) => task.taskID))).toEqual(
    new Set([ids.accepted, ids.accepted2]),
  )
  const integrated = reads.query({ sessionID: "session-a", state: "integrated" })
  expect(integrated.tasks.map((task) => task.taskID)).toEqual([ids.integrated])
  expect(integrated.tasks[0]!.status).toBe("incorporated")
  // The old filter still reads both, for an older GUI.
  expect(reads.query({ sessionID: "session-a", state: "completed" }).count).toBe(3)
})

test("a running task carries its current attempt's start; others carry none", () => {
  const { reads, ids } = seed()
  const tasks = reads.query({ sessionID: "session-a", state: "all" }).tasks
  expect(tasks.find((task) => task.taskID === ids.running)?.startedAt).toBe(1_700_000_000_000)
  for (const task of tasks.filter((item) => item.taskID !== ids.running))
    expect(task.startedAt).toBeUndefined()
})

test("elapsed start follows the Running filter: a running node under a held plan has none", () => {
  const { repository, reads } = seed()
  const held = addTask(repository, reads, "held running", "running", {
    startedAt: 1_700_000_000_000,
  })
  repository.atomic((db) => {
    db.query(
      "UPDATE runner_plans SET state='blocked' WHERE id=(SELECT plan_id FROM runner_nodes WHERE task_id=?)",
    ).run(held)
  })
  const page = reads.query({ sessionID: "session-a", state: "all" })
  expect(page.tasks.find((task) => task.taskID === held)?.startedAt).toBeUndefined()
  const running = reads.query({ sessionID: "session-a", state: "running" })
  expect(running.count).toBe(page.stateCounts?.running ?? -1)
  expect(running.tasks.every((task) => task.startedAt !== undefined)).toBe(true)
})

test("a stored Completed preference maps to All, which lists everything Completed did", () => {
  expect(preferredTaskStateFilter("completed", undefined)).toBe("all")
  expect(preferredTaskStateFilter("accepted", undefined)).toBe("accepted")
  expect(preferredTaskStateFilter(undefined, false)).toBe("open")
})

test("counting costs a few milliseconds at the live database size", () => {
  const repository = open()
  const reads = new TaskReads(repository)
  const states = ["queued", "running", "accepted", "incorporated", "failed", "cancelled"]
  for (let index = 0; index < 200; index++)
    addTask(repository, reads, `bulk ${index}`, states[index % states.length]!)
  const time = (run: () => void) => {
    const started = performance.now()
    for (let repeat = 0; repeat < 10; repeat++) run()
    return (performance.now() - started) / 10
  }
  const page = (stateCounts: boolean) =>
    time(() =>
      repository.readPage({
        sort: "schedule",
        search: "",
        limit: 31,
        state: "open",
        stateCounts,
      }),
    )
  page(true)
  const withCounts = page(true)
  const withoutCounts = page(false)
  console.log(
    `200 tasks: first page ${withoutCounts.toFixed(2)} ms, with counts ${withCounts.toFixed(2)} ms`,
  )
  expect(withCounts - withoutCounts).toBeLessThan(50)
})
