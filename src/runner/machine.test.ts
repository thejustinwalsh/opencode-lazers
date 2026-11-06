import { expect, test } from "bun:test"
import { initialSnapshot, machineVersion, transition } from "./machine.ts"
import type { TaskState } from "./schema.ts"

test("initial task snapshot is queued and versioned", () => {
  expect(initialSnapshot()).toMatchObject({
    status: "active",
    value: "queued",
    context: {},
  })
  expect(machineVersion).toBe("lazers-task/1")
})

test("task transition table persists each next state with the machine version", () => {
  const cases: [TaskState, string, TaskState][] = [
    ["queued", "READY", "ready"],
    ["queued", "BLOCK", "blocked"],
    ["queued", "CANCEL", "cancelled"],
    ["queued", "INCORPORATE", "incorporated"],
    ["ready", "DISPATCH", "running"],
    ["ready", "BLOCK", "blocked"],
    ["ready", "CANCEL", "cancelled"],
    ["ready", "EXHAUST", "exhausted"],
    ["ready", "RETAINED_ACCEPT", "accepted"],
    ["running", "VERIFY", "verifying"],
    ["running", "BLOCK", "blocked"],
    ["running", "FAIL", "failed"],
    ["running", "CANCEL", "cancelled"],
    ["running", "EXHAUST", "exhausted"],
    ["running", "RETRY", "ready"],
    ["running", "RETAINED_ACCEPT", "accepted"],
    ["verifying", "ACCEPT", "accepted"],
    ["verifying", "RESUME", "running"],
    ["accepted", "RETAINED_REPAIR", "ready"],
    ["verifying", "REPAIR", "ready"],
    ["verifying", "BLOCK", "blocked"],
    ["verifying", "FAIL", "failed"],
    ["verifying", "CANCEL", "cancelled"],
    ["verifying", "EXHAUST", "exhausted"],
    ["verifying", "RETAINED_ACCEPT", "accepted"],
    ["blocked", "RECONCILE", "queued"],
    ["blocked", "CANCEL", "cancelled"],
    ["blocked", "RETRY", "ready"],
    ["blocked", "RETAINED_ACCEPT", "accepted"],
    ["failed", "RESUME", "running"],
    ["failed", "RETRY", "ready"],
    ["failed", "RETAINED_ACCEPT", "accepted"],
    ["cancelled", "RESUME", "running"],
    ["cancelled", "RETRY", "ready"],
    ["exhausted", "RESUME", "running"],
    ["exhausted", "RETRY", "ready"],
  ]

  for (const [from, event, expected] of cases) {
    const next = transition(from, event)
    expect(next.state).toBe(expected)
    expect(next.machineVersion).toBe(machineVersion)
    expect(next.snapshot).toMatchObject({ value: expected })
  }
})

test("terminal and unknown events reject without changing the state", () => {
  for (const [state, event] of [
    ["accepted", "RETRY"],
    ["incorporated", "RETRY"],
    ["queued", "DISPATCH"],
    ["running", "UNKNOWN"],
  ] as const) {
    expect(() => transition(state as TaskState, event)).toThrow(
      `Invalid task transition ${state} → ${event}`,
    )
  }
})
