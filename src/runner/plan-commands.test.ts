import { expect, test } from "bun:test"
import { lifecycleMachines } from "./lifecycle-machines.ts"
import {
  availablePlanCommands,
  planCommandProblem,
  planCommandTable,
  withoutLegacyVersion,
} from "./plan-commands.ts"
import { CommandInput } from "./schema.ts"

const planStates = [
  "draft",
  "running",
  "blocked",
  "accepted",
  "cancelling",
  "cancelled",
  "failed",
  "cleaning",
  "cleanup-blocked",
  "integrated",
] as const

test("every command's source states are accepted by the plan machine", () => {
  for (const [action, spec] of Object.entries(planCommandTable)) {
    if (!spec.event || spec.from === "any") continue
    for (const state of spec.from)
      expect(
        lifecycleMachines.plan
          .resolveState({ value: state, context: {} })
          .can({ type: spec.event }),
        `${action} from ${state}`,
      ).toBe(true)
  }
})

test("an unavailable action names the state and the actions that apply", () => {
  expect(planCommandProblem("integrated", { action: "cancel" })).toBe(
    `Plan is integrated; cancel is not available. Available: ${availablePlanCommands("integrated").join(", ") || "none"}.`,
  )
  expect(planCommandProblem("cleanup-blocked", { action: "cancel" })).toContain(
    "Plan is cleanup-blocked; cancel is not available. Available:",
  )
  expect(planCommandProblem("running", { action: "integrated" })).toContain(
    "Plan is running; integrated is not available.",
  )
  expect(
    planCommandProblem("accepted", { action: "resume", taskID: crypto.randomUUID() }),
  ).toContain("Plan is accepted; resume is not available.")
  expect(planCommandProblem("integrated", { action: "retry" })).toBe(
    "Plan is integrated; retry is not available. Available: none.",
  )
  expect(availablePlanCommands("cleanup-blocked")).toContain("integrated")
  expect(availablePlanCommands("cleanup-blocked")).not.toContain("cancel")
})

test("legal actions pass and every state has an exit or is final", () => {
  expect(planCommandProblem("blocked", { action: "cancel" })).toBeUndefined()
  expect(planCommandProblem("accepted", { action: "cancel" })).toBeUndefined()
  expect(planCommandProblem("accepted", { action: "integrated" })).toBeUndefined()
  expect(planCommandProblem("blocked", { action: "resume" })).toBeUndefined()
  expect(planCommandProblem("running", { action: "resume" })).toContain("not available")
  expect(
    planCommandProblem("running", { action: "resume", taskID: crypto.randomUUID() }),
  ).toBeUndefined()
  for (const state of planStates)
    if (state !== "integrated") expect(availablePlanCommands(state).length).toBeGreaterThan(0)
})

test("the schema carries no version and a legacy expectedVersion is dropped before validation", () => {
  const input = { requestID: "r", planID: crypto.randomUUID(), action: "audit" as const }
  expect(CommandInput.safeParse({ ...input, expectedVersion: 3 }).success).toBe(false)
  expect(CommandInput.parse(withoutLegacyVersion({ ...input, expectedVersion: 3 }))).toEqual(input)
  expect(CommandInput.parse(withoutLegacyVersion(input))).toEqual(input)
})
