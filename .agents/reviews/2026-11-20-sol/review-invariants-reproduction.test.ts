import { expect, test } from "bun:test"
import { Window } from "happy-dom"
import { FallowPackage } from "../../../src/audit/contract.ts"
import type { FallowFinding } from "../../../src/audit/contract.ts"
import { dispositionsAfterRepair } from "../../../src/audit/fallow-dispositions.ts"
import { staleFinding, withExtraFindings } from "../../../src/audit/suppression-flow.ts"

// These tests assert observed defects, not the intended production behaviour.
// No fixtures, build outputs, network access or filesystem writes are involved.
function pkg(findings: FallowFinding[]): FallowPackage {
  return FallowPackage.parse({
    verdict: findings.length ? "warn" : "pass",
    base: "base",
    config: { source: "repo", classesNotChecked: [] },
    thresholds: { cyclomatic: 20, cognitive: 15 },
    findings,
    summary: { errors: 0, warnings: findings.length, inherited: 0 },
    timings: { elapsedMs: 0 },
  })
}

test("c20db866-1: synchronous observer-array assertion misses an actual mutation", () => {
  const window = new Window()
  const layer = window.document.createElement("div")
  const writes: string[] = []
  const observer = new window.MutationObserver((records) => {
    for (const record of records) writes.push(record.attributeName ?? "")
  })
  observer.observe(layer, { attributes: true })
  layer.setAttribute("data-defect", "changed")
  // This is the production test's assertion: it passes despite the real write above.
  expect(writes).toEqual([])
  const pending = observer.takeRecords()
  expect(pending).toHaveLength(1)
  expect(pending[0]?.attributeName).toBe("data-defect")
  observer.disconnect()
})

test("42c5ff4a-1: a same-file unrelated waiver marks fixed complexity suppressed", () => {
  const first = pkg([
    {
      id: "complexity:a.ts:fn",
      rule: "complexity",
      class: "complexity",
      severity: "warn",
      attribution: "introduced",
      file: "a.ts",
      line: 1,
      message: "complex function",
    },
  ])
  const after = pkg([
    {
      id: "suppression:a.ts:100",
      rule: "added-suppression",
      class: "diff-risk",
      severity: "warn",
      attribution: "introduced",
      file: "a.ts",
      line: 100,
      message: "suppressed an unrelated export",
      suppression: { kinds: ["unused-export"], reason: "consumed by AB-1" },
    },
  ])
  expect(dispositionsAfterRepair(first, after)).toEqual([
    {
      findingID: "complexity:a.ts:fn",
      severity: "warn",
      disposition: "suppressed",
      reason: "consumed by AB-1",
    },
  ])
})

test("581cf7e8-1: supplemental duplicate IDs make removal of one comment invisible", () => {
  const comments = [10, 20].map((line) =>
    staleFinding({
      path: "a.ts",
      line,
      origin: { issue_kind: "unused-export", reason: "consumed by AB-1" },
    }),
  )
  const first = withExtraFindings(pkg([]), comments)
  expect(first.findings).toHaveLength(2)
  expect(new Set(first.findings.map((finding) => finding.id)).size).toBe(1)
  const after = withExtraFindings(pkg([]), [comments[1]!])
  expect(dispositionsAfterRepair(first, after).map((finding) => finding.disposition)).toEqual([
    "remaining",
    "remaining",
  ])
})
