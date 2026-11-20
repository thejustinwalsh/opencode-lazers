import { expect, test } from "bun:test"
import {
  PLANNING_AGENT_IDS,
  PlanningResult,
  parsePlanningResult,
  type PlanningFinding,
} from "./contract.ts"

const finding = (over: Partial<PlanningFinding> = {}): PlanningFinding => ({
  id: "f1",
  severity: "major",
  confidence: "confirmed",
  target: { unit: "Task 2", field: "write-scope" },
  what: "The check imports src/a.ts which the write scope leaves out.",
  failureScenario: "The worker cannot update the import, so the check fails after its change.",
  evidence: ["src/a.ts:12", '"writeScope: src/b.ts"'],
  suggestion: "Add src/a.ts to the write scope.",
  ...over,
})

for (const agent of PLANNING_AGENT_IDS) {
  test(`a valid reviewed sample for ${agent}`, () => {
    const result = {
      agent,
      status: "reviewed",
      checked: ["Task 1 objective restated and matches"],
      findings: [finding()],
      questions: [
        {
          id: "q1",
          question: "Should old rows be migrated?",
          why: "Adds a migration task if yes.",
          options: ["Migrate", "Leave in place"],
          relatedFinding: "f1",
          weight: "changes-scope",
        },
      ],
    }
    expect(PlanningResult.parse(result).agent).toBe(agent)
    expect(parsePlanningResult(JSON.stringify(result)).agent).toBe(agent)
  })
}

test("not-run needs a reason and may carry partial output", () => {
  const ok = {
    agent: "grounding",
    status: "not-run",
    reason: "Ran out of context after 3 of 9 tasks",
    checked: ["Task 1 claims"],
    findings: [],
    questions: [],
  }
  expect(PlanningResult.parse(ok).status).toBe("not-run")
  expect(PlanningResult.safeParse({ ...ok, reason: undefined }).success).toBe(false)
  expect(PlanningResult.safeParse({ ...ok, status: "reviewed" }).success).toBe(false)
})

test("a reviewed result that checked nothing and found nothing is rejected", () => {
  const empty = { agent: "critic", status: "reviewed", checked: [], findings: [], questions: [] }
  expect(PlanningResult.safeParse(empty).success).toBe(false)
})

test("a finding without evidence is rejected unless it is a suspicion", () => {
  const wrap = (f: PlanningFinding) => ({
    agent: "critic",
    status: "reviewed",
    checked: [],
    findings: [f],
    questions: [],
  })
  expect(PlanningResult.safeParse(wrap(finding({ evidence: [] }))).success).toBe(false)
  expect(
    PlanningResult.safeParse(wrap(finding({ evidence: [], confidence: "likely" }))).success,
  ).toBe(false)
  expect(
    PlanningResult.safeParse(wrap(finding({ evidence: [], confidence: "suspicion" }))).success,
  ).toBe(true)
})

test("duplicate ids, dangling relatedFinding and bad option counts are rejected", () => {
  const base = { agent: "zoom-out", status: "reviewed", checked: ["x"], questions: [] }
  expect(PlanningResult.safeParse({ ...base, findings: [finding(), finding()] }).success).toBe(
    false,
  )
  const question = {
    id: "q1",
    question: "Which?",
    why: "Changes the task list.",
    weight: "changes-detail",
  }
  expect(
    PlanningResult.safeParse({
      ...base,
      findings: [],
      questions: [{ ...question, relatedFinding: "nope" }],
    }).success,
  ).toBe(false)
  expect(
    PlanningResult.safeParse({
      ...base,
      findings: [],
      questions: [{ ...question, options: ["a"] }],
    }).success,
  ).toBe(false)
  expect(PlanningResult.safeParse({ ...base, findings: [], questions: [question] }).success).toBe(
    true,
  )
})

test("unknown keys and unknown severity are rejected; a fenced reply parses", () => {
  const base = {
    agent: "readiness",
    status: "reviewed",
    checked: ["x"],
    findings: [],
    questions: [],
  }
  expect(PlanningResult.safeParse({ ...base, extra: 1 }).success).toBe(false)
  expect(
    PlanningResult.safeParse({ ...base, findings: [finding({ severity: "critical" as never })] })
      .success,
  ).toBe(false)
  expect(parsePlanningResult("```json\n" + JSON.stringify(base) + "\n```").agent).toBe("readiness")
})
