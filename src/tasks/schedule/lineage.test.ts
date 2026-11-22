import { afterAll, beforeAll, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { openStream } from "../../streams/client.ts"
import { acquireReaderPool, type ReaderPoolLease } from "../../streams/pool.ts"
import { taskSessionBucketCountsSource, taskScheduleSource } from "../../streams/sources/tasks.ts"
import { authorizeTask } from "../../streams/sources/trajectory.ts"
import type { StreamContext } from "../../streams/source.ts"
import { installTaskScheduleSchema } from "./schema.ts"
import { backfillPage } from "./backfill.ts"
import { insertTask, openFixture, submitPlan, type Fixture } from "./fixture.ts"

/**
 * The old association read (`sessionAssociations`, `git show a249b42a^:src/observability/associations.ts`)
 * against the stored session links. The old rule's plan expansion (a task a session created or ran
 * lists every task of that task's plans) is left out: the old Tasks list never applied it, and
 * the stored links follow that list.
 */
function oldAssociation(db: Database, project: string, session: string) {
  const tasks = new Set(
    db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM tasks WHERE project_directory=? AND json_extract(body,'$.provenance.sessionID')=?",
      )
      .all(project, session)
      .map((row) => row.id),
  )
  const plans = new Set(
    db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM runner_plans WHERE project_directory=? AND owner=?",
      )
      .all(project, session)
      .map((row) => row.id),
  )
  for (const row of db
    .query<{ id: string }, [string, string, string]>(
      `SELECT c.plan_id AS id FROM runner_continuations c JOIN runner_plans p ON p.id=c.plan_id
       WHERE p.project_directory=? AND (c.session_id=? OR c.parent_id=?)`,
    )
    .all(project, session, session))
    plans.add(row.id)
  for (const plan of plans)
    for (const row of db
      .query<{ task_id: string }, [string]>("SELECT task_id FROM runner_nodes WHERE plan_id=?")
      .all(plan))
      tasks.add(row.task_id)
  return tasks
}

let f: Fixture
let lease: ReaderPoolLease
const ids: Record<string, string> = {}
const PROJECT = "/project"

function renew(previous: string, successor: string, plan: string, generation: number) {
  f.repository.atomic((db) => {
    db.query(
      `INSERT INTO runner_architect_renewals(id,anchor_plan_id,previous_session_id,successor_session_id,
         directory,model,idle_at,generation,state,handoff_message_id,started_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      `r-${successor}`,
      plan,
      previous,
      successor,
      "/w",
      "m",
      0,
      generation,
      "committed",
      "h",
      generation,
    )
    db.query(
      `INSERT INTO runner_continuations(plan_id,session_id,parent_id,directory,model,generation)
       VALUES(?,?,?,?,?,?) ON CONFLICT(plan_id) DO UPDATE SET session_id=excluded.session_id,
       parent_id=excluded.parent_id,generation=excluded.generation`,
    ).run(plan, successor, previous, "/w", "m", generation)
    db.query("UPDATE runner_plans SET owner=? WHERE id=?").run(successor, plan)
  })
}

beforeAll(() => {
  f = openFixture(PROJECT)
  // A three-generation renewal chain: root → gen1 → gen2, which owns the plan now.
  ids.a = insertTask(f.repository, "a", "creator-a")
  ids.b = insertTask(f.repository, "b", "creator-b")
  ids.lineagePlan = submitPlan(f, "lineage", [ids.a, ids.b])
  f.repository.atomic((db) =>
    db.query("UPDATE runner_plans SET owner='root' WHERE id=?").run(ids.lineagePlan!),
  )
  renew("root", "gen1", ids.lineagePlan, 1)
  renew("gen1", "gen2", ids.lineagePlan, 2)
  // A task the root created itself, outside any plan, and one the newest generation created.
  ids.rootTask = insertTask(f.repository, "root-made", "root")
  ids.gen2Task = insertTask(f.repository, "gen2-made", "gen2")
  // A plan launched from another session: its continuation names the launching session.
  ids.c = insertTask(f.repository, "c", "creator-c")
  ids.launchedPlan = submitPlan(f, "launched", [ids.c])
  f.repository.atomic((db) => {
    db.query("UPDATE runner_plans SET owner='worker-owner' WHERE id=?").run(ids.launchedPlan!)
    db.query(
      "INSERT INTO runner_continuations(plan_id,session_id,parent_id,directory,model,generation) VALUES(?,?,?,?,?,1)",
    ).run(ids.launchedPlan!, "worker-owner", "launcher", "/w", "m")
  })
  // A session that both created and owns a task counts it once.
  ids.d = insertTask(f.repository, "d", "both")
  ids.bothPlan = submitPlan(f, "both", [ids.d])
  f.repository.atomic((db) =>
    db.query("UPDATE runner_plans SET owner='both' WHERE id=?").run(ids.bothPlan!),
  )
  lease = acquireReaderPool(f.repository.path, { workers: 1 })
})
afterAll(async () => {
  lease.release()
  f.close()
})

async function listedFor(session: string) {
  const stream = openStream(lease.pool, taskScheduleSource, {
    filter: { project: PROJECT, session, includeRetired: true },
    order: "recent",
    window: 100,
  })
  await stream.ready()
  const rows = stream.items.map((row) => String(row.task_id))
  stream.close()
  return new Set(rows)
}

const SESSIONS = [
  "root",
  "gen1",
  "gen2",
  "creator-a",
  "creator-b",
  "worker-owner",
  "launcher",
  "both",
]
const LINEAGE = ["root", "gen1", "gen2"]

test("each session lists what the old association listed, and every session of a renewal lineage lists what the lineage owns", async () => {
  const old = Object.fromEntries(
    SESSIONS.map((session) => [
      session,
      f.repository.read((db) => oldAssociation(db, PROJECT, session)),
    ]),
  )
  const lineageOwns = new Set(LINEAGE.flatMap((session) => [...old[session]!]))
  for (const session of SESSIONS) {
    const want = LINEAGE.includes(session) ? lineageOwns : old[session]!
    expect({ session, tasks: [...(await listedFor(session))].sort() }).toEqual({
      session,
      tasks: [...want].sort(),
    })
  }
  // The old rule left the root, two renewals back, with nothing of the plan it handed on.
  expect(old.root!.has(ids.a!)).toBe(false)
  expect([...lineageOwns].sort()).toEqual([ids.a!, ids.b!, ids.rootTask!, ids.gen2Task!].sort())
  expect(old.launcher!.has(ids.c!)).toBe(true)
})

test("session counts are per lineage and count a task once", async () => {
  const counts = async (session: string) => {
    const stream = openStream(lease.pool, taskSessionBucketCountsSource, {
      filter: { project: PROJECT, session },
      order: "bucket",
      window: 20,
    })
    await stream.ready()
    const total = stream.items.reduce((sum, row) => sum + Number(row.n), 0)
    stream.close()
    return total
  }
  expect(await counts("both")).toBe(1)
  for (const session of LINEAGE) expect(await counts(session)).toBe(4)
})

test("a trajectory read of a lineage task is authorized for every session of the lineage", async () => {
  const context = (sessionID: string) =>
    ({
      projectDirectory: PROJECT,
      assertAction: async () => {},
      read: (fn: (db: Database) => unknown) => f.repository.read(fn),
    }) as unknown as StreamContext
  for (const session of LINEAGE)
    await expect(
      authorizeTask(
        { scope: { kind: "session", sessionID: session }, taskID: ids.a! } as never,
        context(session),
      ),
    ).resolves.toBeDefined()
  await expect(
    authorizeTask(
      { scope: { kind: "session", sessionID: "creator-c" }, taskID: ids.a! } as never,
      context("creator-c"),
    ),
  ).rejects.toThrow()
})

test("renewals arriving in any order and a full rebuild store the same lineage keys", () => {
  const snapshot = () =>
    f.repository.read((db) => ({
      lineage: db.query("SELECT * FROM task_schedule_lineage ORDER BY 1").all(),
      links: db.query("SELECT * FROM task_schedule_sessions ORDER BY 1,2,3").all(),
    }))
  const before = snapshot()
  expect(before.lineage).toEqual([
    { session_id: "gen1", root_session_id: "root" },
    { session_id: "gen2", root_session_id: "root" },
  ])
  f.repository.atomic((db) => {
    installTaskScheduleSchema(db)
    while (!backfillPage(db, PROJECT, 2).done);
  })
  expect(snapshot()).toEqual(before)
  // The newer renewal first: the older one re-keys it when it arrives.
  f.repository.atomic((db) => {
    db.query("DELETE FROM task_schedule_lineage").run()
    db.query("UPDATE task_schedule_sessions SET lineage_key=session_id").run()
  })
  const { refreshLineage } = require("./lineage.ts") as typeof import("./lineage.ts")
  f.repository.atomic((db) => {
    refreshLineage(db, "r-gen2")
    refreshLineage(db, "r-gen1")
  })
  expect(snapshot()).toEqual(before)
})
