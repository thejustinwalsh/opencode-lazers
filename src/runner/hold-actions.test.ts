import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
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
  // Every non-test runner module can raise a hold (the runtime was split into siblings),
  // so scan them all; the call may sit on `this`, a bound alias or the journal.
  // Only plan holds count: outcome-delivery has an unrelated outbox `hold(rows, EVENT_NAME)`.
  const directory = new URL("./", import.meta.url)
  const modules = readdirSync(directory).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"),
  )
  const reasons: string[] = []
  for (const name of modules) {
    const source = readFileSync(new URL(name, directory), "utf8")
    for (const match of source.matchAll(
      /\bhold\(\s*plan,\s*(?:"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/g,
    ))
      reasons.push((match[1] ?? match[2] ?? "").replace(/\$\{[^}]*\}/g, "x"))
  }
  expect(reasons.length).toBeGreaterThan(20)
  const unclassified = reasons.filter((reason) => !holdFamily(reason))
  expect(unclassified).toEqual([])
})
