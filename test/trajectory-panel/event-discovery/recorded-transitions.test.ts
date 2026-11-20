import { expect, test } from "bun:test"
import { discoverRecordedTransitions } from "./recorded-transitions.ts"

const fixture = async (name: string) => ({
  path: name,
  source: await Bun.file(name).text(),
})

test("finds recorded names through current writer, constant, and wrapper patterns", async () => {
  const source = await fixture(
    "test/trajectory-panel/event-discovery/fixtures/recorded-producers.ts",
  )

  expect(discoverRecordedTransitions([source])).toEqual([
    "CONDITIONAL_START",
    "CONDITIONAL_STOP",
    "CONSTANT_EVENT",
    "MACHINE_EVENT",
    "ONCE_EVENT",
    "OUTCOME_WRAPPED_EVENT",
    "PLAN_EVENT",
    "RENEWAL_ISSUE_EVENT",
    "RENEWAL_WRAPPED_EVENT",
    "TAKEOVER_WRAPPED_EVENT",
    "TYPED_CONSTANT_EVENT",
    "UNLABELLED_EVENT",
    "WORKER_STARTED",
  ])
})

test("does not treat config values or event prefixes as recorded transition names", async () => {
  const sources = await Promise.all([
    fixture("test/trajectory-panel/event-discovery/fixtures/recorded-producers.ts"),
    fixture("test/trajectory-panel/event-discovery/fixtures/unrelated-strings.ts"),
  ])
  const found = discoverRecordedTransitions(sources)
  const displayNames = new Set(found.filter((name) => name !== "UNLABELLED_EVENT"))

  expect(found).not.toContain("LAZERS")
  expect(found).not.toContain("PRIVATE_API_KEY")
  expect(found).not.toContain("SCOPE_")
  expect(found).not.toContain("OUTCOME_")
  expect(found).not.toContain("CONFIG_ONLY_VALUE")
  expect(found.filter((name) => !displayNames.has(name))).toEqual(["UNLABELLED_EVENT"])
})
