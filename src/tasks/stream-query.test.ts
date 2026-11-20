import { afterEach, expect, test } from "bun:test"
import { validProposal } from "../../test/proposal.ts"
import { RecoveryDetector } from "../recovery/detector.ts"
import { HandoffStore } from "../recovery/handoff/store.ts"
import { insertTask, openFixture, submitPlan, type Fixture } from "./schedule/fixture.ts"
import { TaskScheduleOwner } from "./schedule/owner.ts"
import { queryTaskPage } from "./stream-query.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** A project with a plan waiting behind another, a held plan, a struggling task and loose tasks. */
async function project() {
  const f: Fixture = openFixture()
  const owner = new TaskScheduleOwner(f.repository)
  cleanups.push(() => {
    owner.close()
    f.close()
  })
  const loose = insertTask(f.repository, "loose")
  const other = insertTask(f.repository, "other-session", "session-b")
  const first = insertTask(f.repository, "first")
  const waiting = insertTask(f.repository, "waiting")
  const held = insertTask(f.repository, "held")
  const grind = insertTask(f.repository, "grind")
  const calm = insertTask(f.repository, "calm")
  const firstPlan = submitPlan(f, "first", [first])
  const waitingPlan = submitPlan(f, "waiting", [waiting], { afterPlans: [firstPlan] })
  const heldPlan = submitPlan(f, "held", [held])
  const grindPlan = submitPlan(f, "grind", [grind, calm])
  f.reads.runner.setDispatchPause(heldPlan, { reason: "hold", untilPlans: [] }, { caller: "t" })
  const proposal = validProposal()
  f.repository.atomic((db) => {
    db.query("UPDATE runner_plans SET state='running',reason=NULL WHERE id IN (?,?,?)").run(
      firstPlan,
      waitingPlan,
      grindPlan,
    )
    db.query("UPDATE runner_nodes SET state='running',reason=NULL WHERE plan_id=?").run(grindPlan)
    const attempt = (taskID: string, number: number, tokens: number, state: string) =>
      db
        .query(
          `INSERT INTO runner_attempts
          (id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,state,started_at,token_count,tool_count)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          crypto.randomUUID(),
          grindPlan,
          taskID,
          number,
          `w-${taskID}-${number}`,
          `m-${taskID}-${number}`,
          "/worktree",
          "a".repeat(40),
          null,
          "{}",
          state,
          Date.now() - 60_000,
          tokens,
          100,
        )
    attempt(calm, 1, 1_000_000, "running")
    attempt(grind, 1, 40_000_000, "failed")
    attempt(grind, 2, 50_000_000, "running")
    for (let round = 0; round < 3; round++)
      db.query(
        "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,1,'VERIFY','{}',?)",
      ).run(grindPlan, grind, round + 1)
    db.query(
      "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,1,'REPAIR',?,4)",
    ).run(grindPlan, grind, JSON.stringify({ from: "verifying", to: "ready" }))
  })
  new RecoveryDetector({
    store: f.reads.runner,
    handoff: new HandoffStore(f.repository),
    now: Date.now,
  }).evaluate("owner", f.reads.runner.claim("owner", Date.now())!)
  await owner.settle()
  return { f, loose, other, first, waiting, held, grind, calm }
}

const fieldsOfOld = (task: Record<string, unknown>) => {
  const { matches: _matches, ...rest } = task
  return rest
}

test("the agent tool page carries what the old read carried, from stored data", async () => {
  const { f, grind, waiting, held } = await project()
  for (const query of [
    { state: "all" as const },
    { state: "open" as const },
    { state: "all" as const, sort: "schedule" as const },
    { state: "all" as const, sessionID: "session-a" },
    {},
  ]) {
    const old = f.reads.query({ limit: 100, ...query })
    const page = await queryTaskPage(f.repository, { limit: 100, ...query })
    const byID = new Map(page.tasks.map((task) => [task.taskID, task]))
    expect(new Set(byID.keys())).toEqual(new Set(old.tasks.map((task) => task.taskID)))
    for (const task of old.tasks) expect(byID.get(task.taskID)).toEqual(task as never)
    if ("sessionID" in query) {
      // No stored counter is per creating session.
      expect(page.count).toBeUndefined()
      continue
    }
    expect(page.count).toBe(old.count)
    // A task held by a reservation or prerequisite plan counts under Blocked, not Queued
    // (`INTENTIONAL_DIFFERENCES`); every other chip is the old count.
    const { blocked, queued, ...rest } = page.stateCounts!
    const { blocked: oldBlocked, queued: oldQueued, ...oldRest } = old.stateCounts!
    expect(rest).toEqual(oldRest as never)
    expect(blocked! + queued!).toBe(oldBlocked! + oldQueued!)
    expect(page.projectDirectory).toBe(old.projectDirectory)
  }
  const page = await queryTaskPage(f.repository, { limit: 100, state: "all" })
  const find = (id: string) => page.tasks.find((task) => task.taskID === id)!
  expect(find(grind).concern?.totals).toMatchObject({ attempts: 2, verifyRounds: 3 })
  expect(find(waiting).waitingOnPlans?.length).toBe(1)
  expect(find(waiting).waitingOnPlansCount).toBe(1)
  expect(find(held).dispatchPausePlanID).toBeDefined()
})

test("fields no stored counter answers are left out, not scanned", async () => {
  const { f } = await project()
  for (const query of [{ search: "grind" }, { scopePath: "src" }, { includeRetired: true }]) {
    const page = await queryTaskPage(f.repository, { limit: 100, state: "all", ...query })
    expect(page.count).toBeUndefined()
    expect(page.stateCounts).toBeUndefined()
  }
})
