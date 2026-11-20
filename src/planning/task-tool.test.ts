import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PlanSubmissionInput } from "../runner/schema.ts"
import { verificationTimeoutDefaults } from "../runner/verification-timeout.ts"
import { TaskRepository } from "../storage.ts"
import { taskSubmitter } from "../tools.ts"
import { fieldHashes, PlanningBody, validateBody } from "./draft.ts"
import { PlanningStore } from "./store.ts"
import { PlanTaskInput, PlanTasker } from "./tasking.ts"

const cleanup: (() => void)[] = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
})
const PID = "0b4e2c1a-0000-4000-8000-000000000001"

const proposal = (objective: string, extra: Record<string, unknown> = {}) => ({
  objective,
  classification: { taxonomy: "task-kind/v1", primaryKind: "feature-implementation" },
  exclusions: [],
  constraints: [],
  assumptions: [],
  writeScope: ["src/planning/x.ts"],
  context: [],
  acceptance: [{ id: "done", assertion: "It works.", evidence: [] }],
  requirements: { capabilities: [], skills: [], risk: "low" },
  verification: [{ id: "unit", command: "bun test --timeout 120000 src/planning/x.test.ts" }],
  ...extra,
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lazers-task-tool-"))
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", root, "-c", "user.name=f", "-c", "user.email=f@e.invalid", ...args])
  git("init", "-q", "-b", "main")
  writeFileSync(join(root, "a.txt"), "a")
  git("add", "-A")
  git("commit", "-q", "-m", "base")
  const head = new TextDecoder().decode(git("rev-parse", "HEAD").stdout).trim()
  const repository = new TaskRepository(join(root, "tasks.sqlite"), root)
  cleanup.push(() => {
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  const store = new PlanningStore(repository)
  const submitTask = taskSubmitter(
    { location: { directory: root, project: { id: "proj", canonical: root } } as never },
    repository,
    verificationTimeoutDefaults(),
  )
  const plans: unknown[] = []
  const cancelled: string[] = []
  const tasker = new PlanTasker({
    store,
    projectID: "proj",
    submitTask,
    submitPlan: async (input) => {
      plans.push(PlanSubmissionInput.parse(input))
      return { planID: "11111111-1111-4111-8111-111111111111" }
    },
    headCommit: async () => head,
    cancelReviews: async (id) => void cancelled.push(id),
    timeoutDefaults: verificationTimeoutDefaults(),
  })
  store.createPlanning({
    id: PID,
    projectKey: "proj",
    projectDirectory: root,
    sessionId: "arch",
    title: "Plan",
    createdAt: 1,
    updatedAt: 1,
  })
  const append = (tasks: Record<string, unknown>[]) => {
    const body = PlanningBody.parse({
      title: "Plan",
      ask: "ask",
      plan: {
        objective: "Plan it",
        verification: [{ id: "all", command: "bun run verify" }],
        acceptance: [{ id: "plan", assertion: "All tasks done.", evidence: [] }],
      },
      tasks,
    })
    store.appendRevision(PID, undefined, body, validateBody(body), fieldHashes(body))
  }
  const three = () => [
    { draftID: "store-schema", proposal: proposal("Store drafts.") },
    { draftID: "breakdown", dependsOn: ["store-schema"], proposal: proposal("Render it.") },
    { draftID: "plan-link", dependsOn: ["breakdown"], proposal: proposal("Link it.") },
  ]
  const call = (input: object = {}) =>
    tasker.call(PlanTaskInput.parse({ planningID: PID, ...input }), { sessionID: "arch" })
  return { store, append, three, call, plans, cancelled, submitTask }
}

test("three valid drafts become three tasks and one admitted plan, mapped to their references", async () => {
  const f = fixture()
  f.append(f.three())
  const result = await f.call()
  if (result.status !== "tasked") throw new Error(JSON.stringify(result))
  expect(result.tasks.map((t) => t.draftID)).toEqual(["store-schema", "breakdown", "plan-link"])
  expect(result.tasks.every((t) => /^LZ-\d+$/.test(t.reference))).toBe(true)
  expect(f.store.planning(PID)!.state).toBe("tasked")
  const plan = f.plans[0] as {
    requestID: string
    dependencies: { prerequisite: string; successor: string }[]
    integrationOrder: string[]
  }
  expect(plan.requestID).toBe(`planning:${PID}:r1`)
  const id = (draft: string) => result.tasks.find((t) => t.draftID === draft)!.taskID
  expect(plan.dependencies).toEqual([
    { prerequisite: id("store-schema"), successor: id("breakdown") },
    { prerequisite: id("breakdown"), successor: id("plan-link") },
  ])
  expect(plan.integrationOrder).toEqual([id("store-schema"), id("breakdown"), id("plan-link")])
  // The key is the plan's own: replaying it returns the task just made.
  const replay = (await f.submitTask(
    { ...proposal("Store drafts."), idempotencyKey: `planning:${PID}:store-schema:r1` },
    "arch",
  )) as { taskID: string }
  expect(replay.taskID).toBe(id("store-schema"))
})

test("an open review is cancelled and the plan is tasked from in-review", async () => {
  const f = fixture()
  f.append(f.three())
  f.store.move(PID, "in-review")
  const result = await f.call()
  expect(result.status).toBe("tasked")
  expect(f.cancelled).toEqual([PID])
})

test("a draft without a classification is listed and nothing is written", async () => {
  const f = fixture()
  const drafts: Record<string, unknown>[] = f.three()
  const { classification: _omit, ...bare } = proposal("Link it.")
  drafts[2] = { draftID: "plan-link", dependsOn: ["breakdown"], proposal: bare }
  f.append(drafts)
  const result = await f.call()
  expect(result).toMatchObject({ status: "invalid" })
  if (result.status !== "invalid") return
  expect(result.drafts["plan-link"]!.map((p) => p.path)).toContain("classification")
  expect(f.plans).toEqual([])
  expect(f.store.planning(PID)!.state).toBe("drafted")
  expect(f.store.tasked(PID)).toEqual([])
  expect(f.cancelled).toEqual([])
})

test("fields changed after the last review are recorded", async () => {
  const f = fixture()
  f.append(f.three())
  f.append(f.three())
  f.store.createReview({
    id: "rv",
    planningId: PID,
    revision: 2,
    stage: "review",
    selectionJson: "{}",
    createdAt: 1,
    settledAt: 2,
  })
  const changed = f.three()
  changed[2] = {
    ...changed[2]!,
    proposal: proposal("Link it.", { writeScope: ["src/planning/y.ts"] }),
  }
  f.append(changed)
  const result = await f.call()
  if (result.status !== "tasked") throw new Error(JSON.stringify(result))
  expect(result.changedAfterReview).toEqual({ "plan-link": ["writeScope"] })
})

test("tasking twice returns the same tasks", async () => {
  const f = fixture()
  f.append(f.three())
  const one = await f.call()
  const two = await f.call()
  expect(two).toEqual(one)
  expect(f.plans).toHaveLength(1)
})
