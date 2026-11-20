import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Delivery, GuidanceLedger, pointer, runbook, runbooks } from "./index.ts"
import { FallowAcceptance } from "../audit/contract.ts"
import { coalescedOutcomeText, outcomeText } from "../runner/outcome.ts"
import { divergenceReason } from "../runner/scope.ts"

const here = import.meta.dir
const src = join(here, "..")

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

test("every runbook file is registered and every registered runbook is rendered by a notice or result", () => {
  const files = readdirSync(here).filter((name) => name.endsWith(".md"))
  const index = readFileSync(join(here, "index.ts"), "utf8")
  for (const file of files) expect(index).toContain(`"./${file}"`)
  expect(files.length).toBe(Object.keys(runbooks).length)
  const renderers = sources(src)
    .filter((path) => path !== join(here, "index.ts"))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n")
  for (const topic of Object.keys(runbooks))
    expect(renderers).toMatch(new RegExp(`(runbook|once)\\(\\s*"${topic}"`))
})

test("no runbook sentence is also written in a standing prompt", () => {
  const prompts = ["../architect.md", "../implementor.md"].map((path) =>
    readFileSync(join(here, path), "utf8").replace(/\s+/g, " "),
  )
  for (const [topic, text] of Object.entries(runbooks))
    for (const line of text.split("\n").filter((l) => l.length > 50))
      for (const prompt of prompts)
        expect(prompt, `${topic}: ${line}`).not.toContain(line.trim().replace(/\s+/g, " "))
})

const finding = {
  id: "f1",
  rule: "added-suppression",
  class: "dead-code",
  severity: "warn",
  attribution: "introduced",
  file: "src/a.ts",
  line: 3,
  message: "suppression added",
  suppression: { kinds: ["unused-export"], reason: "consumed by LZ-1" },
}
const fallow = FallowAcceptance.parse({
  package: {
    verdict: "warn",
    base: "a",
    config: { source: "repo", classesNotChecked: [] },
    thresholds: { cyclomatic: 20, cognitive: 15 },
    findings: [finding],
    summary: { errors: 0, warnings: 1, inherited: 0 },
    timings: { elapsedMs: 1 },
  },
})
const accepted = JSON.stringify({ status: "task-accepted", fallow })
const planAccepted = JSON.stringify({ status: "accepted", fallow })

test("the suppression runbook rides the first suppression notice of a plan and a pointer follows", () => {
  const ledger = new GuidanceLedger()
  const first = new Delivery("architect-1", ledger)
  const one = coalescedOutcomeText([{ planID: "p1", payload: accepted }], "LZ", first)
  expect(one).toContain(runbook("fallow-suppressions"))
  // Not committed yet (the send failed): the runbook is sent again.
  const retry = new Delivery("architect-1", ledger)
  expect(coalescedOutcomeText([{ planID: "p1", payload: accepted }], "LZ", retry)).toContain(
    runbook("fallow-suppressions"),
  )
  retry.commit()
  const later = new Delivery("architect-1", ledger)
  const two = coalescedOutcomeText([{ planID: "p1", payload: accepted }], "LZ", later)
  expect(two).not.toContain(runbook("fallow-suppressions"))
  expect(two).toContain(pointer("fallow-suppressions"))
  expect(two).toContain('mode: "guide", topic: "suppressions"')
  // Another plan, and another session, each start with the runbook.
  expect(
    coalescedOutcomeText(
      [{ planID: "p2", payload: accepted }],
      "LZ",
      new Delivery("architect-1", ledger),
    ),
  ).toContain(runbook("fallow-suppressions"))
  expect(
    coalescedOutcomeText(
      [{ planID: "p1", payload: accepted }],
      "LZ",
      new Delivery("architect-2", ledger),
    ),
  ).toContain(runbook("fallow-suppressions"))
})

test("one notice naming the same plan twice carries the runbook once", () => {
  const text = coalescedOutcomeText(
    [
      { planID: "p1", payload: accepted },
      { planID: "p1", payload: accepted },
    ],
    "LZ",
    new Delivery("architect-1", new GuidanceLedger()),
  )
  expect(text.split(runbook("fallow-suppressions")).length - 1).toBe(1)
  expect(text).toContain(pointer("fallow-suppressions"))
})

test("the combined-plan notice and a render without a delivery carry the full runbook", () => {
  expect(outcomeText(planAccepted)).toContain(runbook("fallow-suppressions"))
  expect(outcomeText(accepted)).toContain(runbook("fallow-suppressions"))
})

test("a Fallow notice with no suppression carries no suppression runbook", () => {
  const clean = FallowAcceptance.parse({
    package: {
      ...fallow.package,
      findings: [{ ...finding, suppression: undefined, rule: "complexity" }],
    },
  })
  expect(outcomeText(JSON.stringify({ status: "task-accepted", fallow: clean }))).not.toContain(
    runbook("fallow-suppressions"),
  )
})

test("a scope divergence hold notice carries the decision runbook; other holds do not", () => {
  const reason = divergenceReason({
    attemptID: "a",
    created: [],
    missingExpected: [],
    divergences: [{ path: "src/x.ts", status: "modified", added: 1, removed: 0, scopedBy: [] }],
    accepted: [],
    warnings: [],
  })
  expect(outcomeText(JSON.stringify({ status: "blocked", reason }))).toContain(
    runbook("scope-divergence"),
  )
  expect(
    outcomeText(JSON.stringify({ status: "blocked", reason: "Dispatch failed" })),
  ).not.toContain(runbook("scope-divergence"))
})

test("no standing prompt, tool description or task instruction names this repository's commands", () => {
  const files = ["../architect.md", "../implementor.md", "../tasks/instructions.ts", "../task.ts"]
  for (const file of files) {
    const text = readFileSync(join(here, file), "utf8")
    for (const phrase of ["bun run verify", "For LAZERS", "In LAZERS"])
      expect(text, `${file} contains "${phrase}"`).not.toContain(phrase)
  }
})

test("the planning runbooks exist, are retrievable, and the Architect's prompt grew by one short paragraph", () => {
  expect(runbook("planning-brainstorm").length).toBeGreaterThan(0)
  expect(pointer("planning-draft")).toContain(
    '`lz-plan-draft` with `action: "guide", topic: "draft"`',
  )
  const architect = readFileSync(join(here, "../architect.md"), "utf8")
  expect(architect).toContain("lz-plan-draft")
  // The file was 13,507 characters before the planning paragraph.
  expect(architect.length).toBeLessThanOrEqual(13_507 + 600)
  for (const topic of [
    "planning-draft",
    "planning-brainstorm",
    "planning-resolve",
    "planning-show",
  ])
    expect(runbook(topic as never)).not.toContain("not written yet")
})
