import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { guidanceLedger, runbook } from "../guidance/index.ts"
import { TaskRepository } from "../storage.ts"
import { AGENT_ORDER } from "./decision/tree.ts"
import { fieldHashes, PlanningBody, validateBody } from "./draft.ts"
import type { PlanningHost } from "./host.ts"
import { PlanningReviews } from "./reviews.ts"
import { PlanningStore } from "./store.ts"
import { PlanDrafts, PlanReviewer } from "./tools.ts"

const cleanup: (() => void)[] = []
afterEach(() => {
  guidanceLedger.clear()
  while (cleanup.length) cleanup.pop()!()
})

const okReply = (agent: string) =>
  JSON.stringify({ agent, status: "reviewed", checked: ["scope"], findings: [], questions: [] })

function fixture(options: { auto?: boolean; hang?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lazers-review-tool-"))
  const repository = new TaskRepository(join(root, "tasks.sqlite"), root)
  cleanup.push(() => {
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  const store = new PlanningStore(repository)
  const agents = new Map<string, string>()
  const interrupts: string[] = []
  let t = 1_000
  const host: PlanningHost = {
    async create(input) {
      agents.set(input.id, input.agent.replace("lazers-planning-", ""))
      return "created"
    },
    async prompt() {},
    async observe(id) {
      if (!agents.has(id)) return { found: false }
      return options.hang
        ? { found: true, updatedAt: 1e12, busyAt: 1e12 }
        : { found: true, updatedAt: 1e12, busyAt: 1e12, idleAt: 1e12, outcome: "succeeded" }
    },
    async reply(id) {
      return {
        text: okReply(agents.get(id)!),
        finish: "stop",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
      }
    },
    async interrupt(id) {
      interrupts.push(id)
    },
  }
  const reviews = new PlanningReviews({
    store,
    host,
    now: () => t++,
    pollMs: 0,
    mapFor: async () => ({
      text: "map",
      hash: "h",
      tokens: 1,
      paths: new Set(["src/a.ts", "src/database-schema.ts"]),
    }),
    notify: async () => {},
    title: (agent) => agent,
  })
  const reviewer = new PlanReviewer(store, reviews, "proj", () => options.auto ?? true, root)
  const plan = (
    scope: string,
    decision?: { status: "decided" | "unavailable"; selected?: string[] },
  ) => {
    const body = PlanningBody.parse({
      title: "Plan",
      ask: "ask",
      plan: { objective: "o", verification: [], acceptance: [] },
      tasks: [{ draftID: "a", proposal: { objective: "Do it.", writeScope: [scope] } }],
    })
    if (decision)
      store.recordDecision({
        id: "d1",
        projectKey: "proj",
        sessionId: "arch",
        messageId: "m1",
        createdAt: 1,
        askText: "ask",
        askChars: 3,
        status: decision.status,
        selectedJson: JSON.stringify(decision.selected ?? []),
      })
    store.createPlanning({
      id: "p1",
      projectKey: "proj",
      projectDirectory: root,
      sessionId: "arch",
      decisionId: decision ? "d1" : null,
      title: "Plan",
      createdAt: 1,
      updatedAt: 1,
    })
    store.appendRevision("p1", undefined, body, validateBody(body), fieldHashes(body))
  }
  return { store, reviews, reviewer, plan, repository, interrupts }
}

const sources = (selected: unknown) =>
  (selected as { agent: string; source: string }[]).map((s) => `${s.agent}:${s.source}`)

test("the decision's agents plus the stored-data rule are selected, with their sources", () => {
  const f = fixture()
  f.plan("src/database-schema.ts", { status: "decided", selected: ["grounding", "readiness"] })
  expect(sources(f.reviewer.selection("p1"))).toEqual([
    "grounding:decision",
    "readiness:decision",
    "critic:rule:stored-data",
  ])
  expect(f.reviewer.selection("p1", ["zoom-out"])).toHaveLength(4)
})

test("with no usable decision all five agents run", () => {
  const f = fixture()
  f.plan("src/a.ts", { status: "unavailable" })
  expect((f.reviewer.selection("p1") as unknown[]).length).toBe(AGENT_ORDER.length)
  const g = fixture()
  g.plan("src/a.ts")
  expect(sources(g.reviewer.selection("p1"))[0]).toBe("comprehension:all")
})

test("with automatic dispatch off nothing starts without agents", async () => {
  const f = fixture({ auto: false })
  f.plan("src/a.ts", { status: "decided", selected: ["grounding"] })
  const result = await f.reviewer.call({ planningID: "p1", stage: "review" }, { sessionID: "arch" })
  expect(result).toMatchObject({
    status: "needs-agents",
    reason: "automatic planning agents are off for this project",
  })
  expect(f.store.reviews("p1")).toEqual([])
  const named = await f.reviewer.call(
    { planningID: "p1", stage: "review", agents: ["critic"] },
    { sessionID: "arch" },
  )
  if (!("agents" in named)) throw new Error("not a review")
  expect(named.agents.map((a) => a.agent)).toEqual(["critic"])
})

test("the plan moves drafted, in-review, questions-open; the first result carries the runbook", async () => {
  const f = fixture()
  f.plan("src/a.ts")
  expect(f.store.planning("p1")!.state).toBe("drafted")
  const result = await f.reviewer.call({ planningID: "p1", stage: "review" }, { sessionID: "arch" })
  if (!("agents" in result)) throw new Error("not a review")
  expect(result.agents).toHaveLength(5)
  expect(result.runbook).toBe(runbook("planning-resolve"))
  expect(f.store.planning("p1")!.state).toBe("questions-open")
  const again = await f.reviewer.call({ planningID: "p1", stage: "review" }, { sessionID: "arch" })
  expect(again).toMatchObject({ revision: 1 })
})

test("a tasked or foreign plan cannot be reviewed", async () => {
  const f = fixture()
  f.plan("src/a.ts")
  f.store.move("p1", "tasked")
  expect(
    await f.reviewer.call({ planningID: "p1", stage: "review" }, { sessionID: "arch" }),
  ).toEqual({
    status: "invalid",
    errors: [{ path: "planningID", message: "plan is tasked; it cannot be reviewed" }],
  })
  const other = new PlanReviewer(f.store, f.reviews, "other", () => true, "/")
  expect(
    await other.call({ planningID: "p1", stage: "review" }, { sessionID: "arch" }),
  ).toMatchObject({
    status: "invalid",
  })
})

test("abandoning a plan cancels its running review runs", async () => {
  const f = fixture({ hang: true })
  f.plan("src/a.ts")
  const drafts = new PlanDrafts(f.repository, "proj", Date.now, (id, reason) => {
    void f.reviews.cancelForPlanning(id, reason)
  })
  const review = await f.reviews.start({
    planningID: "p1",
    stage: "review",
    agents: [{ agent: "critic", source: "all" }],
    parentSessionID: "arch",
    directory: "/",
  })
  await f.reviews.advance(review.id)
  expect(f.store.runs(review.id)[0]!.state).toBe("running")
  expect(
    drafts.call({ action: "abandon", planningID: "p1", reason: "dropped" }, { sessionID: "arch" }),
  ).toMatchObject({ status: "abandoned" })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(f.store.runs(review.id)[0]).toMatchObject({ state: "cancelled", reason: "plan abandoned" })
  expect(f.interrupts).toHaveLength(1)
  expect(f.store.planning("p1")!.state).toBe("abandoned")
})
