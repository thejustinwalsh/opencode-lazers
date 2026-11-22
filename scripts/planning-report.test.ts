import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../src/storage.ts"
import { PlanningStore, type DecisionRow } from "../src/planning/store.ts"
import { AGENT_ORDER } from "../src/planning/decision/tree.ts"
import type { Answers, Decider } from "../src/planning/decision/procedure.ts"
import { RunnerStore } from "../src/runner/store.ts"
import {
  decisionReport,
  outcomesReport,
  questionsReport,
  replayDecisions,
  reviewsReport,
} from "./planning-report.ts"

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
  const result = await repository.read((db) => replayDecisions(db, "whole", decider, {}, "yesno"))
  expect(result).toMatchObject({ strategy: "whole", compared: 11, skipped: 0 })
  expect(result.sizeAgree).toBe(8)
  expect(result.simpleOrComplexAgree).toBe(8)
  expect(now).toBeGreaterThan(0)
  expect(
    repository.read((db) => db.query("SELECT COUNT(*) n FROM planning_decisions").get()),
  ).toEqual(before)
})

function runs() {
  const { repository, store } = database()
  new RunnerStore(repository)
  store.createPlanning({
    id: "pl",
    projectKey: "proj",
    projectDirectory: "/p",
    sessionId: "s",
    title: "t",
    createdAt: 100,
    updatedAt: 100,
  })
  const run = (
    id: string,
    review: string,
    attempt: number,
    state: "reviewed" | "failed",
    over: Record<string, unknown> = {},
  ) =>
    store.createRun({
      id,
      reviewId: review,
      agent: "grounding",
      attempt,
      state,
      startedAt: 1,
      reason: null,
      maxGapMs: 1_000,
      durationMs: 10_000,
      inputTokens: 900,
      outputTokens: 100,
      ...over,
    } as never)
  for (const n of [1, 2, 3, 4])
    store.createReview({
      id: `rv${n}`,
      planningId: "pl",
      revision: 1,
      stage: "review",
      selectionJson: "{}",
      createdAt: 1,
    })
  run("a1", "rv1", 1, "reviewed")
  run("a2", "rv2", 1, "reviewed")
  run("a3", "rv3", 1, "reviewed")
  run("a4", "rv4", 1, "failed", { reason: "malformed: bad json", durationMs: 1_000 })
  run("a5", "rv4", 2, "failed", { reason: "malformed: bad json again", durationMs: 1_000 })
  return { repository, store }
}

test("reviews: per-agent not-run rate and reasons, and the measured quiet gap", () => {
  const { repository } = runs()
  const report = repository.read((db) => reviewsReport(db))
  expect(report.agents.grounding).toMatchObject({
    reviews: 4,
    notRun: 1,
    notRunRate: 1 / 4,
    reasons: { malformed: 1 },
    tokens: { p50: 1000, p95: 1000 },
  })
  expect(report.gaps.runs).toBe(3)
})

test("reviews: the quiet gap is the p99 of reviewed runs' longest gaps", () => {
  const { repository, store } = runs()
  store.createReview({
    id: "many",
    planningId: "pl",
    revision: 1,
    stage: "review",
    selectionJson: "{}",
    createdAt: 1,
  })
  for (let n = 1; n <= 60; n++)
    store.createRun({
      id: `m${n}`,
      reviewId: "many",
      agent: "critic",
      attempt: 1,
      state: "reviewed",
      startedAt: 1,
      maxGapMs: n * 1_000,
    })
  const { gaps } = repository.read((db) => reviewsReport(db))
  expect(gaps.maxGapP99Ms).toBe(60_000)
})

test("questions: counts by route", () => {
  const { repository, store } = runs()
  const routes = [
    "conversation",
    "conversation",
    "owner",
    "owner",
    "owner",
    "owner-answered",
    "owner-answered",
    "merged",
    "merged",
  ]
  routes.forEach((route, i) =>
    store.addQuestion({
      id: `q${i}`,
      planningId: "pl",
      reviewId: "rv1",
      source: "critic",
      revision: 1,
      body: "{}",
      route: route as never,
    }),
  )
  expect(repository.read((db) => questionsReport(db))).toEqual({
    raised: 9,
    conversation: 2,
    owner: 5,
    merged: 2,
  })
})

test("outcomes: a tasked plan's repairs and scope changes, the baseline, and the finding's prediction", () => {
  const { repository, store } = runs()
  const task = "11111111-1111-4111-8111-111111111111"
  repository.atomic((db) => {
    const plan = db.query(
      "INSERT INTO runner_plans(id,project_directory,owner,revision,version,state,body) VALUES(?,?,?,?,?,?,?)",
    )
    plan.run("P", "/p", "o", 1, 1, "integrated", "{}")
    plan.run("Q", "/p", "o", 1, 1, "integrated", "{}")
    const transition = db.query(
      "INSERT INTO runner_transitions(plan_id,task_id,version,event,payload,created_at) VALUES(?,?,?,?,?,?)",
    )
    transition.run("P", task, 1, "REPAIR", "{}", 1)
    transition.run("P", task, 2, "SCOPE_AMENDED", "{}", 2)
    transition.run(
      "P",
      null,
      3,
      "BLOCKED",
      JSON.stringify({ reason: "Combined verification bun test failed" }),
      3,
    )
    transition.run("Q", null, 1, "REPAIR", "{}", 1)
    transition.run("Q", null, 2, "REPAIR", "{}", 2)
  })
  store.recordTasked({
    planningId: "pl",
    draftId: "plan-link",
    revision: 1,
    taskId: task,
    reference: "LZ-1",
    planId: "P",
  })
  store.setTaskedPlan("pl", "P")
  store.addFinding({
    id: "f1",
    planningId: "pl",
    reviewId: "rv1",
    runId: "a1",
    source: "critic",
    revision: 1,
    draftId: "plan-link",
    field: "write-scope",
    body: "{}",
  })
  const report = repository.read((db) => outcomesReport(db))
  expect(report.planned).toMatchObject({
    plans: 1,
    repairs: 1,
    scopeAmended: 1,
    failedCombinedChecks: 1,
  })
  expect(report.baseline).toMatchObject({ plans: 1, repairs: 2 })
  expect(report.findings.list).toEqual([
    { findingID: "f1", draftID: "plan-link", field: "write-scope", predicted: true },
  ])
})

test("reviews: cost appears only when every run of the agent is priced", () => {
  const { repository } = runs()
  repository.atomic((db) =>
    db
      .query("UPDATE planning_runs SET model_json=?")
      .run(JSON.stringify({ providerID: "p", id: "m" })),
  )
  const priced = repository.read((db) =>
    reviewsReport(db, {}, () => ({ input: 1_000_000, output: 2_000_000 })),
  )
  // Five attempts of 900 in and 100 out, the failed ones too: spent tokens are cost.
  expect(priced.agents.grounding!.costUSD).toBeCloseTo(5 * (900 + 200))
  expect(
    repository.read((db) => reviewsReport(db, {}, () => undefined)).agents.grounding!.costUSD,
  ).toBeUndefined()
  expect(repository.read((db) => reviewsReport(db)).agents.grounding!.costUSD).toBeUndefined()
})

test("per-observation yes rates and agent bands are reported", () => {
  const { repository, store } = database()
  const band = (score: number) => (score >= 0.7 ? "yes" : score <= 0.3 ? "no" : "architect")
  const decision = (n: number, names: number, choice: number) =>
    store.recordDecision(
      row(n, {
        observationsJson: JSON.stringify({
          names_code: { score: names, nodeID: "0" },
          open_choice: { score: choice, nodeID: "0" },
        }),
        scoresJson: JSON.stringify({
          grounding: { score: names, band: band(names) },
          readiness: { score: choice, band: band(choice) },
        }),
      }),
    )
  decision(1, 0.9, 0.5)
  decision(2, 0.8, 0.1)
  decision(3, 0.2, 0.5)
  const report = repository.read((db) => decisionReport(db))
  if ("empty" in report) throw new Error("empty")
  expect(report.observations.names_code).toMatchObject({ yes: 2, unsure: 0, no: 1 })
  expect(report.observations.names_code!.yesRate).toBeCloseTo(2 / 3)
  expect(report.observations.open_choice).toMatchObject({ yes: 0, unsure: 2, no: 1 })
  expect(report.agentBands.grounding).toEqual({ yes: 2, architect: 0, no: 1 })
  expect(report.agentBands.readiness).toEqual({ yes: 0, architect: 2, no: 1 })
})

test("replay runs the observation form by default", async () => {
  const { repository } = fixture()
  const decider: Decider = {
    id: "local",
    model: "stub",
    available: () => ({ ok: true }),
    async ask(_state, questions) {
      const answers: Answers = {}
      for (const name of Object.keys(questions))
        answers[name] =
          name === "breadth"
            ? { type: "score", probabilities: { "0": 0.9, "1": 0.1, "2": 0 } }
            : { type: "noul", noul: 0.8 }
      return { answers, inputTokens: 10 }
    },
  }
  const result = await repository.read((db) => replayDecisions(db, "whole", decider))
  expect(result).toMatchObject({ strategy: "whole", compared: 11, skipped: 0 })
})
