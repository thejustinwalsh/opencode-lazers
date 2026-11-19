import { expect, test } from "bun:test"
import {
  concernIDFor,
  evaluateRules,
  DETECTOR_THRESHOLDS,
  type TrajectoryTail,
} from "./detector.ts"
import type { StrugglingFacts } from "../runner/struggling.ts"

const calm: StrugglingFacts = {
  attempts: 1,
  verifyRounds: 1,
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
  outOfScope: [],
}
const rules = (facts: Partial<StrugglingFacts>, tail: Partial<TrajectoryTail> = {}) =>
  evaluateRules({ ...calm, ...facts }, { ...quiet, ...tail }, "attempt a").map((f) => f.ruleID)

test("a median task and quiet tail raise nothing; each rule fires at its threshold only", () => {
  const t = DETECTOR_THRESHOLDS
  expect(rules({})).toEqual([])
  expect(rules({ verifyRounds: t.verifyRounds })).toEqual(["verify-rounds-repeated"])
  expect(rules({ verifyRounds: t.verifyRounds - 1 })).toEqual([])
  expect(rules({ repairsAndResumes: t.repairsAndResumes })).toEqual(["repair-cycles-repeated"])
  expect(rules({ attemptMs: t.attemptMs })).toEqual(["worker-time-long"])
  expect(rules({ tokens: t.tokens })).toEqual(["token-spend-high"])
  expect(rules({ interruptions: t.interruptions })).toEqual(["interruptions-repeated"])
  expect(rules({ reopenedAfterAccept: t.reopenedAfterAccept })).toEqual(["reopened-after-accept"])
  expect(rules({ repeatedHold: { family: "check-failed", count: t.sameHoldFamily } })).toEqual([
    "hold-family-repeated",
  ])
  expect(rules({}, { outOfScope: ["docs/x.md"] })).toEqual(["out-of-scope-write"])
  expect(rules({}, { trailingToolFailures: t.trailingToolFailures })).toEqual([
    "tool-failures-repeated",
  ])
  expect(rules({}, { callsWithoutFileChange: t.callsWithoutFileChange })).toEqual([
    "no-file-changes",
  ])
})

test("a concern id is stable per attempt and rule so replays address one concern", () => {
  const a = "11111111-1111-4111-8111-111111111111"
  expect(concernIDFor(a, "verify-rounds-repeated")).toBe(concernIDFor(a, "verify-rounds-repeated"))
  expect(concernIDFor(a, "verify-rounds-repeated")).not.toBe(concernIDFor(a, "no-file-changes"))
  expect(concernIDFor(a, "no-file-changes")).toMatch(/^[0-9a-f-]{36}$/)
})
