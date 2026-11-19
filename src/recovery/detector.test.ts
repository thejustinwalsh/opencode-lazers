import { expect, test } from "bun:test"
import {
  concernIDFor,
  evaluateRules,
  isTakeoverAttempt,
  DETECTOR_THRESHOLDS,
  type RuleID,
} from "./detector.ts"
import type { TrajectoryFacts, TrajectoryTail } from "./trajectory-facts.ts"

const calm: TrajectoryFacts = {
  attempts: 1,
  verifyRounds: 1,
  verifyFailures: 0,
  repairsAndResumes: 0,
  interruptions: 0,
  reopenedAfterAccept: 0,
  repeatedHold: null,
  attemptMs: 30 * 60_000,
  tokens: 11_000_000,
  toolCalls: 117,
  costUSD: null,
}
const quiet: TrajectoryTail = {
  throughSequence: 9,
  trailingToolFailures: 0,
  callsWithoutFileChange: 3,
  tokensWithoutFileChange: 400_000,
  outOfScope: [],
  protectedWrites: [],
}
const evaluate = (
  facts: Partial<TrajectoryFacts>,
  tail: Partial<TrajectoryTail> = {},
  options: Parameters<typeof evaluateRules>[3] = {},
) => evaluateRules({ ...calm, ...facts }, { ...quiet, ...tail }, "attempt a", options)
const rules = (...args: Parameters<typeof evaluate>): RuleID[] =>
  evaluate(...args).map((f) => f.ruleID)
const t = DETECTOR_THRESHOLDS

test("a median task and quiet tail raise nothing; each rule fires at its threshold only", () => {
  expect(rules({})).toEqual([])
  // Size alone does not flag a landed-sized task: 75M tokens with no cycle is quiet.
  expect(rules({ tokens: 75_000_000 })).toEqual([])
  expect(rules({ verifyRounds: 3 })).toEqual([])
  expect(rules({ verifyFailures: 1, tokens: t.verifyFailureTokens })).toEqual([
    "verify-rounds-repeated",
  ])
  expect(rules({ verifyFailures: 1, tokens: t.verifyFailureTokens - 1 })).toEqual([])
  const cycles = { repairsAndResumes: t.repairCycles, tokens: t.repairCycleTokens }
  expect(rules(cycles)).toEqual(["repair-cycles-repeated"])
  expect(rules({ ...cycles, repairsAndResumes: t.repairCycles - 1 })).toEqual([])
  expect(rules({ reopenedAfterAccept: t.reopenedAfterAccept })).toEqual(["reopened-after-accept"])
  expect(rules({ reopenedAfterAccept: t.reopenedAfterAccept - 1 })).toEqual([])
  expect(rules({}, { tokensWithoutFileChange: t.tokensWithoutFileChange })).toEqual([
    "spend-without-file-change",
  ])
  expect(rules({ tokens: t.tokens })).toEqual(["token-spend-high"])
  expect(rules({ attemptMs: t.attemptMs })).toEqual(["worker-time-long"])
  expect(rules({ interruptions: t.interruptions })).toEqual(["interruptions-repeated"])
  expect(rules({ interruptions: t.interruptions - 1 })).toEqual([])
  expect(rules({ repeatedHold: { family: "check-failed", count: t.sameHoldFamily } })).toEqual([
    "hold-family-repeated",
  ])
  expect(rules({}, { outOfScope: ["a.ts", "b.ts"] })).toEqual([])
  expect(rules({}, { outOfScope: ["a.ts", "b.ts", "c.ts"] })).toEqual(["out-of-scope-write"])
  // One protected write is enough: it is the one hard scope boundary.
  expect(rules({}, { protectedWrites: [".env"] })).toEqual(["out-of-scope-write"])
  expect(rules({}, { trailingToolFailures: t.trailingToolFailures })).toEqual([
    "tool-failures-repeated",
  ])
  expect(rules({}, { callsWithoutFileChange: t.callsWithoutFileChange })).toEqual([
    "no-file-changes",
  ])
})

test("each rule advises one action from the recovery vocabulary and names the tool", () => {
  const advice = (facts: Partial<TrajectoryFacts>, tail: Partial<TrajectoryTail> = {}) =>
    evaluate(facts, tail).map((f) => [f.ruleID, f.action, f.because])
  const [verify] = advice({ verifyFailures: 1, tokens: 60_000_000 })
  expect(verify).toMatchObject([
    "verify-rounds-repeated",
    "steer",
    expect.stringContaining("lz-checkpoint-recovery-worker"),
  ])
  // The same failure after more spend is advice to take over.
  expect(evaluate({ verifyFailures: 1, tokens: t.verifyTakeoverTokens })[0]).toMatchObject({
    action: "takeover",
    because: expect.stringContaining("lz-request-handoff"),
  })
  expect(evaluate({ repairsAndResumes: 3, tokens: t.repairCycleTokens })[0]?.because).toContain(
    "takeover-submit",
  )
  expect(evaluate({ reopenedAfterAccept: 3 })[0]?.action).toBe("takeover")
  expect(evaluate({}, { tokensWithoutFileChange: 13_000_000 })[0]?.action).toBe("takeover")
  expect(evaluate({}, { trailingToolFailures: 6 })[0]).toMatchObject({ action: "steer" })
  expect(evaluate({}, { callsWithoutFileChange: 200 })[0]?.action).toBe("steer")
  expect(evaluate({ interruptions: 3 })[0]?.action).toBe("acknowledge")
  const scope = evaluate({}, { outOfScope: ["a", "b", "c"] })[0]
  expect(scope?.action).toBe("steer")
  expect(scope?.because).toContain("review the paths before accepting")
})

test("the spend ceiling is off unless set, then advises a takeover without blocking anything", () => {
  expect(rules({ tokens: 120_000_000 })).toEqual([])
  const found = evaluate({ tokens: 120_000_000 }, {}, { spendCeilingTokens: 100_000_000 })
  expect(found.map((f) => [f.ruleID, f.action, f.magnitude])).toEqual([
    ["spend-ceiling", "takeover", 120],
  ])
  expect(found[0]!.reason).toContain("past the 100M spend ceiling")
  expect(evaluate({ tokens: 99_000_000 }, {}, { spendCeilingTokens: 100_000_000 })).toEqual([])
})

test("an attempt whose policy carries a takeover is the Architect working, not a worker to watch", () => {
  expect(isTakeoverAttempt('{"takeover":{"planID":"p","reason":"r"}}')).toBe(true)
  expect(isTakeoverAttempt("{}")).toBe(false)
  expect(isTakeoverAttempt('{"takeover":null}')).toBe(false)
  expect(isTakeoverAttempt("not json")).toBe(false)
})

test("a concern id is stable per attempt and rule so replays address one concern", () => {
  const a = "11111111-1111-4111-8111-111111111111"
  expect(concernIDFor(a, "verify-rounds-repeated")).toBe(concernIDFor(a, "verify-rounds-repeated"))
  expect(concernIDFor(a, "verify-rounds-repeated")).not.toBe(concernIDFor(a, "no-file-changes"))
  expect(concernIDFor(a, "no-file-changes")).toMatch(/^[0-9a-f-]{36}$/)
})
