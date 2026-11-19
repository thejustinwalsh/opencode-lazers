import { expect, test } from "bun:test"
import { compareHealth, scoreOf } from "./health.ts"

const score = (value: number, grade: string, penalties: Record<string, number>) => ({
  health_score: { formula_version: 3, score: value, grade, penalties },
})

test("a stored health section yields the score, grade and penalties", () => {
  expect(scoreOf(score(83.6, "B", { unit_size: 10, coupling: 2.4 }))).toEqual({
    score: 83.6,
    grade: "B",
    formulaVersion: 3,
    penalties: { unit_size: 10, coupling: 2.4 },
  })
  expect(scoreOf({})).toBeUndefined()
})

test("two runs compare by score and per-penalty delta, worst growth first", () => {
  const before = scoreOf(score(83.6, "B", { unit_size: 10, coupling: 2.4, duplication: 0 }))
  const after = scoreOf(score(80.1, "B", { unit_size: 10, coupling: 4.9, duplication: 1.0 }))
  const run = "11111111-1111-4111-8111-111111111111"
  const comparison = compareHealth(run, before, after, true)
  expect(comparison.scoreDelta).toBe(-3.5)
  expect(comparison.penaltyDeltas[0]).toEqual({
    metric: "coupling",
    from: 2.4,
    to: 4.9,
    delta: 2.5,
  })
  expect(comparison.penaltyDeltas.find((d) => d.metric === "duplication")?.delta).toBe(1)
  // A run that left duplication out is not comparable on that penalty.
  expect(
    compareHealth(run, before, after, false).penaltyDeltas.some((d) => d.metric === "duplication"),
  ).toBe(false)
})
