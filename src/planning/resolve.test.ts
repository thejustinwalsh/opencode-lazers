import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { fieldHashes, PlanningBody, validateBody } from "./draft.ts"
import { planningView } from "./read.ts"
import { PlanningStore } from "./store.ts"
import { PlanResolver, ResolveInput } from "./tools.ts"
import { planningViewModel } from "./view-model.ts"

const cleanup: (() => void)[] = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
})

const PID = "0b4e2c1a-0000-4000-8000-000000000001"
const MESSAGE = "The owner said: keep the renderer inside src/planning and never touch the runtime."

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lazers-resolve-"))
  const repository = new TaskRepository(join(root, "tasks.sqlite"), root)
  cleanup.push(() => {
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  const store = new PlanningStore(repository)
  store.createPlanning({
    id: PID,
    projectKey: "proj",
    projectDirectory: root,
    sessionId: "arch",
    title: "Plan",
    createdAt: 1,
    updatedAt: 1,
  })
  for (const scope of ["src/a.ts", "src/b.ts"]) {
    const body = PlanningBody.parse({
      title: "Plan",
      ask: "ask",
      plan: { objective: "o", verification: [], acceptance: [] },
      tasks: [{ draftID: "plan-link", proposal: { objective: "Do it.", writeScope: [scope] } }],
    })
    store.appendRevision(PID, undefined, body, validateBody(body), fieldHashes(body))
  }
  const finding = (id: string, field: string, severity = "major", source = "critic") =>
    store.addFinding({
      id,
      planningId: PID,
      reviewId: "r",
      runId: "u",
      source,
      revision: 1,
      draftId: "plan-link",
      field,
      severity,
      body: JSON.stringify({ what: `about ${field}` }),
    })
  const question = (
    id: string,
    over: {
      findingId?: string
      weight?: string
      text?: string
      options?: string[]
      source?: string
    },
  ) =>
    store.addQuestion({
      id,
      planningId: PID,
      reviewId: "r",
      source: over.source ?? "critic",
      revision: 1,
      findingId: over.findingId ?? null,
      weight: over.weight ?? "changes-detail",
      body: JSON.stringify({ question: over.text ?? id, options: over.options }),
    })
  const resolver = new PlanResolver(
    store,
    "proj",
    async (_session, messageID) => (messageID === "m1" ? MESSAGE : undefined),
    () => 5,
  )
  const run = (input: unknown) =>
    resolver.call(ResolveInput.parse({ planningID: PID, ...(input as object) }), {
      sessionID: "arch",
    })
  return { store, finding, question, run }
}

test("a conversation answer needs its quote in the cited message", async () => {
  const f = fixture()
  f.question("q1", {})
  f.question("q2", {})
  const result = await f.run({
    questions: [
      {
        questionID: "q1",
        route: "conversation",
        answer: "Inside src/planning.",
        citation: { messageID: "m1", quote: "keep the renderer inside src/planning" },
      },
      {
        questionID: "q2",
        route: "conversation",
        answer: "Whatever.",
        citation: { messageID: "m1", quote: "a sentence the owner never wrote" },
      },
    ],
  })
  expect(result.applied).toBe(1)
  expect(result.refused).toEqual([{ id: "q2", reason: "citation not found in m1" }])
  expect(f.store.questions(PID).map((q) => [q.id, q.route])).toEqual([
    ["q1", "conversation"],
    ["q2", "open"],
  ])
})

test("a finding is revised only when its field changed since it was raised", async () => {
  const f = fixture()
  f.finding("f1", "objective")
  f.finding("f2", "write-scope")
  const result = await f.run({
    findings: [
      { findingID: "f1", outcome: "revised", revision: 2 },
      { findingID: "f2", outcome: "revised", revision: 2 },
    ],
  })
  expect(result.refused).toEqual([{ id: "f1", reason: "field unchanged since r1" }])
  expect(f.store.findings(PID).map((x) => [x.id, x.resolution])).toEqual([
    ["f1", "open"],
    ["f2", "revised"],
  ])
})

test("questions on one field are suggested for merging and a merge leaves one open", async () => {
  const f = fixture()
  f.finding("f1", "write-scope")
  f.finding("f2", "write-scope", "minor", "grounding")
  f.question("q1", { findingId: "f1", text: "Which file?" })
  f.question("q2", { findingId: "f2", text: "Where does it go?", source: "grounding" })
  const first = await f.run({})
  expect(first.suggestedMerges).toEqual([["q1", "q2"]])
  const merged = await f.run({ questions: [{ questionID: "q2", route: "merged", into: "q1" }] })
  expect(merged.suggestedMerges).toEqual([])
  expect(f.store.questions(PID).filter((q) => q.route === "open")).toHaveLength(1)
})

test("the owner batch lists design, then scope, then detail, as numbered lines", async () => {
  const f = fixture()
  f.finding("f1", "objective", "minor")
  f.finding("f2", "write-scope", "major")
  f.finding("f3", "design-decision", "blocker", "zoom-out")
  f.question("q1", {
    findingId: "f1",
    weight: "changes-detail",
    text: "What default?",
    options: ["a", "b"],
  })
  f.question("q2", { findingId: "f2", weight: "changes-scope", text: "Which file?" })
  f.question("q3", {
    findingId: "f3",
    weight: "changes-design",
    text: "Own table or extend?",
    source: "zoom-out",
    options: ["own", "extend"],
  })
  const result = await f.run({
    questions: ["q1", "q2", "q3"].map((questionID) => ({ questionID, route: "owner" })),
  })
  expect(result.ownerBatch).toBe(
    [
      "1. Own table or extend? (own / extend) — zoom-out, plan-link.design-decision",
      "2. Which file? — critic, plan-link.write-scope",
      "3. What default? (a / b) — critic, plan-link.objective",
    ].join("\n"),
  )
  expect(result.openCount).toBe(6)
})

test("a finding passed to the owner and its answered question show answered", async () => {
  const f = fixture()
  f.finding("f1", "write-scope")
  f.question("q1", { findingId: "f1", text: "Which file?" })
  await f.run({
    findings: [{ findingID: "f1", outcome: "to-owner" }],
    questions: [{ questionID: "q1", route: "owner-answered", answer: "src/b.ts", messageID: "m9" }],
  })
  const view = planningView(f.store, "proj", PID)!
  expect(view.findings[0]!.resolution).toBe("answered")
  const rows = planningViewModel(view).find((s) => s.id === "findings")!.rows
  expect(rows[0]!.text).toContain("— answered")
  expect(planningViewModel(view).find((s) => s.id === "questions")!.rows[0]!.text).toContain(
    "owner-answered: src/b.ts",
  )
})
