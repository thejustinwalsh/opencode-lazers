import { afterEach, expect, test } from "bun:test"
import { storedGroupHead, storedOwnerHolds, storedWorkload } from "./stored.ts"
import { TaskScheduleOwner } from "./owner.ts"
import { insertTask, openFixture, submitPlan, type Fixture } from "./fixture.ts"

const fixtures: Fixture[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close()
})

test("a task held behind another's checkout is Blocked in the list but needs no owner; a blocked node does", async () => {
  const f = openFixture()
  fixtures.push(f)
  const running = insertTask(f.repository, "running")
  const held = insertTask(f.repository, "held")
  const blocked = insertTask(f.repository, "blocked")
  const plans = [running, held, blocked].map((id, index) => submitPlan(f, `p${index}`, [id]))
  f.repository.atomic((db) => {
    db.query("UPDATE runner_plans SET state='running'").run()
    db.query("UPDATE runner_nodes SET state='running' WHERE task_id=?").run(running)
    db.query("UPDATE runner_nodes SET state='blocked' WHERE task_id=?").run(blocked)
    db.query(
      `INSERT INTO runner_attempts(id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,state,started_at)
       VALUES(?,?,?,1,'w','m','/project',?,NULL,'{}','running',1)`,
    ).run(crypto.randomUUID(), plans[0]!, running, "a".repeat(40))
  })
  const owner = new TaskScheduleOwner(f.repository)
  await owner.settle()
  owner.close()
  f.repository.read((db) => {
    const status = (id: string) =>
      db
        .query<{ status: string; bucket: string; owner_hold: number }, [string]>(
          "SELECT status,bucket,owner_hold FROM task_schedule WHERE task_id=?",
        )
        .get(id)
    expect(status(held)).toEqual({ status: "blocked", bucket: "blocked", owner_hold: 0 })
    expect(status(blocked)).toEqual({ status: "blocked", bucket: "blocked", owner_hold: 1 })
    expect(storedWorkload(db, "/project")).toEqual({ queued: 1, needsYou: 1, failed: 0 })
    expect(storedOwnerHolds(db, "/project")?.map((row) => row.task_id)).toEqual([blocked])
    expect(storedGroupHead(db, "/project", "needs-you", 10)?.rows.map((r) => r.task_id)).toEqual([
      blocked,
    ])
    expect(storedGroupHead(db, "/project", "queued", 10)).toMatchObject({ total: 1 })
    expect(storedGroupHead(db, "/project", "queued", 10)?.rows.map((r) => r.task_id)).toEqual([
      held,
    ])
  })
})
