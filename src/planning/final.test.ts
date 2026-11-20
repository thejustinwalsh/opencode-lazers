import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { fieldHashes, PlanningBody, validateBody } from "./draft.ts"
import type { PlanningHost } from "./host.ts"
import { PlanningReviews } from "./reviews.ts"
import { PlanningStore } from "./store.ts"
import { PlanDraftInput, PlanDrafts, PlanResolver, PlanReviewer, ResolveInput } from "./tools.ts"

const cleanup: (() => void)[] = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
})
const PID = "0b4e2c1a-0000-4000-8000-000000000001"

const readinessReply = JSON.stringify({
  agent: "readiness",
  status: "reviewed",
  checked: ["acceptance"],
  findings: [
    {
      id: "F1",
      severity: "blocker",
      confidence: "confirmed",
      target: { unit: "a", field: "acceptance" },
      what: "Acceptance cannot fail.",
      failureScenario: "A broken result passes.",
      evidence: ["a quoted plan line"],
      suggestion: "Add a check.",
    },
  ],
  questions: [
    {
      id: "Q1",
      question: "What counts as done?",
      why: "Changes the acceptance.",
      relatedFinding: "F1",
      weight: "changes-scope",
    },
  ],
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lazers-final-"))
  const repository = new TaskRepository(join(root, "tasks.sqlite"), root)
  cleanup.push(() => {
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  const store = new PlanningStore(repository)
  const created: string[] = []
  const agents = new Map<string, string>()
  const host: PlanningHost = {
    async create(input) {
      created.push(input.agent)
      agents.set(input.id, input.agent)
      return "created"
    },
    async prompt() {},
    async observe(id) {
      return agents.has(id)
        ? { found: true, updatedAt: 1e12, busyAt: 1e12, idleAt: 1e12, outcome: "succeeded" }
        : { found: false }
    },
    async reply() {
      return {
        text: readinessReply,
        finish: "stop",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
      }
    },
    async interrupt() {},
  }
  let t = 1
  const reviews = new PlanningReviews({
    store,
    host,
    now: () => t++,
    pollMs: 0,
    mapFor: async () => ({ text: "map", hash: "h", tokens: 1, paths: new Set(["src/a.ts"]) }),
    notify: async () => {},
    title: (agent) => agent,
  })
  const reviewer = new PlanReviewer(store, reviews, "proj", () => true, root)
  const drafts = new PlanDrafts(repository, "proj")
  const resolver = new PlanResolver(store, "proj", async () => undefined)
  const body = (objective = "Do it.") =>
    PlanningBody.parse({
      title: "Plan",
      ask: "ask",
      plan: { objective: "o", verification: [], acceptance: [] },
      tasks: [{ draftID: "a", proposal: { objective, writeScope: ["src/a.ts"] } }],
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
  const first = body()
  store.appendRevision(PID, undefined, first, validateBody(first), fieldHashes(first))
  const call = { sessionID: "arch" }
  return { store, reviewer, drafts, resolver, created, body, call }
}

test("from questions-open the final pass runs exactly one Readiness child", async () => {
  const f = fixture()
  f.store.move(PID, "in-review")
  f.store.move(PID, "questions-open")
  const result = await f.reviewer.call(
    { planningID: PID, stage: "final", agents: ["critic"] },
    f.call,
  )
  if (!("agents" in result)) throw new Error("not a review")
  expect(f.created).toEqual(["lazers-planning-readiness"])
  expect(result.agents.map((a) => a.agent)).toEqual(["readiness"])
  expect(result.note).toContain("ignored")
  expect(f.store.planning(PID)!.state).toBe("final-review")
})

test("a final-pass question reaches the owner batch, and finalize makes the plan ready", async () => {
  const f = fixture()
  f.store.move(PID, "in-review")
  f.store.move(PID, "questions-open")
  const result = await f.reviewer.call({ planningID: PID, stage: "final" }, f.call)
  if (!("questions" in result)) throw new Error("not a review")
  const question = result.questions[0]!
  const resolved = await f.resolver.call(
    ResolveInput.parse({
      planningID: PID,
      questions: [{ questionID: question.id, route: "owner" }],
    }),
    f.call,
  )
  expect(resolved.ownerBatch).toBe("1. What counts as done? — readiness, a.acceptance")
  const done = f.drafts.call(
    PlanDraftInput.parse({ action: "finalize", planningID: PID, body: f.body("Do it well.") }),
    f.call,
  )
  if (done.status !== "stored") throw new Error(JSON.stringify(done))
  expect(done).toMatchObject({ state: "ready", revision: 2, open: 2 })
  expect(done.breakdown.endsWith('Final r2 — tasking next. Reply "stop" to keep it open.')).toBe(
    true,
  )
  const edited = f.drafts.call(
    PlanDraftInput.parse({
      action: "store",
      planningID: PID,
      expectedRevision: 2,
      body: f.body("Again."),
    }),
    f.call,
  )
  expect(edited).toMatchObject({ status: "stored", state: "drafted" })
})

test("a final pass cannot start from drafted", async () => {
  const f = fixture()
  expect(await f.reviewer.call({ planningID: PID, stage: "final" }, f.call)).toEqual({
    status: "invalid",
    errors: [{ path: "planningID", message: "plan is drafted; the final pass follows the review" }],
  })
})
