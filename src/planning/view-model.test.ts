import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { fieldHashes, PlanningBody, validateBody } from "./draft.ts"
import { planningView } from "./read.ts"
import { PlanningStore } from "./store.ts"
import { planningViewModel, type PlanningView } from "./view-model.ts"

const cleanup: (() => void)[] = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
})

const proposal = (writeScope: string) => ({
  objective: "Open a stored plan from a chat link.",
  exclusions: [],
  constraints: [],
  assumptions: [],
  writeScope: [writeScope],
  context: [],
  acceptance: [{ id: "done", assertion: "It works.", evidence: [] }],
  requirements: { capabilities: [], skills: [], risk: "low" },
  verification: [{ id: "unit", command: "bun test --timeout 120000 x" }],
})
const bodyAt = (scope: string) =>
  PlanningBody.parse({
    title: "Plan",
    ask: "ask",
    plan: { objective: "o", verification: [], acceptance: [] },
    tasks: [{ draftID: "plan-link", proposal: proposal(scope) }],
  })

function stored() {
  const root = mkdtempSync(join(tmpdir(), "lazers-plan-view-"))
  const repository = new TaskRepository(join(root, "tasks.sqlite"), root)
  cleanup.push(() => {
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  const store = new PlanningStore(repository)
  store.createPlanning({
    id: "p1",
    projectKey: "proj",
    projectDirectory: root,
    sessionId: "s",
    title: "Plan",
    createdAt: 1,
    updatedAt: 1,
  })
  for (const scope of ["src/a.ts", "src/b.ts"]) {
    const body = bodyAt(scope)
    store.appendRevision("p1", undefined, body, validateBody(body), fieldHashes(body))
  }
  return store
}

test("a finding on a changed field shows stale (r1) and an unchanged one does not", () => {
  const store = stored()
  const finding = (id: string, field: string) =>
    store.addFinding({
      id,
      planningId: "p1",
      reviewId: "r",
      runId: "u",
      source: "critic",
      revision: 1,
      draftId: "plan-link",
      field,
      severity: "major",
      body: JSON.stringify({ what: `about ${field}` }),
    })
  finding("f1", "write-scope")
  finding("f2", "objective")
  const view = planningView(store, "proj", "p1")!
  expect(view.findings.map((f) => [f.id, f.stale])).toEqual([
    ["f1", true],
    ["f2", false],
  ])
  const rows = planningViewModel(view).find((s) => s.id === "findings")!.rows
  expect(rows[0]!.text).toContain("stale (r1)")
  expect(rows[1]!.text).not.toContain("stale")
  expect(planningView(store, "other", "p1")).toBeUndefined()
})

test("a failed agent shows not-run; absent cost shows no cost row", () => {
  const store = stored()
  store.createReview({
    id: "rv",
    planningId: "p1",
    revision: 2,
    stage: "review",
    selectionJson: "[]",
    createdAt: 1,
  })
  store.createRun({
    id: "u1",
    reviewId: "rv",
    agent: "grounding",
    attempt: 1,
    state: "starting",
    startedAt: 1,
  })
  store.moveRun("u1", "starting", "running")
  store.moveRun("u1", "running", "failed", {
    reason: "interrupted",
    durationMs: 90_000,
    inputTokens: 1000,
  })
  const view = planningView(store, "proj", "p1")!
  const section = planningViewModel(view).find((s) => s.id === "review-rv")!
  expect(section.rows).toHaveLength(1)
  expect(section.rows[0]!.text).toContain("grounding: not-run")
  expect(section.rows.some((r) => r.text.startsWith("Cost"))).toBe(false)
  const priced: PlanningView = {
    ...view,
    reviews: view.reviews.map((r) => ({ ...r, costUSD: 0.83 })),
  }
  expect(
    planningViewModel(priced)
      .find((s) => s.id === "review-rv")!
      .rows.at(-1)!.text,
  ).toBe("Cost: $0.83")
})

test("a tasked draft shows its reference and what changed after review", () => {
  const store = stored()
  store.recordTasked({
    planningId: "p1",
    draftId: "plan-link",
    revision: 2,
    reference: "LZ-12",
    changedFieldsJson: JSON.stringify(["writeScope"]),
  })
  const rows = planningViewModel(planningView(store, "proj", "p1")!).find(
    (s) => s.id === "tasks",
  )!.rows
  expect(rows[0]!.text).toContain("LZ-12")
  expect(rows.map((r) => r.text)).toContain("changed after review: writeScope")
})
