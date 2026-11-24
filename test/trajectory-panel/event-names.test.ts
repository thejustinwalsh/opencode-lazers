import { expect, test } from "bun:test"
import { Glob } from "bun"
import { discoverRecordedTransitions } from "./event-discovery/recorded-transitions.ts"
import {
  eventFilters,
  eventGroup,
  eventIsError,
  eventKinds,
  eventLabel,
  eventMatchesFilter,
  humanize,
  runnerTransitions,
  transitionName,
  translateRuntimeWords,
} from "../../src/trajectory-panel/event-names.ts"
import type { TrajectoryEvent } from "../../src/trajectory-panel/projection.ts"

const event = (fields: Partial<TrajectoryEvent> & { kind: string }): TrajectoryEvent =>
  ({ id: "e1", ...fields }) as TrajectoryEvent

async function sourceFiles(pattern: string) {
  const files: string[] = []
  for await (const file of new Glob(pattern).scan("."))
    if (!/\.test\.|fixtures?\//.test(file)) files.push(file)
  return files.sort()
}

/** Every `kind` a trajectory event can carry, read from the code that records it. */
async function recordedKinds() {
  const kinds = new Set<string>()
  // The message events moved out of the report read into their own module.
  const read =
    (await Bun.file("src/trajectory/read.ts").text()) +
    (await Bun.file("src/trajectory/message-events.ts").text())
  for (const match of read.matchAll(/kind: "([a-z][a-z-]*)"/g)) kinds.add(match[1]!)
  for (const match of read.matchAll(/base\((?:[^()]|\([^()]*\))*?,\s*"([a-z][a-z-]*)"\)/g))
    kinds.add(match[1]!)
  const progress = await Bun.file("src/progress/projection.ts").text()
  const factSwitch = progress.slice(progress.indexOf("export function projectProgressFact"))
  for (const match of factSwitch.matchAll(/case "([a-z][a-z-]*)":/g))
    kinds.add(match[1] === "commentary" ? "commentary" : `worker-${match[1]}`)
  kinds.add("worker-unknown")
  for (const match of progress.matchAll(/view\.kind = "([a-z-]+)"/g)) kinds.add(match[1]!)
  // Session messages that become `user` and `synthetic` events.
  kinds.add("user")
  kinds.add("synthetic")
  // Evidence references inside a check, not events.
  kinds.delete("artifact")
  return [...kinds].sort()
}

/** Exact transition names passed to runner persistence producers. */
async function recordedTransitions() {
  const files = await sourceFiles("src/**/*.{ts,tsx}")
  const sources = await Promise.all(
    files.map(async (path) => ({ path, source: await Bun.file(path).text() })),
  )
  return discoverRecordedTransitions(sources)
}

test("every recorded event kind has a display name and a filter group", async () => {
  const found = await recordedKinds()
  expect(found.length).toBeGreaterThan(25)
  const missing = found.filter((kind) => !(kind in eventKinds))
  expect(missing).toEqual([])
  for (const [kind, entry] of Object.entries(eventKinds)) {
    expect(entry.name).not.toMatch(/[_]|^[a-z]+-[a-z-]+$/)
    expect(eventGroup(event({ kind }))).toBe(entry.group)
  }
})

test("every runner transition has a display name", async () => {
  const found = await recordedTransitions()
  expect(found.length).toBeGreaterThan(100)
  expect(found).toEqual(
    expect.arrayContaining([
      "RECOVERY_BUNDLE_RAISED",
      "WORKER_CONCERN_RAISED",
      "PLAN_STEP_FAILED",
      "PLAN_CLEANUP_FAILED",
      "PLAN_DELIVERY_FAILED",
      "FAIL",
      "PROMPT_NOT_DISPATCHED",
      "STARTUP_RECOVERY_OPERATION_RESUMED",
      "TAKEOVER_VERIFY_FAILED",
      "WORKTREE_RECOVERY_RESUMED",
      "OUTCOME_OLD_INBOX_UNREADABLE",
      "OUTCOME_INBOX_UNREADABLE",
      "OUTCOME_DELIVERY_FAILED",
      "OUTCOME_NO_ARCHITECT",
      "PLAN_GATE_RETIRED",
      "RETAINED_VERIFICATION_RETIRED",
      "OUTCOME_HOST_DELIVERED",
      "ARCHITECT_RENEWAL_NATIVE_INPUT_OBSERVED",
      "WORKER_STARTED",
      "TAKEOVER_HANDOFF_RECEIVED",
    ]),
  )
  const missing = found.filter((name) => !(name in runnerTransitions))
  expect(missing).toEqual([])
  for (const [name, text] of Object.entries(runnerTransitions)) {
    expect(text).not.toMatch(/_/)
    expect(text).not.toBe(name)
  }
})

test("row titles are words: raw names never reach the display", () => {
  expect(eventLabel(event({ kind: "runner-transition", event: "EFFECT_INTENDED" }))).toBe(
    "Action started",
  )
  expect(eventLabel(event({ kind: "runner-transition", event: "CONTEXT_RESOLVED" }))).toBe(
    "Context resolved",
  )
  expect(eventLabel(event({ kind: "runner-transition", event: "DISPATCH" }))).toBe("Dispatched")
  expect(eventLabel(event({ kind: "worker-execution-outcome" }))).toBe("Worker outcome")
  expect(eventLabel(event({ kind: "worker-provider-retry" }))).toBe("Provider retry")
  expect(eventLabel(event({ kind: "worker-gap" }))).toBe("Recording gap")
  expect(eventLabel(event({ kind: "tool", tool: "shell", status: "failed" }))).toBe(
    "shell · failed",
  )
  expect(eventLabel(event({ kind: "runner-effect", effect: "worktree", state: "completed" }))).toBe(
    "Worktree · completed",
  )
  // A name this build does not know is made readable, never shown raw.
  expect(eventLabel(event({ kind: "runner-transition", event: "BRAND_NEW_STEP" }))).toBe(
    "Brand new step",
  )
  expect(eventLabel(event({ kind: "something-new" }))).toBe("Something new")
  expect(transitionName(undefined)).toBe("Runner step")
  expect(humanize("verify:lint-check")).toBe("Verify lint check")
  expect(translateRuntimeWords("Stopped by CANCEL_REQUESTED after WORKER_STOPPED")).toBe(
    "Stopped by cancel requested after worker stopped",
  )
})

test("errors are failures, retries, model errors and recording gaps", () => {
  expect(eventIsError(event({ kind: "tool", tool: "shell", status: "failed" }))).toBe(true)
  expect(eventIsError(event({ kind: "tool", tool: "shell", status: "completed" }))).toBe(false)
  expect(eventIsError(event({ kind: "shell", exit: 2 }))).toBe(true)
  expect(eventIsError(event({ kind: "shell", exit: 0 }))).toBe(false)
  expect(eventIsError(event({ kind: "provider-retry" }))).toBe(true)
  expect(eventIsError(event({ kind: "worker-gap" }))).toBe(true)
  expect(eventIsError(event({ kind: "verification", status: "failed" }))).toBe(true)
  expect(eventIsError(event({ kind: "verification", status: "passed" }))).toBe(false)
  expect(eventIsError(event({ kind: "runner-transition", event: "READY" }))).toBe(false)
})

test("filters keep the events of one group, and Errors cuts across groups", () => {
  const call = event({ kind: "worker-tool", tool: "shell", status: "failed" })
  const message = event({ kind: "worker-visible-text" })
  const transition = event({ kind: "runner-transition", event: "READY" })
  const ids = eventFilters.map((filter) => filter.id)
  expect(ids).toEqual(["all", "calls", "checks", "messages", "model", "runner", "errors"])
  expect(eventMatchesFilter(call, "calls")).toBe(true)
  expect(eventMatchesFilter(call, "errors")).toBe(true)
  expect(eventMatchesFilter(message, "messages")).toBe(true)
  expect(eventMatchesFilter(message, "calls")).toBe(false)
  expect(eventMatchesFilter(transition, "runner")).toBe(true)
  expect(eventMatchesFilter(transition, "all")).toBe(true)
  expect(eventMatchesFilter(transition, "errors")).toBe(false)
})
