import { transition } from "xstate"
import { expect, test } from "bun:test"
import { lifecycleMachines, lifecycleTransition } from "./lifecycle-machines.ts"
import { taskMachine } from "./machine.ts"
import { TaskState } from "./schema.ts"

test("every task state has a path to acceptance or recorded incorporation", () => {
  const events = [
    ...new Set(
      Object.values(taskMachine.config.states ?? {}).flatMap((state) =>
        Object.keys(state.on ?? {}),
      ),
    ),
  ]
  for (const start of TaskState.options) {
    const seen = new Set<string>()
    const pending: string[] = [start]
    let completed = false
    while (pending.length) {
      const value = pending.pop()!
      if (value === "accepted" || value === "incorporated") {
        completed = true
        break
      }
      if (seen.has(value)) continue
      seen.add(value)
      const current = taskMachine.resolveState({ value, context: {} })
      for (const type of events) {
        if (!current.can({ type })) continue
        const [next] = transition(taskMachine, current, { type })
        pending.push(next.value as string)
      }
    }
    expect(completed, start).toBe(true)
  }
})

test("runner lifecycle graphs have no accidental sink states", () => {
  for (const [domain, machine] of Object.entries(lifecycleMachines)) {
    const goals: Record<string, string[]> = {
      task: ["accepted", "incorporated"],
      dispatch: ["enabled"],
      capacity: ["released", "cancelled"],
      source: ["active", "retired"],
      contact: ["enabled"],
      pause: ["enabled"],
      plan: ["integrated", "cancelled"],
      attempt: ["accepted", "cancelled"],
      effect: ["completed", "failed"],
      outbox: ["delivered", "superseded"],
      renewal: ["committed", "deferred", "archive-failed"],
      adoption: ["accepted", "failed", "cancelled"],
      retained: ["accepted", "failed", "cancelled"],
      resource: ["removed"],
      check: ["completed"],
      cleanup: ["complete"],
      workspace: ["removed"],
      takeover: ["taken-over", "cancelled"],
      planning: ["tasked", "abandoned"],
      planningRun: ["reviewed", "failed", "stuck", "cancelled"],
      identityKeys: ["text-retired"],
      projection: ["ready"],
      profile: ["superseded"],
    }
    for (const start of Object.keys(machine.config.states ?? {})) {
      const seen = new Set<string>()
      const pending = [start]
      let terminal = false
      while (pending.length) {
        const state = pending.pop()!
        if (goals[domain]!.includes(state)) {
          terminal = true
          break
        }
        if (seen.has(state)) continue
        seen.add(state)
        const current = machine.resolveState({ value: state, context: {} })
        for (const event of new Set(
          Object.values(machine.config.states ?? {}).flatMap((node) => Object.keys(node.on ?? {})),
        ))
          if (current.can({ type: event })) pending.push(lifecycleTransition(domain, state, event))
      }
      expect(terminal, `${domain}:${start}`).toBe(true)
    }
  }
})

test("lifecycle transitions reject illegal shortcuts rather than fabricating completion", () => {
  expect(() => lifecycleTransition("plan", "draft", "integrated")).toThrow()
  expect(() => lifecycleTransition("attempt", "cancelled", "accepted")).toThrow()
  expect(() => lifecycleTransition("effect", "completed", "uncertain")).toThrow()
  expect(() => lifecycleTransition("check", "retry-authorized", "completed")).toThrow()
  expect(() => lifecycleTransition("retained", "failed", "task-checks")).toThrow()
  expect(() => lifecycleTransition("retained", "cancelled", "task-checks")).toThrow()
  expect(lifecycleTransition("retained", "task-checks", "accepted")).toBe("accepted")
  expect(lifecycleTransition("plan", "cleanup-blocked", "integrated")).toBe("integrated")
  expect(lifecycleTransition("attempt", "cancelled", "preparing")).toBe("preparing")
})

test("a planning state exits to tasked and abandoned, and an edit in ready returns to drafted", () => {
  for (const state of ["drafted", "in-review", "questions-open", "final-review", "ready"]) {
    expect(lifecycleTransition("planning", state, "tasked")).toBe("tasked")
    expect(lifecycleTransition("planning", state, "abandoned")).toBe("abandoned")
  }
  expect(lifecycleTransition("planning", "ready", "drafted")).toBe("drafted")
  expect(lifecycleTransition("planning", "in-review", "in-review")).toBe("in-review")
  expect(() => lifecycleTransition("planning", "drafted", "final-review")).toThrow(
    "Invalid planning transition drafted → final-review",
  )
  expect(() => lifecycleTransition("planning", "tasked", "drafted")).toThrow()
})

test("a planning run that is stuck stays stuck: a retry is a new run row", () => {
  expect(lifecycleTransition("planningRun", "running", "stuck")).toBe("stuck")
  expect(() => lifecycleTransition("planningRun", "stuck", "running")).toThrow()
})
