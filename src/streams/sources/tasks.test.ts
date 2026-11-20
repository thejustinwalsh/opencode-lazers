import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../../test/proposal.ts"
import { meterRepository } from "../../runner/read-meter.fixture.ts"
import { TaskRepository } from "../../storage.ts"
import { TaskReads } from "../../tasks/read.ts"
import { TaskStateFilter } from "../../tasks/state-filter.ts"
import { openStream } from "../client.ts"
import { readerPool, type ReaderPool } from "../pool.ts"
import {
  taskBucketCountsSource,
  taskDependenciesSource,
  taskPlansSource,
  taskScheduleSource,
  taskSessionBucketCountsSource,
  type TaskScheduleFilter,
} from "./tasks.ts"

const PROJECT = "/project"
let directory: string
let repository: TaskRepository
let reads: TaskReads
let pool: ReaderPool
const ids: Record<string, string> = {}

function insertTask(name: string, session = "session-a") {
  const proposal = validProposal()
  proposal.objective = name
  proposal.writeScope = [`src/${name.replaceAll(" ", "-")}/**`]
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

function plan(
  name: string,
  node: string,
  options: { planState?: string; session?: string; priority?: number; after?: string[] } = {},
) {
  const id = insertTask(name, options.session)
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
      ...(options.after ? { afterPlans: options.after } : {}),
      ...(options.priority ? { priority: options.priority } : {}),
    },
    "architect",
  )
  repository.atomic((db) => {
    db.query("UPDATE runner_nodes SET state=? WHERE plan_id=?").run(node, submitted.planID)
    if (options.planState)
      db.query("UPDATE runner_plans SET state=? WHERE id=?").run(
        options.planState,
        submitted.planID,
      )
    db.query(
      "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,?,?,?,?)",
    ).run(submitted.planID, id, 1, "MOVE", JSON.stringify({ to: node }), Date.now())
  })
  ids[name] = id
  ids[`plan:${name}`] = submitted.planID
  return id
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "lazers-tasks-schedule-"))
  repository = new TaskRepository(join(directory, "tasks.sqlite"), PROJECT)
  reads = new TaskReads(repository)
  const states = ["queued", "running", "accepted", "incorporated", "failed", "cancelled"]
  for (let round = 0; round < 6; round++)
    states.forEach((state, i) =>
      plan(`task${round}-${i}`, state, {
        priority: round % 3 ? round : undefined,
        session: i % 2 ? "session-b" : "session-a",
      }),
    )
  plan("heldRunning", "running", { planState: "blocked" })
  plan("cancelledWithPlan", "queued", { planState: "cancelled" })
  plan("successor", "queued", { after: [ids["plan:task0-0"]!] })
  insertTask("unplanned one")
  const retired = insertTask("retired one")
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
async function walk(filter: TaskScheduleFilter, order: "schedule" | "recent", window: number) {
  const stream = openStream(pool, taskScheduleSource, { filter, order, window })
  await stream.ready()
  // Rows are views into the frame: copy fields before the next slide replaces it.
  const copy = () =>
    stream.items.map((row) =>
      Object.fromEntries(
        Object.keys(taskScheduleSource.columns).map((name) => [
          name,
          (row as Record<string, unknown>)[name],
        ]),
      ),
    )
  const seen = copy()
  while (stream.after !== 0) {
    await stream.slide(window)
    const next = copy()
    const last = seen[seen.length - 1]?.task_id
    seen.push(...next.slice(next.findIndex((row) => row.task_id === last) + 1))
  }
  stream.close()
  return seen
}

for (const sort of ["schedule", "recent"] as const)
  test(`walking tasks.schedule (${sort}) by slides gives Tasks.query's tasks in its order, for every state filter`, async () => {
    let compared = 0
    for (const state of [...TaskStateFilter.options, undefined]) {
      const expected = reads.query({ sort, limit: 100, state, includeRetired: false }).tasks
      const actual = await walk({ project: PROJECT, state: state ?? "legacy" }, sort, 4)
      expect(actual.map((row) => row.task_id)).toEqual(expected.map((task) => task.taskID))
      expected.forEach((task, i) => {
        const row = actual[i]!
        expect(row.reference).toBe(task.reference)
        expect(row.objective).toBe(task.objective)
        expect(row.created_at).toBe(task.createdAt)
        expect(row.session_id).toBe(task.sessionID)
        expect(row.revision).toBe(task.revision)
        expect(row.status).toBe(task.status)
        expect(row.node_state ?? undefined).toBe(task.recordedState)
      })
      compared += expected.length
    }
    expect(compared).toBeGreaterThan(100)
  })

test("creator, search and scopePath filters equal the old read", async () => {
  const query = (input: object) =>
    reads
      .query({ sort: "schedule", limit: 100, state: "all", ...input })
      .tasks.map((task) => task.taskID)
  const rows = async (filter: Partial<TaskScheduleFilter>) =>
    (await walk({ project: PROJECT, state: "all", ...filter }, "schedule", 7)).map(
      (row) => row.task_id,
    )
  expect(await rows({ creator: "session-b" })).toEqual(query({ sessionID: "session-b" }))
  expect(await rows({ search: "TASK2-" })).toEqual(query({ search: "TASK2-" }))
  expect(await rows({ search: "unplanned" })).toEqual(query({ search: "unplanned" }))
  expect(await rows({ scopePath: "src/Task1-" })).toEqual(query({ scopePath: "src/Task1-" }))
  expect(await rows({ search: "LZ-1" })).toEqual(query({ search: "LZ-1" }))
  expect((await rows({ search: "no such text anywhere" })).length).toBe(0)
})

test("a task id filter reads one task and another project's tasks never appear", async () => {
  const [first] = reads.query({ sort: "recent", limit: 1, state: "all" }).tasks
  const rows = await walk({ project: PROJECT, state: "all", taskID: first!.taskID }, "recent", 5)
  expect(rows.map((row) => row.task_id)).toEqual([first!.taskID])
  expect(await walk({ project: "/elsewhere", state: "all" }, "recent", 5)).toEqual([])
})

test("dependency children, plans, and bucket counts read as sources", async () => {
  const dependencies = openStream(pool, taskDependenciesSource, {
    filter: { parent: ids.successor! },
    order: "ord",
    window: 10,
  })
  await dependencies.ready()
  expect(dependencies.items.map((row) => [row.child_task_id, row.kind, row.waiting])).toEqual([
    [ids["task0-0"], "after-plan", true],
  ])
  dependencies.close()

  const plans = openStream(pool, taskPlansSource, {
    filter: { project: PROJECT },
    order: "schedule",
    window: 100,
  })
  await plans.ready()
  const prioritized = plans.items
    .filter((row) => (row.priority as number) > 0)
    .map((row) => row.priority as number)
  expect(prioritized).toEqual([...prioritized].sort((a, b) => a - b))
  expect(plans.items.length).toBe(
    repository.read(
      (db) =>
        db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) n FROM runner_plans WHERE project_directory=?",
          )
          .get(PROJECT)!.n,
    ),
  )
  plans.close()

  const counts = openStream(pool, taskBucketCountsSource, {
    filter: { project: PROJECT },
    order: "bucket",
    window: 20,
  })
  await counts.ready()
  const total = counts.items.reduce((sum, row) => sum + (row.n as number), 0)
  expect(total).toBe(reads.query({ sort: "recent", limit: 100, state: "all" }).count)
  for (const row of counts.items)
    if (["running", "accepted", "failed", "cancelled"].includes(row.bucket as string))
      expect(row.n).toBe(
        reads.query({ sort: "recent", limit: 100, state: row.bucket as never }).count,
      )
  counts.close()

  const sessions = openStream(pool, taskSessionBucketCountsSource, {
    filter: { project: PROJECT, session: "session-b" },
    order: "bucket",
    window: 20,
  })
  await sessions.ready()
  expect(sessions.items.reduce((sum, row) => sum + (row.n as number), 0)).toBe(
    reads.query({ sort: "recent", limit: 100, state: "all", sessionID: "session-b" }).count,
  )
  sessions.close()
})

test("a window anchored on a task keeps its place when a priority change re-keys it", async () => {
  const stream = openStream(pool, taskScheduleSource, {
    filter: { project: PROJECT, state: "open" },
    order: "schedule",
    window: 6,
  })
  await stream.ready()
  const target = stream.items[2]!.task_id as string
  const planID = repository.read(
    (db) =>
      db
        .query<{ plan_id: string }, [string]>("SELECT plan_id FROM task_schedule WHERE task_id=?")
        .get(target)!.plan_id,
  )
  repository.atomic((db) =>
    db.query("UPDATE runner_plans SET body=json_set(body,'$.priority',1) WHERE id=?").run(planID),
  )
  await stream.seek({ key: [target] })
  expect(stream.items.some((row) => row.task_id === target)).toBe(true)
  stream.close()
})

test("opening and sliding the list runs no statement on the main repository", async () => {
  const meter = meterRepository(repository)
  try {
    const stream = openStream(pool, taskScheduleSource, {
      filter: { project: PROJECT, state: "all" },
      order: "schedule",
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
})
