import { expect, test } from "bun:test"
import { FallowPackage, type FallowFinding } from "./contract.ts"
import { dispositionsAfterRepair } from "./fallow-dispositions.ts"

const pkg = (findings: FallowFinding[]) =>
  FallowPackage.parse({
    verdict: findings.length ? "warn" : "pass",
    base: "base",
    config: { source: "repo", classesNotChecked: [] },
    thresholds: { cyclomatic: 20, cognitive: 15 },
    findings,
    summary: { errors: 0, warnings: findings.length, inherited: 0 },
    timings: { elapsedMs: 0 },
  })

const introduced = (rule: string, file = "a.ts"): FallowFinding => ({
  id: `${rule}:${file}:x`,
  rule,
  class: rule === "complexity" ? "complexity" : "dead-code",
  severity: "warn",
  attribution: "introduced",
  file,
  line: 1,
  message: rule,
})
const waiver = (kinds: string[], file = "a.ts"): FallowFinding => ({
  id: `suppression:${file}:${kinds.join(",")}`,
  rule: "added-suppression",
  class: "diff-risk",
  severity: "warn",
  attribution: "introduced",
  file,
  line: 100,
  message: "suppressed",
  suppression: { kinds, reason: "consumed by AB-1" },
})

test("42c5ff4a-1: a waiver for another rule in the same file does not suppress a fixed finding", () => {
  const first = pkg([introduced("complexity"), introduced("unused-export")])
  const after = pkg([waiver(["unused-export"])])
  expect(dispositionsAfterRepair(first, after).map((d) => [d.findingID, d.disposition])).toEqual([
    ["complexity:a.ts:x", "fixed"],
    ["unused-export:a.ts:x", "suppressed"],
  ])
})

test("a waiver naming no kind covers every rule of its file, but not another file", () => {
  const first = pkg([introduced("complexity"), introduced("complexity", "b.ts")])
  expect(dispositionsAfterRepair(first, pkg([waiver([])])).map((d) => d.disposition)).toEqual([
    "suppressed",
    "fixed",
  ])
})
