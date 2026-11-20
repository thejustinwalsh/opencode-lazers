import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../../test/proposal.ts"
import { meterRepository } from "../../runner/read-meter.fixture.ts"
import { TaskRepository } from "../../storage.ts"
import { TaskReads } from "../../tasks/read.ts"
import { bucketsFor } from "../../tasks/schedule/key.ts"
import { TaskStateFilter } from "../../tasks/state-filter.ts"
import { openStream } from "../client.ts"
import { readerPool, type ReaderPool } from "../pool.ts"
import {
  taskBucketCountsSource,
  taskDependenciesSource,
  taskPlansSource,
  taskScheduleSource,
  taskSessionBucketCountsSource,
} from "./tasks.ts"
import type { TaskScheduleFilter } from "./tasks-ref.ts"

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

/** The stored rows of a chip in a sort's order, read straight from the projection table. */
function stored(sort: "schedule" | "recent", state: string, extra = "", ...params: string[]) {
  const buckets = bucketsFor(state) ?? []
  return repository.read((db) =>
    db
      .query<Record<string, unknown>, string[]>(
        `SELECT * FROM task_schedule WHERE project_directory=? AND retired=0
         ${buckets.length ? `AND bucket IN (${buckets.map(() => "?").join(",")})` : ""} ${extra}
         ORDER BY ${sort === "schedule" ? "sort_key, task_id" : "seq DESC, task_id"}`,
      )
      .all(PROJECT, ...buckets, ...params),
  )
}

for (const sort of ["schedule", "recent"] as const)
  test(`walking tasks.schedule (${sort}) by slides gives the stored rows in order, for every state filter`, async () => {
    let compared = 0
    for (const state of [...TaskStateFilter.options, undefined]) {
      const expected = stored(sort, state ?? "legacy")
      const actual = await walk({ project: PROJECT, state: state ?? "legacy" }, sort, 4)
      expect(actual.map((row) => row.task_id)).toEqual(expected.map((row) => row.task_id))
      expected.forEach((task, i) => {
        const row = actual[i]!
        for (const column of ["reference", "objective", "created_at", "session_id", "status"])
          expect(row[column]).toBe(task[column])
        expect(row.revision).toBe(task.revision)
        expect(row.node_state ?? null).toBe((task.node_state ?? null) as never)
      })
      compared += expected.length
    }
    expect(compared).toBeGreaterThan(100)
  })

test("creator, search and scopePath filters list the stored rows they name", async () => {
  const query = (input: { sessionID?: string; search?: string; scopePath?: string }) =>
    input.sessionID
      ? stored("schedule", "all", "AND session_id=?", input.sessionID).map((row) => row.task_id)
      : input.search
        ? stored(
            "schedule",
            "all",
            "AND instr(search_text, ?) > 0",
            input.search.toLowerCase(),
          ).map((row) => row.task_id)
        : stored(
            "schedule",
            "all",
            "AND EXISTS (SELECT 1 FROM task_schedule_scopes c WHERE c.task_id=task_schedule.task_id AND instr(lower(c.path), ?) > 0)",
            input.scopePath!.toLowerCase(),
          ).map((row) => row.task_id)
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
  const first = stored("recent", "all")[0]!
  const rows = await walk(
    { project: PROJECT, state: "all", taskID: first.task_id as string },
    "recent",
    5,
  )
  expect(rows.map((row) => row.task_id)).toEqual([first.task_id])
  expect(await walk({ project: "/elsewhere", state: "all" }, "recent", 5)).toEqual([])
})

test("dependency children, plans, and bucket counts read as sources", async () => {
  const dependencies = openStream(pool, taskDependenciesSource, {
    filter: { project: PROJECT, parent: ids.successor! },
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
  expect(total).toBe(stored("recent", "all").length)
  for (const row of counts.items)
    if (["running", "accepted", "failed", "cancelled"].includes(row.bucket as string))
      expect(row.n).toBe(stored("recent", row.bucket as string).length)
  counts.close()

  const sessions = openStream(pool, taskSessionBucketCountsSource, {
    filter: { project: PROJECT, session: "session-b" },
    order: "bucket",
    window: 20,
  })
  await sessions.ready()
  expect(sessions.items.reduce((sum, row) => sum + (row.n as number), 0)).toBe(
    stored(
      "recent",
      "all",
      "AND EXISTS (SELECT 1 FROM task_schedule_sessions s WHERE s.task_id=task_schedule.task_id AND s.session_id=?)",
      "session-b",
    ).length,
  )
  sessions.close()
})

test("dependents read through the child index, and plans read by a list of ids", async () => {
  const dependents = openStream(pool, taskDependenciesSource, {
    filter: { project: PROJECT, task: ids["task0-0"]! },
    order: "ord",
    window: 10,
  })
  await dependents.ready()
  expect(dependents.items.map((row) => row.parent_task_id)).toEqual([ids.successor])
  dependents.close()

  const all = openStream(pool, taskPlansSource, {
    filter: { project: PROJECT },
    order: "schedule",
    window: 100,
  })
  await all.ready()
  const wanted = all.items.slice(0, 2).map((row) => row.plan_id as string)
  all.close()
  const some = openStream(pool, taskPlansSource, {
    filter: { project: PROJECT, planIDs: wanted },
    order: "schedule",
    window: 10,
  })
  await some.ready()
  expect(some.items.map((row) => row.plan_id)).toEqual(wanted)
  some.close()
})

test("the tasks of one plan read in plan order", async () => {
  const planned = (await walk({ project: PROJECT, state: "all" }, "recent", 50)).find(
    (row) => row.plan_id,
  )!
  const plan_id = planned.plan_id
  const stream = openStream(pool, taskScheduleSource, {
    filter: { project: PROJECT, state: "all", planID: plan_id as string },
    order: "plan",
    window: 20,
  })
  await stream.ready()
  expect(stream.items.length).toBeGreaterThan(0)
  const ordinals = stream.items.map((row) => row.ordinal as number)
  expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b))
  expect(new Set(stream.items.map((row) => row.plan_id))).toEqual(new Set([plan_id]))
  stream.close()
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

// ---- authorize: the scope checks of the reads these sources replace -----------------------------

function context(overrides: Partial<import("../source.ts").StreamContext> = {}) {
  const asserted: string[] = []
  return {
    asserted,
    value: {
      projectID: "p",
      projectDirectory: PROJECT,
      projectIds: (id: string) => [id],
      read: (run) => repository.read(run),
      assertRead: async (sessionID: string) => {
        asserted.push(sessionID)
        if (sessionID === "stranger") throw new Error("Task scope is unavailable")
      },
      ...overrides,
    } satisfies import("../source.ts").StreamContext,
  }
}

test("authorize checks the caller, overwrites the project and forces the session link", async () => {
  const c = context()
  const forced = await taskScheduleSource.authorize!(
    {
      project: "/elsewhere",
      scope: { kind: "session", sessionID: "session-b" },
      session: "session-a",
      state: "all",
    },
    c.value,
  )
  expect(c.asserted).toEqual(["session-b"])
  expect(forced).toMatchObject({ project: PROJECT, session: "session-b" })
  const project = await taskScheduleSource.authorize!(
    {
      project: "/elsewhere",
      scope: { kind: "project", sessionID: "session-a" },
      session: "session-b",
    },
    c.value,
  )
  expect(project.project).toBe(PROJECT)
  expect(project.session).toBeUndefined()
  await expect(
    taskScheduleSource.authorize!(
      { project: PROJECT, scope: { kind: "project", sessionID: "stranger" } },
      c.value,
    ),
  ).rejects.toThrow("Task scope is unavailable")
  await expect(taskScheduleSource.authorize!({ project: PROJECT }, c.value)).rejects.toThrow(
    "names its scope",
  )
})

test("a child read of a task outside the session view lists nothing, with no statement on the main repository", async () => {
  const c = context()
  // task0-1 is a session-b task; task0-0 is session-a (see the seed above).
  const scoped = async (
    scope: { kind: "session" | "project"; sessionID: string },
    parent: string,
  ) => {
    const filter = await taskDependenciesSource.authorize!({ scope, parent }, c.value)
    const stream = openStream(pool, taskDependenciesSource, { filter, order: "ord", window: 10 })
    await stream.ready()
    const count = stream.items.length
    stream.close()
    return { filter, count }
  }
  const session = { kind: "session", sessionID: "session-a" } as const
  const meter = meterRepository(repository)
  try {
    expect((await scoped(session, ids.successor!)).filter).toMatchObject({
      project: PROJECT,
      session: "session-a",
    })
    expect((await scoped(session, ids.successor!)).count).toBe(1)
    // The successor is a session-a task; a session-b task of the same shape lists nothing.
    const other = repository.read(
      (db) =>
        db
          .query<{ parent_task_id: string }, []>(
            `SELECT e.parent_task_id FROM task_schedule_edges e
             WHERE NOT EXISTS (SELECT 1 FROM task_schedule_sessions s
                               WHERE s.task_id=e.parent_task_id AND s.session_id='session-a')`,
          )
          .all()[0]?.parent_task_id,
    )
    if (other) expect((await scoped(session, other)).count).toBe(0)
    expect((await scoped(session, crypto.randomUUID())).count).toBe(0)
    const project = await scoped({ kind: "project", sessionID: "session-a" }, ids.successor!)
    expect(project.count).toBe(1)
    expect((project.filter as { session?: string }).session).toBeUndefined()
  } finally {
    meter.stop()
  }
  // Opening a child stream reads nothing on the main thread: the scope is in the filter.
  expect(meter.statements.filter((s) => s.includes("FROM task_schedule t WHERE"))).toEqual([])
  await expect(taskDependenciesSource.authorize!({ scope: session }, c.value)).rejects.toThrow(
    "names its task",
  )
})

test("plans and counts follow the same scope", async () => {
  const c = context()
  const plans = await taskPlansSource.authorize!(
    { project: "/x", scope: { kind: "session", sessionID: "session-a" } },
    c.value,
  )
  expect(plans).toMatchObject({ project: PROJECT, session: "session-a" })
  await expect(
    taskBucketCountsSource.authorize!(
      { project: PROJECT, scope: { kind: "session", sessionID: "session-a" } },
      c.value,
    ),
  ).rejects.toThrow("session counts")
  await expect(
    taskSessionBucketCountsSource.authorize!(
      { project: PROJECT, scope: { kind: "project", sessionID: "session-a" } },
      c.value,
    ),
  ).rejects.toThrow("project counts")
})
