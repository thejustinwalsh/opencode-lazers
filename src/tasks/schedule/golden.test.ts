import { afterEach, expect, test } from "bun:test"
import { validProposal } from "../../../test/proposal.ts"
import { expectProjection, projectedIDs } from "./parity.fixture.ts"
import { installTaskScheduleSchema } from "./schema.ts"
import { backfillPage } from "./backfill.ts"
import { insertTask, openFixture, submitPlan } from "./fixture.ts"
import type { Fixture } from "./fixture.ts"

const fixtures: Fixture[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close()
})

/**
 * The order the Tasks list has always shown for this mix (the recorded expectation of
 * `src/tasks/read-order.test.ts`): running, then open work by priority and plan order, unplanned
 * work, then finished work newest first, failed, cancelled.
 */
const GOLDEN = [
  "run1",
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

type Spec = {
  node: string
  priority?: number
  finished?: number
  planState?: string
  planTransition?: number
}

function seed() {
  const f = openFixture()
  fixtures.push(f)
  const ids: Record<string, string> = {}
  const planned = (name: string, spec: Spec) => {
    const id = insertTask(f.repository, name)
    const plan = submitPlan(f, name, [id])
    f.repository.atomic((db) => {
      db.query("UPDATE runner_nodes SET state=? WHERE plan_id=?").run(spec.node, plan)
      if (spec.priority !== undefined)
        db.query("UPDATE runner_plans SET body=json_set(body,'$.priority',?) WHERE id=?").run(
          spec.priority,
          plan,
        )
      if (spec.planState)
        db.query("UPDATE runner_plans SET state=? WHERE id=?").run(spec.planState, plan)
      const record = (taskID: string | null, to: string, at: number) =>
        db
          .query(
            "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,?,?,?,?)",
          )
          .run(plan, taskID, 1, "MOVE", JSON.stringify({ from: "queued", to }), at)
      if (spec.finished !== undefined) record(id, spec.node, spec.finished)
      if (spec.planTransition !== undefined) record(null, "cancelled", spec.planTransition)
    })
    ids[name] = id
  }
  planned("fail1", { node: "failed", finished: 10 })
  planned("acc1", { node: "accepted", priority: 1, finished: 100 })
  planned("openA", { node: "queued", priority: 2 })
  planned("cancel1", { node: "cancelled", finished: 5 })
  planned("integ1", { node: "incorporated", finished: 50 })
  ids.U1 = insertTask(f.repository, "U1")
  planned("openC", { node: "queued" })
  planned("acc2", { node: "accepted", priority: 5, finished: 200 })
  planned("run1", { node: "running", priority: 3 })
  planned("openB", { node: "queued", priority: 1 })
  planned("acc3", { node: "accepted", priority: 2, finished: 200 })
  planned("cancel2", { node: "queued", planState: "cancelled", planTransition: 300 })
  ids.U2 = insertTask(f.repository, "U2")
  planned("heldRunning", { node: "running", priority: 1, planState: "blocked" })
  return { f, ids }
}

test("golden: the stored order is the recorded order of the mixed fixture", () => {
  const { f, ids } = seed()
  const names = new Map(Object.entries(ids).map(([name, id]) => [id, name]))
  expect(projectedIDs(f.repository, "all", "schedule").map((id) => names.get(id))).toEqual(GOLDEN)
  expectProjection("golden", f.repository)
})

test("a reservation-blocked task counts under Blocked: the one deliberate chip difference", () => {
  const { f, ids } = seed()
  // run1 holds the checkout (an active shared attempt); openB, queued in a running plan, waits.
  f.repository.atomic((db) => {
    db.query("UPDATE runner_plans SET state='running'").run()
    db.query(
      `INSERT INTO runner_attempts(id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,state,started_at)
       SELECT ?,plan_id,task_id,1,'w','m','/project',?, NULL,'{}','running',1 FROM runner_nodes WHERE task_id=?`,
    ).run(crypto.randomUUID(), "a".repeat(40), ids.run1!)
  })
  const row = f.repository.read((db) =>
    db
      .query<{ status: string; bucket: string; blocker_count: number }, [string]>(
        "SELECT status,bucket,blocker_count FROM task_schedule WHERE task_id=?",
      )
      .get(ids.openB!),
  )
  expect(row).toEqual({ status: "blocked", bucket: "blocked", blocker_count: 1 })
  // The old Queued filter listed it; the stored Queued chip does not.
  expect(projectedIDs(f.repository, "queued", "schedule")).not.toContain(ids.openB!)
  expectProjection("golden/reservation", f.repository)
  void validProposal
})

test("a missing trigger shows up as a divergence (the guard guards)", () => {
  const { f } = seed()
  const rows = () =>
    f.repository.read((db) => db.query("SELECT * FROM task_schedule ORDER BY seq").all())
  f.repository.atomic((db) => {
    for (const row of db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'task_schedule_q_runner_nodes_update%'",
      )
      .all())
      db.exec(`DROP TRIGGER ${row.name}`)
    db.query("UPDATE runner_nodes SET state='failed' WHERE state='running'").run()
  })
  // Without its trigger the row is stale: a full rebuild changes it.
  const stale = rows()
  f.repository.atomic((db) => {
    installTaskScheduleSchema(db)
    while (!backfillPage(db, f.repository.projectDirectory, 50).done);
  })
  expect(rows()).not.toEqual(stale)
})
