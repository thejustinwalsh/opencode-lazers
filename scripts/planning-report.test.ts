import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../src/storage.ts"
import { PlanningStore, type DecisionRow } from "../src/planning/store.ts"
import { AGENT_ORDER } from "../src/planning/decision/tree.ts"
import type { Answers, Decider } from "../src/planning/decision/procedure.ts"
import { decisionReport, replayDecisions } from "./planning-report.ts"

const cleanup: (() => void)[] = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
})

function database() {
  const root = mkdtempSync(join(tmpdir(), "lazers-planning-report-"))
  const repository = new TaskRepository(join(root, "tasks.sqlite"), root)
  cleanup.push(() => {
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { repository, store: new PlanningStore(repository) }
}

const scores = (picked: string[]) =>
  JSON.stringify(
    Object.fromEntries(AGENT_ORDER.map((id) => [id, { score: picked.includes(id) ? 0.6 : 0.1 }])),
  )

function row(n: number, over: Partial<DecisionRow>): DecisionRow {
  return {
    id: `d${n}`,
    projectKey: "proj",
    sessionId: "s",
    messageId: `m${n}`,
    createdAt: 1000 + n,
    askText: `Ask number ${n}. It has two sentences.`,
    askChars: 30,
    strategy: "windows",
    status: "decided",
    size: "a few tasks",
    selectedJson: JSON.stringify(["grounding"]),
    scoresJson: scores(["grounding"]),
    ...over,
  }
}

function fixture() {
  const { repository, store } = database()
  const node = (id: string, chars: number, elapsedMs: number) => ({
    decisionId: id,
    nodeId: "0",
    depth: 0,
    spanStart: 0,
    spanEnd: chars,
    callsJson: JSON.stringify([
      { questions: ["size"], probabilities: {}, elapsedMs, inputTokens: 1 },
    ]),
  })
  for (let n = 1; n <= 3; n++)
    store.recordDecision(row(n, { size: "one task", selectedJson: "[]" }), [
      node(`d${n}`, 100, 40 * n),
    ])
  for (let n = 4; n <= 9; n++)
    store.recordDecision(
      row(n, { selectedJson: JSON.stringify(n <= 5 ? ["grounding", "critic"] : ["grounding"]) }),
      [node(`d${n}`, 600, 100 * (n - 3))],
    )
  for (let n = 10; n <= 11; n++)
    store.recordDecision(
      row(n, {
        status: "none",
        reason: "below-threshold",
        selectedJson: "[]",
        strategy: "uncertainty",
      }),
    )
  store.recordDecision(
    row(12, { status: "unavailable", size: null, selectedJson: null, scoresJson: null }),
  )
  return { repository, store }
}

test("the report prints the exact counts, rates and latency buckets", () => {
  const { repository } = fixture()
  const report = repository.read((db) => decisionReport(db))
  if ("empty" in report) throw new Error("empty")
  expect(report.decisions.total).toBe(12)
  expect(report.byStatus).toEqual({ decided: 9, none: 2, unavailable: 1 })
  expect(report.belowThresholdRate).toBeCloseTo(2 / 11)
  // Complex: the 6 decided "a few tasks" and the 2 "none" with that size: 8 decisions.
  expect(report.pickRate.grounding).toBeCloseTo(6 / 8)
  expect(report.pickRate.critic).toBeCloseTo(2 / 8)
  expect(report.flags).toEqual([])
  expect(report.strategies).toEqual({ windows: 10, uncertainty: 2 })
  expect(report.nodeLatency["0-256"]).toMatchObject({ calls: 3, p50Ms: 80, p95Ms: 120 })
  expect(report.nodeLatency["513-1024"]).toMatchObject({ calls: 6, p50Ms: 300, p95Ms: 600 })
})

test("an agent picked for nearly every complex ask is flagged", () => {
  const { repository, store } = database()
  for (let n = 1; n <= 10; n++) store.recordDecision(row(n, {}))
  const report = repository.read((db) => decisionReport(db))
  if ("empty" in report) throw new Error("empty")
  expect(report.flags).toEqual([{ agent: "grounding", flag: "picked-for-nearly-every-ask" }])
})

test("an empty database reports its counts instead of a report", () => {
  const { repository } = database()
  expect(repository.read((db) => decisionReport(db))).toEqual({ empty: { rows: 0, withText: 0 } })
})

test("a filter by project and time narrows the sample", () => {
  const { repository } = fixture()
  const report = repository.read((db) => decisionReport(db, { project: "other" }))
  expect("empty" in report).toBe(true)
  const since = repository.read((db) => decisionReport(db, { since: 1010 }))
  if ("empty" in since) throw new Error("empty")
  expect(since.decisions.total).toBe(3)
})

test("replay compares a strategy with the recorded decisions on the same asks and writes nothing", async () => {
  const { repository } = fixture()
  let now = 0
  const decider: Decider = {
    id: "local",
    model: "stub",
    available: () => ({ ok: true }),
    async ask(_s, questions) {
      now++
      const answers: Answers = {}
      for (const name of Object.keys(questions))
        answers[name] =
          name === "size"
            ? {
                type: "choice",
                choice: "x",
                probabilities: { "one task": 0.1, "a few tasks": 0.8, "a large effort": 0.1 },
                confidence: 0.8,
              }
            : { type: "noul", noul: 0.6 }
      return { answers, inputTokens: 10 }
    },
  }
  const before = repository.read((db) =>
    db.query("SELECT COUNT(*) n FROM planning_decisions").get(),
  )
  const result = await repository.read((db) => replayDecisions(db, "whole", decider))
  expect(result).toMatchObject({ strategy: "whole", compared: 11, skipped: 0 })
  expect(result.sizeAgree).toBe(8)
  expect(result.simpleOrComplexAgree).toBe(8)
  expect(now).toBeGreaterThan(0)
  expect(
    repository.read((db) => db.query("SELECT COUNT(*) n FROM planning_decisions").get()),
  ).toEqual(before)
})
