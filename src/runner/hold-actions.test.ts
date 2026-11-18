import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  FALLBACK_HOLD_ACTIONS,
  HOLD_FAMILIES,
  holdActions,
  holdFamily,
  unblockingActions,
} from "./hold-actions.ts"

test("every hold reason family advertises at least one unblocking action", () => {
  for (const family of HOLD_FAMILIES)
    expect(unblockingActions(family.actions).length, family.name).toBeGreaterThan(0)
  expect(unblockingActions(FALLBACK_HOLD_ACTIONS).length).toBeGreaterThan(0)
})

test("every family can always be cancelled", () => {
  for (const family of HOLD_FAMILIES) expect(family.actions, family.name).toContain("cancel")
})

test("a hold never advertises audit alone", () => {
  for (const reason of ["anything", "Required evidence missing: a", "Dispatch failed for x: y"])
    expect(unblockingActions(holdActions(reason, ["audit"])).length).toBeGreaterThan(0)
})

test("requested actions are kept and merged with the family's unblocking actions", () => {
  const actions = holdActions("Commit task edits before verification", ["amend-scope", "audit"])
  expect(actions).toContain("amend-scope")
  expect(actions).toContain("resume")
  expect(actions).toContain("audit")
})

test("every literal hold reason in the runtime maps to a named family", () => {
  const source = readFileSync(new URL("./runtime.ts", import.meta.url), "utf8")
  const reasons: string[] = []
  for (const match of source.matchAll(
    /this\.hold\(\s*(?:plan|current),\s*(?:"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/g,
  ))
    reasons.push((match[1] ?? match[2] ?? "").replace(/\$\{[^}]*\}/g, "x"))
  expect(reasons.length).toBeGreaterThan(20)
  const unclassified = reasons.filter((reason) => !holdFamily(reason))
  expect(unclassified).toEqual([])
})
