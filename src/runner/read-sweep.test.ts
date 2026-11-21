import { allPlans } from "./store-plans.fixture.ts"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { RecoveryDetector } from "../recovery/detector.ts"
import { HandoffStore } from "../recovery/handoff/store.ts"
import { TaskRepository } from "../storage.ts"
import { git } from "./artifacts.ts"
import { meterReads } from "./read-meter.fixture.ts"
import { RunnerStore } from "./store.ts"
import { VerificationReview } from "./verification-review.ts"

/**
 * Read-meter tests for the read sweep (design/data-handling.md, principles 1 and 8): each path
 * that used to load a table or every plan body now reads the rows it uses. The "before" number is
 * measured in the same test by running the shape the code used to run.
 */

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const PADDING = "p".repeat(40_000)
/** `READ_SWEEP_NUMBERS=1 bun test ...` prints the before and after counts the report quotes. */
const show = (name: string, before: unknown, after: unknown) => {
  if (process.env.READ_SWEEP_NUMBERS)
    console.log(
      `[read-sweep] ${name} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    )
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lazers-read-sweep-")))
  git(root, ["init", "--initial-branch=main"])
  writeFileSync(join(root, "seed.txt"), "baseline\n")
  git(root, ["add", "seed.txt"])
  git(root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "baseline",
  ])
  const base = git(root, ["rev-parse", "HEAD"])
  const repository = new TaskRepository(join(root, "data", "tasks.sqlite"), root)
  const store = new RunnerStore(repository)
  cleanups.push(() => {
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  let count = 0
  /** A one-task plan in the given state, with a padded body so reading it costs something. */
  const plan = (state: string, node = "queued") => {
    const n = ++count
    const proposal = validProposal()
    proposal.objective = `Task number ${n}.`
    proposal.writeScope = [`out${n}.txt`]
    proposal.verification = [{ id: "tests", command: "true", timeoutMs: 1000 }]
    const task = repository.insert({
      schemaVersion: 1,
      id: crypto.randomUUID(),
      revision: 1,
      status: "submitted",
      createdAt: new Date().toISOString(),
      provenance: {
        projectID: "project",
        projectDirectory: root,
        workspaceDirectory: root,
        sessionID: "architect-1",
        startingRevision: { kind: "git", commit: base },
      },
      proposal,
    })
    const submitted = store.submit(
      {
        requestID: `plan-${n}`,
        objective: `Plan number ${n}`,
        baseCommit: base,
        workspaceMode: "isolated",
        workerModel: { providerID: "openai", id: "test" },
        nodes: [{ taskID: task.id, revision: 1 }],
        dependencies: [],
        integrationOrder: [task.id],
        verification: [{ id: "combined", command: "true", timeoutMs: 1000 }],
        acceptance: [
          {
            id: "combined",
            assertion: "combined",
            evidence: [{ kind: "verification", verificationID: "combined" }],
          },
        ],
      },
      "architect-1",
    )
    store.atomic((db) => {
      db.query("UPDATE runner_plans SET state=?,body=json_set(body,'$.padding',?) WHERE id=?").run(
        state,
        PADDING,
        submitted.planID,
      )
      db.query("UPDATE runner_nodes SET state=? WHERE plan_id=?").run(node, submitted.planID)
    })
    return { planID: submitted.planID, taskID: task.id }
  }
  const attempt = (planID: string, taskID: string, state: string, workspace = root) => {
    const id = crypto.randomUUID()
    store.atomic((db) =>
      db
        .query(
          `INSERT INTO runner_attempts(id,plan_id,project_directory,task_id,number,session_id,message_id,workspace,base_commit,artifact,policy,state,started_at)
           VALUES(?,?,?,?,1,?,?,?,?,NULL,'{}',?,?)`,
        )
        .run(
          id,
          planID,
          root,
          taskID,
          `worker-${id}`,
          `m-${id}`,
          workspace,
          base,
          state,
          Date.now(),
        ),
    )
    return id
  }
  return { root, base, store, repository, plan, attempt }
}

test("a recovery pass over the running plans reads their ids, not a thousand plan bodies", () => {
  const f = fixture()
  for (let index = 0; index < 12; index++) f.plan(index % 3 === 0 ? "blocked" : "integrated")
  const running = f.plan("running", "running")
  f.attempt(running.planID, running.taskID, "running")

  // Before: every plan with its body, filtered by state in JavaScript.
  const before = meterReads(f.store)
  const oldIDs = allPlans(f.store)
    .filter((plan) => plan.state === "running")
    .map((plan) => plan.id)
  before.stop()

  const after = meterReads(f.store)
  const detector = new RecoveryDetector({
    store: f.store,
    handoff: new HandoffStore(f.repository),
    now: () => Date.now(),
  })
  const { fence } = { fence: f.store.claim("scheduler", Date.now())! }
  expect(detector.evaluate("scheduler", fence)).toEqual([])
  after.stop()

  expect([...f.store.planHeads(["running"])].map((plan) => plan.id)).toEqual(oldIDs)
  expect(after.of(/runner_plans/).rows).toBeLessThanOrEqual(before.of(/runner_plans/).rows)
  expect(before.of(/runner_plans/).bytes).toBeGreaterThan(13 * PADDING.length)
  show("detector", before.of(/runner_plans/), after.of(/runner_plans/))
  // The one running plan's body is read once for its scope; the thirteen others are not.
  expect(after.of(/runner_plans/).bytes).toBeLessThan(2 * PADDING.length)
})

test("scope owners are the same unfinished plans' tasks, read without plan bodies", () => {
  const f = fixture()
  const own = f.plan("running", "running")
  const queued = f.plan("draft", "queued")
  f.plan("integrated", "queued")
  f.plan("cancelled", "queued")
  const accepted = f.plan("running", "accepted")
  const owners = (store: RunnerStore) =>
    (VerificationReview.prototype as any).scopeOwners.call(
      { store },
      { id: own.planID },
      own.taskID,
    ) as { taskID: string }[]

  // The old algorithm, spelled out: every plan body, filtered in JavaScript.
  const finished = new Set(["accepted", "incorporated", "cancelled", "failed", "exhausted"])
  const expected = new Set<string>()
  for (const other of allPlans(f.store))
    if (!["integrated", "cancelled"].includes(other.state))
      for (const node of f.store.nodes(other.id))
        if (node.task_id !== own.taskID && !finished.has(node.state)) expected.add(node.task_id)

  const old = meterReads(f.store)
  allPlans(f.store).forEach((plan) => f.store.nodes(plan.id))
  old.stop()
  const meter = meterReads(f.store)
  const got = owners(f.store).map((owner) => owner.taskID)
  meter.stop()
  expect([...got].sort()).toEqual([...expected].sort())
  expect(got).toContain(queued.taskID)
  expect(got).not.toContain(accepted.taskID)
  show("scopeOwners", old.of(/FROM runner_plans/), meter.of(/FROM runner_plans/))
  expect(meter.of(/FROM runner_plans/).bytes).toBeLessThan(400)
})

test("a takeover finds the plan of an attempt with one indexed read", () => {
  const f = fixture()
  const target = f.plan("running", "running")
  for (let index = 0; index < 10; index++) f.plan("blocked")
  const id = f.attempt(target.planID, target.taskID, "running")
  const before = meterReads(f.store)
  const old = allPlans(f.store)
    .flatMap((plan) => f.store.attempts(plan.id))
    .find((candidate) => candidate.id === id)
  before.stop()
  const after = meterReads(f.store)
  const planID = f.store.planIDOfAttempt(id)
  after.stop()
  expect(planID).toBe(old!.plan_id)
  expect(f.store.planIDOfAttempt("no-such-attempt")).toBeNull()
  show(
    "takeover",
    { rows: before.rows, bytes: before.bytes },
    { rows: after.rows, bytes: after.bytes },
  )
  expect(after.rows).toBe(1)
  expect(after.bytes).toBeLessThan(100)
  expect(before.bytes).toBeGreaterThan(10 * PADDING.length)
})
