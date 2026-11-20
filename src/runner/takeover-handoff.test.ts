import { expect, test } from "bun:test"
import { normalizeWorkerHandoff } from "./takeover.ts"

test("7abe4acd-1: a long handoff field and a long raw payload keep their final text", () => {
  const warning = "CRITICAL: do not rebase, the migration is half applied"
  const handoff = normalizeWorkerHandoff({
    remaining: `${"x".repeat(9_000)} ${warning}`,
    extra: `${"y".repeat(9_000)} ${warning}`,
  })
  expect(handoff.remaining?.endsWith(warning)).toBe(true)
  expect(handoff.raw?.includes(warning)).toBe(true)
  expect(normalizeWorkerHandoff(`${"z".repeat(9_000)} ${warning}`).raw?.endsWith(warning)).toBe(true)
})
