import { afterAll, beforeAll, expect, test } from "bun:test"
import { setPause } from "../../projects/pause.ts"
import { openStream } from "../../streams/client.ts"
import { acquireReaderPool, type ReaderPoolLease } from "../../streams/pool.ts"
import { taskBucketCountsSource, taskScheduleSource } from "../../streams/sources/tasks.ts"
import { taskRowPresentation } from "../row-presentation.ts"
import { listRowOf } from "../task-row.ts"
import { TaskStateSelection } from "../state-filter.ts"
import { insertTask, openFixture, submitPlan, type Fixture } from "./fixture.ts"
import { bucketsForSelection } from "./key.ts"

/**
 * The Tasks list against a project shaped like the live one (2026-11-21, opencode-lazers): 256
 * tasks, of which 162 accepted, 160 of those on integrated plans and 2 on a blocked plan; 4
 * queued on a running plan under a dispatch pause; cancelled tasks with and without a plan
 * (cancelled, accepted, failed and running nodes of cancelled plans); unplanned open tasks; and
 * retired (disposed) tasks among the unplanned and the cancelled.
 */
let f: Fixture
// Held as the service holds it, so the tools' own leases never close it.
let lease: ReaderPoolLease
const expected = { integrated: 0, accepted: 0, paused: 0, cancelled: 0, open: 0 }

function retire(taskID: string) {
  f.repository.atomic((db) =>
    db
      .query(
        `INSERT INTO task_dispositions(project_directory,task_id,request_id,payload,disposition,reason,evidence,related_task_ids,session_id,agent,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        f.repository.projectDirectory,
        taskID,
        `retire-${taskID}`,
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
}

function planOf(name: string, nodes: string[], planState: string) {
  const tasks = nodes.map((_, i) => insertTask(f.repository, `${name}-${i}`))
  const planID = submitPlan(f, name, tasks)
  f.repository.atomic((db) => {
    tasks.forEach((task, i) =>
      db
        .query("UPDATE runner_nodes SET state=? WHERE plan_id=? AND task_id=?")
        .run(nodes[i]!, planID, task),
    )
    db.query("UPDATE runner_plans SET state=? WHERE id=?").run(planState, planID)
  })
  return tasks
}

beforeAll(() => {
  f = openFixture()
  // 160 accepted tasks on integrated plans, in plans of one to four tasks.
  for (let i = 0; i < 40; i++) planOf(`integrated${i}`, Array(4).fill("accepted"), "integrated")
  expected.integrated = 160
  // Two accepted tasks of a plan held Blocked (awaiting integration).
  planOf("held", ["accepted", "accepted"], "blocked")
  expected.accepted = 2
  // Four queued tasks of a running plan under a dispatch pause.
  planOf("paused", ["queued", "queued", "queued", "queued"], "running")
  setPause(f.repository, { kind: "global" }, { paused: true, reason: "hold", by: "owner" })
  expected.paused = 4
  // Cancelled: cancelled nodes; accepted, failed and running nodes of cancelled plans.
  const cancelled = [
    ...planOf("cancelled-a", Array(11).fill("cancelled"), "cancelled"),
    ...planOf("cancelled-b", Array(5).fill("accepted"), "cancelled"),
    ...planOf("cancelled-c", ["failed", "running"], "cancelled"),
  ]
  // Cancelled and retired (a disposition), with and without a plan.
  cancelled.slice(0, 6).forEach(retire)
  expected.cancelled = cancelled.length - 6
  // Unplanned open tasks: five retired, three listed.
  const unplanned = Array.from({ length: 8 }, (_, i) => insertTask(f.repository, `loose${i}`))
  unplanned.slice(0, 5).forEach(retire)
  expected.open = 3
  lease = acquireReaderPool(f.repository.path, { workers: 1 })
})
afterAll(async () => {
  lease.release()
  f.close()
})

async function listed(states: readonly string[]) {
  const stream = openStream(lease.pool, taskScheduleSource, {
    filter: { project: f.repository.projectDirectory, states: states as never },
    order: "schedule",
    window: 500,
  })
  await stream.ready()
  const rows = stream.items.map((row) => ({
    task_id: row.task_id as string,
    bucket: row.bucket as string,
    node_state: row.node_state as string | null,
    plan_state: row.plan_state as string | null,
  }))
  stream.close()
  return rows
}

const perBucket: Record<string, number> = {}

test("each state selection lists its stored tasks, and Integrated holds the accepted tasks of integrated plans", async () => {
  Object.assign(perBucket, {
    integrated: expected.integrated,
    accepted: expected.accepted,
    paused: expected.paused,
    cancelled: expected.cancelled,
    open: expected.open,
  })
  for (const state of TaskStateSelection.options) {
    const buckets = bucketsForSelection([state])!
    const want = buckets.reduce((sum, bucket) => sum + (perBucket[bucket] ?? 0), 0)
    expect({ state, n: (await listed([state])).length }).toEqual({ state, n: want })
  }
  const integrated = await listed(["integrated"])
  expect(
    integrated.every((row) => row.node_state === "accepted" && row.plan_state === "integrated"),
  ).toBe(true)
  const accepted = await listed(["accepted"])
  expect(accepted.map((row) => row.plan_state)).toEqual(["blocked", "blocked"])
  // Every union lists the sum of its buckets; All lists every task not retired.
  const total = Object.values(perBucket).reduce((a, b) => a + b, 0)
  expect((await listed([])).length).toBe(total)
  expect((await listed(["completed", "cancelled"])).length).toBe(
    expected.integrated + expected.accepted + expected.cancelled,
  )
  expect((await listed(["open", "integrated"])).length).toBe(
    expected.open + expected.paused + expected.integrated,
  )
})

test("the stored bucket counters equal the listed rows", async () => {
  const counts = openStream(lease.pool, taskBucketCountsSource, {
    filter: { project: f.repository.projectDirectory },
    order: "bucket",
    window: 20,
  })
  await counts.ready()
  const got = Object.fromEntries(
    counts.items.filter((row) => (row.n as number) > 0).map((row) => [row.bucket, row.n]),
  )
  counts.close()
  expect(got).toEqual(perBucket)
})

test("the list orders integrated after accepted, and a row of an integrated plan shows Integrated", async () => {
  const all = await listed([])
  const order = [...new Set(all.map((row) => row.bucket))]
  expect(order.indexOf("accepted")).toBeLessThan(order.indexOf("integrated"))
  expect(order.indexOf("integrated")).toBeLessThan(order.indexOf("cancelled"))
  const columns = (node: string, plan: string) => (column: string) =>
    ({ node_state: node, plan_state: plan, status: node, objective: "t" })[column]
  expect(taskRowPresentation(listRowOf(columns("accepted", "integrated"), "t1")).label).toBe(
    "Integrated",
  )
  expect(taskRowPresentation(listRowOf(columns("accepted", "blocked"), "t2")).label).toBe(
    "Accepted",
  )
})

test("the agent tools page the whole list, count every chip and read a retired task", async () => {
  const { queryTaskPage, getTaskDetail } = await import("../stream-query.ts")
  for (const sort of ["recent", "schedule"] as const)
    for (const filter of [
      { state: "all" as const },
      { states: ["integrated" as const] },
      { states: ["open" as const, "cancelled" as const] },
      { state: "all" as const, includeRetired: true },
    ]) {
      const seen: string[] = []
      let cursor: string | undefined
      let first: Awaited<ReturnType<typeof queryTaskPage>> | undefined
      do {
        const page = await queryTaskPage(f.repository, {
          ...filter,
          sort,
          limit: 37,
          ...(cursor ? { cursor } : {}),
        })
        first ??= page
        seen.push(...page.tasks.map((task) => task.taskID))
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      const want = filter.includeRetired
        ? f.repository.read(
            (db) => db.query<{ n: number }, []>("SELECT COUNT(*) n FROM task_schedule").get()!.n,
          )
        : (await listed("states" in filter ? filter.states! : [])).length
      expect({ sort, filter, n: seen.length, unique: new Set(seen).size }).toEqual({
        sort,
        filter,
        n: want,
        unique: want,
      })
      if (!filter.includeRetired) expect(first!.count).toBe(want)
    }
  const page = await queryTaskPage(f.repository, { state: "all", limit: 1 })
  expect(page.stateCounts).toMatchObject({
    integrated: expected.integrated,
    accepted: expected.accepted,
    paused: expected.paused,
    cancelled: expected.cancelled,
    open: expected.open + expected.paused,
  })
  const retired = f.repository.read(
    (db) =>
      db
        .query<{ reference: string }, []>(
          "SELECT reference FROM task_schedule WHERE retired=1 AND plan_id IS NULL LIMIT 1",
        )
        .get()!.reference,
  )
  const detail = await getTaskDetail(f.repository, { taskID: retired })
  expect(detail.status).toBe("found")
})
