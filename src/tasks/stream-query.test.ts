import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
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

const RECORDED = new URL("./stream-query.recorded.json", import.meta.url)

/** A page in the names the fixture chose, without the instants of the run. */
function named(value: unknown, names: Map<string, string>) {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
  const json = JSON.stringify(value, (key, item) =>
    key === "startedAt" || key === "serverTime" || key === "attemptMs" ? undefined : item,
  )
  return JSON.parse(json.replace(UUID, (id) => names.get(id) ?? "<id>"))
}

const QUERIES = {
  all: { state: "all" as const },
  open: { state: "open" as const },
  schedule: { state: "all" as const, sort: "schedule" as const },
  session: { state: "all" as const, sessionID: "session-a" },
  default: {},
}

test("the agent tool page carries what the old read carried, recorded before it was removed", async () => {
  const { f, grind, waiting, held } = await project()
  const names = new Map<string, string>()
  f.repository.read((db) => {
    for (const row of db
      .query<{ id: string; objective: string }, []>(
        "SELECT id,json_extract(body,'$.proposal.objective') AS objective FROM tasks",
      )
      .all())
      names.set(row.id, row.objective)
    for (const row of db
      .query<{ id: string; objective: string }, []>(
        "SELECT id,json_extract(body,'$.objective') AS objective FROM runner_plans",
      )
      .all())
      names.set(row.id, `plan ${row.objective}`)
  })
  const recorded: Record<string, unknown> = JSON.parse(readFileSync(RECORDED, "utf8"))
  for (const [key, query] of Object.entries(QUERIES)) {
    const page = await queryTaskPage(f.repository, { limit: 100, ...query })
    const { nextCursor: _cursor, projectDirectory: _directory, ...shown } = page
    // A task held by a reservation or prerequisite plan counts under Blocked, not Queued
    // (`INTENTIONAL_DIFFERENCES`); `blocked` and `queued` differ from the old counts by that.
    const expected = structuredClone(recorded[key]) as { stateCounts?: Record<string, number> }
    const actual = named(shown, names) as { stateCounts?: Record<string, number> }
    if (expected.stateCounts && actual.stateCounts) {
      expect(actual.stateCounts.blocked! + actual.stateCounts.queued!).toBe(
        expected.stateCounts.blocked! + expected.stateCounts.queued!,
      )
      for (const side of [expected, actual]) {
        delete side.stateCounts!.blocked
        delete side.stateCounts!.queued
      }
    }
    expect({ key, page: actual }).toEqual({ key, page: expected })
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
