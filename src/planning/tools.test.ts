import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Delivery, guidanceLedger, pointer, runbook } from "../guidance/index.ts"
import { TaskRepository } from "../storage.ts"
import { PlanningBody } from "./draft.ts"
import { PlanDrafts, PlanDraftInput, type PlanDraftResult } from "./tools.ts"

const cleanup: (() => void)[] = []
afterEach(() => {
  guidanceLedger.clear()
  while (cleanup.length) cleanup.pop()!()
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lazers-plan-tools-"))
  const repository = new TaskRepository(join(root, "tasks.sqlite"), root)
  cleanup.push(() => {
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  const drafts = new PlanDrafts(repository, "proj")
  const run = (input: unknown, sessionID = "s1") =>
    drafts.call(PlanDraftInput.parse(input), { sessionID })
  return { drafts, run, repository }
}

const proposal = (objective: string) => ({
  objective,
  exclusions: [],
  constraints: [],
  assumptions: [],
  writeScope: ["src/planning/x.ts"],
  context: [],
  acceptance: [{ id: "done", assertion: "It works.", evidence: [] }],
  requirements: { capabilities: [], skills: [], risk: "low" },
  verification: [{ id: "unit", command: "bun test --timeout 120000 src/planning/x.test.ts" }],
})

const body = (extra: Record<string, unknown> = {}) => ({
  title: "Planning flow",
  ask: "Plan the flow",
  plan: { objective: "Plan the flow", verification: [], acceptance: [] },
  openDecisions: [
    {
      id: "D1",
      question: "Which slicer is the default?",
      options: ["whole", "pre-slice", "uncertainty"],
    },
  ],
  tasks: [
    {
      draftID: "store-schema",
      proposal: proposal("Store plan drafts and their revisions. Keep every revision."),
    },
    {
      draftID: "breakdown",
      dependsOn: ["store-schema"],
      proposal: proposal("Render the chat breakdown from the stored plan."),
    },
    {
      draftID: "plan-link",
      dependsOn: ["store-schema", "breakdown"],
      proposal: { objective: "Open a stored plan from a chat link." },
    },
  ],
  ...extra,
})

const stored = (r: PlanDraftResult) => {
  if (r.status !== "stored") throw new Error(`not stored: ${JSON.stringify(r)}`)
  return r
}

test("a first store creates the plan in drafted at revision 1 with the exact breakdown", () => {
  const { run } = fixture()
  const result = stored(run({ action: "store", body: body() }))
  expect(result).toMatchObject({ revision: 1, state: "drafted" })
  expect(result.breakdown).toBe(
    [
      "**Planning flow** · r1",
      "1. store-schema — Store plan drafts and their revisions.",
      "2. breakdown — Render the chat breakdown from the stored plan. · after store-schema",
      "3. plan-link — Open a stored plan from a chat link. · after store-schema, breakdown · incomplete",
      "",
      "Open decisions",
      "- D1 Which slicer is the default? (whole / pre-slice / uncertainty)",
      "",
      `[Full plan](.lazers/plans/70726f6a/${result.planningID})`,
      'Reply LGTM to continue, a change to revise, or "just task it" to skip the agents.',
    ].join("\n"),
  )
  expect(result.validation.drafts["plan-link"]?.length).toBeGreaterThan(0)
})

test("a stale revision conflicts and a revise without one is refused", () => {
  const { run } = fixture()
  const first = stored(run({ action: "store", body: body() }))
  const second = stored(
    run({ action: "store", planningID: first.planningID, expectedRevision: 1, body: body() }),
  )
  expect(second.revision).toBe(2)
  expect(
    run({ action: "store", planningID: first.planningID, expectedRevision: 1, body: body() }),
  ).toEqual({ status: "conflict", currentRevision: 2 })
  expect(run({ action: "store", planningID: first.planningID, body: body() })).toMatchObject({
    status: "invalid",
  })
})

test("storing in ready returns the plan to drafted", () => {
  const { run, drafts } = fixture()
  const first = stored(run({ action: "store", body: body() }))
  drafts.store.move(first.planningID, "in-review")
  drafts.store.move(first.planningID, "questions-open")
  drafts.store.move(first.planningID, "final-review")
  expect(run({ action: "finalize", planningID: first.planningID })).toMatchObject({
    status: "stored",
    state: "ready",
  })
  const edited = stored(
    run({ action: "store", planningID: first.planningID, expectedRevision: 1, body: body() }),
  )
  expect(edited.state).toBe("drafted")
})

test("an abandoned plan refuses a store; two plans in a session stay independent", () => {
  const { run } = fixture()
  const a = stored(run({ action: "store", body: body() }))
  const b = stored(run({ action: "store", body: body() }))
  expect(a.planningID).not.toBe(b.planningID)
  expect(a.link).not.toBe(b.link)
  expect(run({ action: "abandon", planningID: a.planningID, reason: "owner dropped it" })).toEqual({
    status: "abandoned",
    planningID: a.planningID,
  })
  expect(
    run({ action: "store", planningID: a.planningID, expectedRevision: 1, body: body() }),
  ).toEqual({
    status: "invalid",
    errors: [{ path: "planningID", message: "plan is abandoned; start a new plan" }],
  })
})

test("the first store of a session carries the runbook and the next only a pointer", () => {
  const { drafts } = fixture()
  const input = PlanDraftInput.parse({ action: "store", body: body() })
  const first = new Delivery("s1")
  const one = stored(drafts.call(input, { sessionID: "s1" }, first))
  first.commit()
  const two = stored(drafts.call(input, { sessionID: "s1" }, new Delivery("s1")))
  expect(one.runbook).toBe(runbook("planning-show"))
  expect(two.runbook).toBe(pointer("planning-show"))
})

test("guide show returns the runbook; a plan of another project is invisible", () => {
  const { run, repository } = fixture()
  expect(run({ action: "guide", topic: "show" })).toMatchObject({
    guidance: runbook("planning-show"),
  })
  const first = stored(run({ action: "store", body: body() }))
  const other = new PlanDrafts(repository, "other")
  expect(
    other.call(
      PlanDraftInput.parse({ action: "abandon", planningID: first.planningID, reason: "x" }),
      {
        sessionID: "s1",
      },
    ),
  ).toMatchObject({ status: "invalid" })
})

test("evidence returns the owner's answer about a draft", () => {
  const { run, drafts } = fixture()
  const plan = stored(run({ action: "store", body: body() }))
  drafts.store.addFinding({
    id: "f1",
    planningId: plan.planningID,
    reviewId: "r",
    runId: "u",
    source: "critic",
    revision: 1,
    draftId: "breakdown",
    field: "write-scope",
    body: JSON.stringify({ what: "The scope misses the renderer" }),
  })
  drafts.store.addQuestion({
    id: "q1",
    planningId: plan.planningID,
    reviewId: "r",
    source: "critic",
    revision: 1,
    findingId: "f1",
    body: JSON.stringify({ question: "Should the renderer be in scope?" }),
    route: "owner-answered",
    answer: "Yes, include src/planning/render.ts",
  })
  const result = run({ action: "evidence", planningID: plan.planningID, draftID: "breakdown" })
  if (result.status !== "evidence") throw new Error("not evidence")
  expect(result.evidence).toHaveLength(1)
  expect(result.evidence[0]).toContain("Yes, include src/planning/render.ts")
  expect(result.evidence[0]).toStartWith("Planning critic on write-scope:")
})

test("an architect pick is recorded on the decision the plan answers", () => {
  const { run, drafts, repository } = fixture()
  drafts.store.recordDecision({
    id: "d1",
    projectKey: "proj",
    sessionId: "s1",
    messageId: "m1",
    createdAt: 1,
    askText: "ask",
    askChars: 3,
    status: "unavailable",
  })
  const plan = stored(
    run({
      action: "store",
      decisionMessageID: "m1",
      architectPick: { size: "a few tasks", agents: ["grounding"] },
      body: body(),
    }),
  )
  expect(plan.state).toBe("drafted")
  expect(JSON.parse(drafts.store.decision("s1", "m1")!.architectJson!)).toEqual({
    source: "architect",
    size: "a few tasks",
    agents: ["grounding"],
  })
  expect(repository).toBeDefined()
  expect(PlanningBody.safeParse(body()).success).toBe(true)
})
