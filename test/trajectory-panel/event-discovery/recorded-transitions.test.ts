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
    "WORKER_STOPPED",
  ])
})

test("does not treat config values or event prefixes as recorded transition names", async () => {
  const sources = await Promise.all([
    fixture("test/trajectory-panel/event-discovery/fixtures/recorded-producers.ts"),
    fixture("test/trajectory-panel/event-discovery/fixtures/unrelated-strings.ts"),
  ])
  const found = discoverRecordedTransitions(sources)
  expect(found).not.toContain("LAZERS")
  expect(found).not.toContain("PRIVATE_API_KEY")
  expect(found).not.toContain("SCOPE_")
  expect(found).not.toContain("OUTCOME_")
  expect(found).not.toContain("CONFIG_ONLY_VALUE")
})

test("regular-expression literals do not hide following persistence producers", async () => {
  const source = await fixture("test/trajectory-panel/event-discovery/fixtures/regex-producer.ts")

  expect(discoverRecordedTransitions([source])).toContain("AFTER_REGEX_EVENT")
})

test("constant lookup respects source and lexical bindings", async () => {
  const sources = await Promise.all([
    fixture("src/runner/outcome-delivery.ts"),
    fixture("test/trajectory-panel/event-discovery/fixtures/unrelated-strings.ts"),
    fixture("test/trajectory-panel/event-discovery/fixtures/shadowed-bindings.ts"),
  ])
  const found = discoverRecordedTransitions(sources)

  expect(found).toContain("OUTCOME_OLD_INBOX_UNREADABLE")
  expect(found).toContain("SCOPED_CONSTANT_EVENT")
  expect(found).not.toContain("PRIVATE_API_KEY")
})

test("raw SQL inserts into runner_transitions contribute their literal event", async () => {
  const source = await fixture("test/trajectory-panel/event-discovery/fixtures/sql-transition.ts")

  expect(discoverRecordedTransitions([source])).toContain("RAW_SQL_EVENT")
  expect(discoverRecordedTransitions([source])).not.toContain("PRIVATE_API_KEY")
})
