import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { PlanningStore, installPlanningSchema, type DecisionRow } from "./store.ts"

const cleanup: (() => void)[] = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lazers-planning-store-"))
  const repository = new TaskRepository(join(root, "tasks.sqlite"), root)
  cleanup.push(() => {
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  const store = new PlanningStore(repository)
  const planning = (id = "p1") => {
    store.createPlanning({
      id,
      projectKey: "proj",
      projectDirectory: root,
      sessionId: "s1",
      title: "Plan",
      createdAt: 1,
      updatedAt: 1,
    })
    return id
  }
  return { repository, store, planning }
}

const decision = (id: string, ask: string): DecisionRow => ({
  id,
  projectKey: "proj",
  sessionId: "s1",
  messageId: "m1",
  createdAt: 1,
  askText: ask,
  askChars: ask.length,
  status: "decided",
})

test("installing the schema twice is a no-op", () => {
  const { repository } = fixture()
  installPlanningSchema(repository)
  installPlanningSchema(repository)
  const tables = repository.read((db) =>
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name LIKE 'planning_%'")
      .all(),
  )
  expect(tables.map((row) => row.name)).toContain("planning_tasked")
})

test("recording the same session and message decision twice keeps the first row", () => {
  const { store } = fixture()
  const node = (decisionId: string) => ({ decisionId, nodeId: "root", depth: 0 })
  expect(store.recordDecision(decision("d1", "first"), [node("d1")])).toBe(true)
  expect(store.recordDecision(decision("d2", "second"), [node("d2")])).toBe(false)
  expect(store.decision("s1", "m1")?.askText).toBe("first")
  expect(store.decisionNodes("d2")).toEqual([])
  expect(store.decisionNodes("d1")).toHaveLength(1)
})

test("a revision written from a stale revision reports a conflict and writes nothing", () => {
  const { store, planning } = fixture()
  const id = planning()
  expect(store.appendRevision(id, undefined, { a: 1 }, {}, {})).toEqual({ revision: 1 })
  expect(store.appendRevision(id, 1, { a: 2 }, {}, {})).toEqual({ revision: 2 })
  expect(store.appendRevision(id, 1, { a: 3 }, {}, {})).toEqual({ conflict: 2 })
  expect(store.revisions(id).map((row) => row.revision)).toEqual([1, 2])
  expect(store.planning(id)?.revision).toBe(2)
  expect(JSON.parse(store.revision(id, 2)!.body)).toEqual({ a: 2 })
})

test("a planning moves only along its machine, and the SQL function refuses the rest", () => {
  const { store, planning } = fixture()
  const id = planning()
  expect(() => store.move(id, "final-review")).toThrow("Invalid planning transition")
  expect(store.planning(id)?.state).toBe("drafted")
  expect(store.move(id, "tasked")).toBe("tasked")
  expect(store.planning(id)?.state).toBe("tasked")
  expect(() => store.move(id, "drafted")).toThrow("Invalid planning transition")
})

test("moving a run from a stale state changes 0 rows", () => {
  const { store, planning } = fixture()
  const id = planning()
  store.createReview({
    id: "r1",
    planningId: id,
    revision: 1,
    stage: "review",
    selectionJson: "[]",
    createdAt: 1,
  })
  store.createRun({
    id: "run1",
    reviewId: "r1",
    agent: "critic",
    attempt: 1,
    state: "starting",
    startedAt: 1,
  })
  expect(store.moveRun("run1", "running", "reviewed")).toBe(0)
  expect(store.run("run1")?.state).toBe("starting")
  expect(store.moveRun("run1", "starting", "running", { sessionId: "c1" })).toBe(1)
  expect(store.run("run1")).toMatchObject({ state: "running", sessionId: "c1" })
  expect(store.moveRun("run1", "running", "stuck", { reason: "inactive" })).toBe(1)
  expect(() => store.moveRun("run1", "stuck", "running")).toThrow("Invalid planningRun transition")
})

test("findings, questions and tasked mappings round-trip", () => {
  const { store, planning } = fixture()
  const id = planning()
  store.addFinding({
    id: "f1",
    planningId: id,
    reviewId: "r1",
    runId: "run1",
    source: "critic",
    revision: 1,
    draftId: "a",
    field: "objective",
    body: "{}",
  })
  expect(store.findings(id)[0]).toMatchObject({ resolution: "open", draftId: "a" })
  store.updateFinding("f1", { resolution: "revised", resolvedRevision: 2 })
  expect(store.findings(id)[0]).toMatchObject({ resolution: "revised", resolvedRevision: 2 })
  store.addQuestion({
    id: "q1",
    planningId: id,
    reviewId: "r1",
    source: "critic",
    revision: 1,
    body: "{}",
  })
  store.updateQuestion("q1", { route: "owner" })
  expect(store.questions(id)[0]?.route).toBe("owner")
  store.recordTasked({ planningId: id, draftId: "a", revision: 2, taskId: "t1" })
  expect(store.tasked(id)).toHaveLength(1)
})
