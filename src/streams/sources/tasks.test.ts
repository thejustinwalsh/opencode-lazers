import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../../test/proposal.ts"
import { meterRepository } from "../../runner/read-meter.fixture.ts"
import { TaskRepository } from "../../storage.ts"
import { TaskReads } from "../../tasks/read.ts"
import { TaskStateFilter, type TaskQueryState } from "../../tasks/state-filter.ts"
import { openStream } from "../client.ts"
import { readerPool, type ReaderPool } from "../pool.ts"
import { tasksListSource, type TasksListFilter } from "./tasks.ts"

const PROJECT = "/project"
let directory: string
let repository: TaskRepository
let reads: TaskReads
let pool: ReaderPool

function insertTask(name: string, session = "session-a") {
  const proposal = validProposal()
  proposal.objective = `${name} ${"é".repeat(name.length % 3)}`
  return repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: "2026-10-31T00:00:00.000Z",
    provenance: {
      projectID: "global",
      projectDirectory: PROJECT,
      workspaceDirectory: "/worktree",
      sessionID: session,
      startingRevision: { kind: "unborn" },
    },
    proposal,
  }).id
}

function plan(name: string, node: string, planState?: string) {
  const id = insertTask(name, name.startsWith("other") ? "session-b" : "session-a")
  const submitted = reads.runner.submit(
    {
      requestID: `list-${name}`,
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
    db.query("UPDATE runner_nodes SET state=? WHERE plan_id=?").run(node, submitted.planID)
    if (planState)
      db.query("UPDATE runner_plans SET state=? WHERE id=?").run(planState, submitted.planID)
  })
  return id
}

let retired: string
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "lazers-tasks-list-"))
  repository = new TaskRepository(join(directory, "tasks.sqlite"), PROJECT)
  reads = new TaskReads(repository)
  const states = ["queued", "running", "accepted", "incorporated", "failed", "cancelled"]
  for (let round = 0; round < 6; round++)
    states.forEach((state, i) => plan(`task${round}-${i}`, state))
  plan("heldRunning", "running", "blocked")
  plan("cancelledWithPlan", "queued", "cancelled")
  insertTask("unplanned one")
  retired = insertTask("retired one")
  repository.atomic((db) =>
    db
      .query(
        `INSERT INTO task_dispositions(project_directory,task_id,request_id,payload,disposition,reason,evidence,related_task_ids,session_id,agent,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        PROJECT,
        retired,
        "r1",
        "{}",
        "superseded",
        "Replaced",
        "[]",
        "[]",
        "s",
        "a",
        "2026-10-31T00:00:00.000Z",
      ),
  )
  insertTask("last unplanned")
  pool = readerPool(repository.path, { workers: 1 })
})
afterAll(async () => {
  await pool.close()
  repository.close()
  rmSync(directory, { recursive: true, force: true })
})

/** Walk a stream from the head to the end, one window per slide. */
async function walk(filter: TasksListFilter, window: number) {
  const stream = openStream(pool, tasksListSource, { filter, order: "recent", window })
  await stream.ready()
  const read = () =>
    stream.items.map((row) => ({
      id: row.id as string,
      nodeState: row.nodeState,
      reference: row.reference,
      objective: row.objective as string,
      createdAt: row.createdAt,
      sessionID: row.sessionID,
      revision: row.revision,
      dispositionReason: row.dispositionReason,
    }))
  const seen = read()
  while (stream.after !== 0) {
    await stream.slide(window)
    const next = read()
    const last = seen[seen.length - 1]?.id
    seen.push(...next.slice(next.findIndex((row) => row.id === last) + 1))
  }
  stream.close()
  return seen
}

const combos: { state?: TaskQueryState; includeRetired?: boolean }[] = [
  {},
  { includeRetired: true },
  ...TaskStateFilter.options.flatMap((state) => [{ state }, { state, includeRetired: true }]),
]

test("walking the stream by slides gives Tasks.query's tasks in its order, for every state filter", async () => {
  let compared = 0
  for (const combo of combos) {
    const expected = reads.query({
      sort: "recent",
      limit: 100,
      state: combo.state,
      includeRetired: combo.includeRetired ?? false,
    }).tasks
    const actual = await walk({ projectDirectory: PROJECT, ...combo }, 4)
    expect(actual.map((row) => row.id)).toEqual(expected.map((task) => task.taskID))
    expected.forEach((task, i) => {
      const row = actual[i]!
      expect(row.reference).toBe(task.reference)
      expect(row.objective).toBe(task.objective)
      expect((row.objective as string).slice(0, 400)).toBe(task.objective)
      expect(row.createdAt).toBe(task.createdAt)
      expect(row.sessionID).toBe(task.sessionID)
      expect(row.revision).toBe(task.revision)
      expect(row.nodeState ?? undefined).toBe(task.recordedState)
      expect(row.dispositionReason ?? undefined).toBe(task.disposition?.reason)
    })
    compared += expected.length
  }
  expect(compared).toBeGreaterThan(100)
})

test("a task id filter reads one task", async () => {
  const [first] = reads.query({ sort: "recent", limit: 1, state: "all" }).tasks
  const rows = await walk({ projectDirectory: PROJECT, state: "all", taskID: first!.taskID }, 5)
  expect(rows.map((row) => row.id)).toEqual([first!.taskID])
})

test("another project's tasks never appear", async () => {
  expect(await walk({ projectDirectory: "/elsewhere", state: "all" }, 5)).toEqual([])
})

test("opening and sliding the list runs no statement on the main repository", async () => {
  const meter = meterRepository(repository)
  try {
    const stream = openStream(pool, tasksListSource, {
      filter: { projectDirectory: PROJECT, state: "all" },
      order: "recent",
      window: 10,
    })
    await stream.ready()
    await stream.slide(10)
    await stream.seek("tail")
    expect(stream.items.length).toBeGreaterThan(0)
    stream.close()
  } finally {
    meter.stop()
  }
  expect(meter.statements).toEqual([])
  // The meter sees main-thread reads: the old query path is not free.
  const old = meterRepository(repository)
  reads.query({ sort: "recent", limit: 10, state: "all" })
  old.stop()
  expect(old.statements.length).toBeGreaterThan(0)
})
