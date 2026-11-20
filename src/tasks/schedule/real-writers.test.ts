import { expect, test } from "bun:test"
import { setPause } from "../../projects/pause.ts"
import { git } from "../../runner/artifacts.ts"
import {
  cancelUnstartedPlan,
  drive,
  driveWithTaskSourceLandings,
  fixture,
  includeArtifact,
  recordPlanIntegration,
  runPlan,
  useRuntimeFixtureCleanup,
} from "../../runner/runtime.fixture.ts"
import { TaskReads } from "../read.ts"
import { backfillPage } from "./backfill.ts"
import { expectProjection } from "./parity.ts"
import { installTaskScheduleSchema } from "./schema.ts"

useRuntimeFixtureCleanup()

const TABLES = [
  "task_schedule",
  "task_schedule_plans",
  "task_schedule_edges",
  "task_schedule_blockers",
  "task_schedule_waits",
  "task_schedule_sessions",
  "task_schedule_scopes",
  "task_schedule_counts",
]

type F = ReturnType<typeof fixture>

/** Everything the projection stores, ordered, with the incremental-only bookkeeping removed. */
const snapshot = (f: F) =>
  f.repository.read((db) =>
    Object.fromEntries(
      TABLES.map((table) => [
        table,
        db
          .query<Record<string, unknown>, []>(
            `SELECT * FROM ${table} ${table === "task_schedule_counts" ? "WHERE n<>0" : ""} ORDER BY 1,2`,
          )
          .all()
          // The watermark only bounds a scan; hot transitions advance it without a refresh.
          .map(({ transition_mark: _mark, ...row }) => row),
      ]),
    ),
  )

/**
 * After a step of a real writer: nothing is queued, the incremental rows equal a full rebuild, and
 * the stored list equals what the old `Tasks.query` showed, recorded before it was removed.
 */
const scenarios = new WeakMap<object, number>()
let scenarioCount = 0
/** A stable name for each test's fixture: the order the tests run in. */
const scenarioOf = (f: F) => {
  if (!scenarios.has(f)) scenarios.set(f, ++scenarioCount)
  return `scenario ${scenarios.get(f)}`
}
function check(f: F, label: string) {
  const queued = f.repository.read(
    (db) => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_schedule_dirty").get()!.n,
  )
  const parked = f.repository.read(
    (db) => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_schedule_failed").get()!.n,
  )
  expect({ label, queued, parked }).toEqual({ label, queued: 0, parked: 0 })
  expectProjection(`${scenarioOf(f)}/${label}`, f.repository, new TaskReads(f.repository, f.store))
  const before = snapshot(f)
  f.repository.atomic((db) => {
    installTaskScheduleSchema(db)
    while (!backfillPage(db, f.repository.projectDirectory, 50).done);
  })
  const after = snapshot(f)
  for (const table of TABLES)
    expect({ label, table, rows: after[table] }).toEqual({ label, table, rows: before[table] })
}

test("a plan walked by the real runtime keeps the projection equal at every step", async () => {
  const f = fixture({ delayed: true, shared: true, commit: true })
  const planID = f.receipt.planID
  check(f, "submitted")
  await runPlan(f)
  check(f, "run")
  await f.runtime.tick()
  check(f, "dispatched")
  // Priority and pause through the real commands.
  await f.runtime.command(
    { requestID: "prio", planID, action: "schedule", priority: 2, reason: "r" },
    "owner",
  )
  check(f, "priority")
  await f.runtime.command({ requestID: "pause", action: "pause", planID, reason: "Wait" }, "owner")
  check(f, "plan pause")
  await f.runtime.command({ requestID: "unpause", action: "unpause", planID }, "owner")
  check(f, "plan unpause")
  setPause(f.repository, { kind: "global" }, { paused: true, reason: "hold", by: "owner" })
  check(f, "global pause")
  setPause(f.repository, { kind: "global" }, { paused: false, reason: "", by: "owner" })
  check(f, "global unpause")
  const task = f.tasks[0]!
  await f.runtime.command(
    {
      requestID: "scope",
      planID,
      action: "amend-scope",
      taskID: task.id,
      scopeAdditions: ["extra.txt"],
      reason: "r",
    },
    "owner",
  )
  check(f, "scope amended")
  // Attempts: start, finish, accept.
  const attempt = f.store.attempts(planID)[0]!
  f.completeWorker(attempt.session_id)
  check(f, "worker complete")
  for (let round = 0; round < 6; round++) {
    await driveWithTaskSourceLandings(f, 1, planID)
    check(f, `drive ${round}`)
  }
  const plan = f.store.plan(planID)!
  if (plan.state === "accepted" && plan.artifact) {
    includeArtifact(f, plan.artifact)
    await recordPlanIntegration(f, planID)
    check(f, "integrated")
    await f.runtime.tick()
    check(f, "cleanup")
  }
  await drive(f.runtime, 2)
  check(f, "settled")
})

test("a plan cancelled before it starts, a disposition and a second task submit", async () => {
  const f = fixture({ commit: true })
  const planID = f.receipt.planID
  await cancelUnstartedPlan(f, planID)
  check(f, "cancelled")
  const other = f.createTask("extra", "extra.txt")
  check(f, "task submitted")
  f.repository.recordDisposition(
    {
      requestID: "retire-extra",
      taskID: other.id,
      disposition: "superseded",
      reason: "No longer needed",
      evidence: [{ kind: "artifact", reference: "x" }],
      relatedTaskIDs: [],
    } as never,
    { sessionID: "owner", agent: "architect" },
  )
  check(f, "retired")
  void git
})

test("a descendant adoption holds and releases a task through the real store", async () => {
  const f = fixture({ commit: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  const planID = f.receipt.planID
  const task = f.tasks[0]!
  await runPlan(f)
  await drive(f.runtime, 3)
  check(f, "ran")
  const plan = f.store.plan(planID)!
  f.repository.atomic((db) =>
    db.query("UPDATE runner_plans SET state='blocked',version=version+1 WHERE id=?").run(planID),
  )
  check(f, "blocked")
  const node = f.store.nodes(planID).find((n) => n.task_id === task.id)!
  const adoption = f.store.createAdoption({
    id: crypto.randomUUID(),
    planID,
    taskID: task.id,
    writeScope: ["a.txt"],
    requestID: "adopt",
    owner: plan.owner,
    expectedVersion: f.store.plan(planID)!.version,
    taskRevision: 1,
    attemptID: f.store.attempts(planID)[0]?.id ?? "none",
    nodeState: node.state,
    attemptState: "accepted",
    oldArtifact: "a".repeat(40),
    descendantCommit: "b".repeat(40),
    targetBranch: "main",
    landingHead: "c".repeat(40),
    reviewedBaseline: "d".repeat(40),
    candidateTree: "e".repeat(40),
    inputFingerprint: "f",
    environmentIdentity: "env",
    reason: "adopt",
    combinedArtifact: "a".repeat(40),
  })
  check(f, "adoption created")
  f.store.setAdoptionState(adoption.id, "held", "Waiting for review")
  check(f, "adoption held")
  f.store.cancelAdoptions(planID, "released")
  check(f, "adoption cancelled")
})

test("a plan walked to integration and cleanup keeps the projection equal at every step", async () => {
  const f = fixture({ commit: true })
  const planID = f.receipt.planID
  await runPlan(f)
  check(f, "run")
  for (let round = 0; round < 8; round++) {
    await driveWithTaskSourceLandings(f, 1, planID)
    check(f, `drive ${round}`)
  }
  const plan = f.store.plan(planID)!
  expect(plan.state).toBe("accepted")
  expect(f.store.nodes(planID).every((node) => node.state === "accepted")).toBe(true)
  git(f.root, ["merge", "--ff-only", plan.artifact!])
  await f.runtime.command(
    {
      requestID: "merged",
      planID,
      action: "integrated",
      artifact: plan.artifact!,
      targetBranch: "main",
      reason: "Reviewed",
    },
    "owner",
  )
  check(f, "integration recorded")
  await f.runtime.tick()
  check(f, "cleanup")
  expect(f.store.plan(planID)!.state).toBe("integrated")
})

test("a failing worker and a plan cancelled mid-run keep the projection equal", async () => {
  const f = fixture({ fail: true, commit: true })
  const planID = f.receipt.planID
  await runPlan(f)
  for (let round = 0; round < 6; round++) {
    await drive(f.runtime, 1)
    check(f, `failing drive ${round}`)
  }
  await f.runtime.command({ requestID: "cancel", planID, action: "cancel" }, "owner")
  check(f, "cancel requested")
  await f.runtime.tick()
  check(f, "cancelled")
})
