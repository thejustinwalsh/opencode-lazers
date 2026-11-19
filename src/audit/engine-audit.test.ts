import { expect, test } from "bun:test"
import fixtureOne from "./fixtures-o1.json"
import fixtureTwo from "./fixtures-o2.json"
import { buildPackage } from "./audit-findings.ts"
import { FallowPackage } from "./contract.ts"
import { parseEngineAudit } from "./engine-audit.ts"
import { renderNotice, renderRepair } from "./fallow-render.ts"
import { dispositionsAfterRepair } from "./fallow-dispositions.ts"

/** Reports captured from the engine's own audit (Fallow 3.43.2) on two hand-written repositories. */
const clone = <T>(value: T): T => structuredClone(value)
const context = {
  thresholds: { cyclomatic: 20, cognitive: 15 },
  maxCrap: 30,
  config: { source: "repo" as const, classesNotChecked: [] },
}

test("the captured engine reports satisfy the schema, and every field the engine adds fails it", () => {
  expect(() => parseEngineAudit(clone(fixtureOne))).not.toThrow()
  expect(() => parseEngineAudit(clone(fixtureTwo))).not.toThrow()
  const extraTop = { ...clone(fixtureOne), surprise: 1 }
  expect(() => parseEngineAudit(extraTop)).toThrow("analyzer-schema")
  const extraFinding = clone(fixtureOne) as any
  extraFinding.complexity.findings[0].surprise = true
  expect(() => parseEngineAudit(extraFinding)).toThrow("surprise")
})

test("a new enum value or dead-code list in a re-pinned engine fails instead of being dropped", () => {
  const severity = clone(fixtureOne) as any
  severity.diff_risk.findings[0].severity = "info"
  expect(() => parseEngineAudit(severity)).toThrow("analyzer-schema")
  const gate = clone(fixtureTwo) as any
  gate.complexity.findings.find((f: any) => f.gate_exemption).gate_exemption = "generated-file"
  expect(() => parseEngineAudit(gate)).toThrow("analyzer-schema")
  const rule = clone(fixtureOne) as any
  rule.diff_risk.findings[0].rule = "new-rule"
  expect(() => parseEngineAudit(rule)).toThrow("analyzer-schema")
  const list = clone(fixtureOne) as any
  list.dead_code.brand_new_findings = [{ path: "a.ts" }]
  expect(() => parseEngineAudit(list)).toThrow("unknown dead-code finding list")
})

test("the package is the schema end to end: errors, warnings and inherited are all present and typed", () => {
  const pkg = buildPackage(parseEngineAudit(clone(fixtureTwo)), context)
  expect(FallowPackage.parse(pkg)).toEqual(pkg)
  expect(pkg.verdict).toBe("fail")
  const byRule = (rule: string) => pkg.findings.find((f) => f.rule === rule)!
  expect(byRule("complexity")).toMatchObject({ severity: "error", attribution: "introduced" })
  expect(pkg.findings.find((f) => f.gateExemption === "test-file")).toMatchObject({
    severity: "warn",
    file: "test/big.test.ts",
  })
  expect(byRule("code-duplication")).toMatchObject({ severity: "warn", attribution: "introduced" })
  expect(byRule("unused-dependency")).toMatchObject({
    file: "package.json",
    attribution: "introduced",
  })
  expect(pkg.findings.some((f) => f.attribution === "inherited")).toBe(true)
  expect(pkg.summary.errors).toBeGreaterThan(0)
  expect(pkg.summary.warnings).toBeGreaterThan(0)
})

test("the repair text separates errors, warnings and context; the Architect notice carries dispositions", () => {
  const pkg = buildPackage(parseEngineAudit(clone(fixtureTwo)), context)
  const repair = renderRepair(pkg)
  expect(repair).toContain("Errors, fix these:")
  expect(repair).toContain(
    "Warnings, consider fixing: fix each, or say in one line why you leave it:",
  )
  expect(repair).toContain("Context, not introduced by this task")
  expect(repair).toContain("`// fallow-ignore-next-line complexity -- <reason>`")
  expect(repair.length).toBeLessThanOrEqual(4000)
  expect(renderRepair(pkg)).toBe(repair)

  const after = buildPackage(parseEngineAudit(clone(fixtureOne)), context)
  const dispositions = dispositionsAfterRepair(pkg, after)
  expect(
    dispositions.every((d) => ["fixed", "remaining", "suppressed"].includes(d.disposition)),
  ).toBe(true)
  const notice = renderNotice(pkg, [
    { findingID: "w", severity: "warn", disposition: "remaining" },
    { findingID: "e", severity: "error", disposition: "suppressed", reason: "legacy parser" },
    { findingID: "f", severity: "error", disposition: "fixed" },
  ])
  expect(notice).toContain("After the repair: 1 fixed, 1 remaining, 1 suppressed.")
  expect(notice).toContain("- warn w: remaining, no reason stated")
  expect(notice).toContain("- error e: suppressed, reason: legacy parser")
})

test("a finding id survives edits: no line number is part of it", () => {
  const first = buildPackage(parseEngineAudit(clone(fixtureTwo)), context)
  const moved = clone(fixtureTwo) as any
  for (const f of moved.complexity.findings) f.line += 40
  const second = buildPackage(parseEngineAudit(moved), context)
  expect(second.findings.map((f) => f.id).sort()).toEqual(first.findings.map((f) => f.id).sort())
})
