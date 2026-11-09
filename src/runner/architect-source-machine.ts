import { createMachine, transition } from "xstate"

export type ArchitectSourceState = "preparing" | "active" | "retired"
type SourceEvent = "PREPARE" | "ACTIVATE" | "RETIRE"

export const architectSourceMachine = createMachine({
  id: "architect-source",
  initial: "preparing",
  states: {
    preparing: { on: { PREPARE: "preparing", ACTIVATE: "active" } },
    active: { on: { PREPARE: "preparing", ACTIVATE: "active", RETIRE: "retired" } },
    retired: { on: { PREPARE: "preparing", ACTIVATE: "active" } },
  },
})

export function architectSourceTransition(state: ArchitectSourceState, type: SourceEvent) {
  const current = architectSourceMachine.resolveState({ value: state, context: {} })
  if (!current.can({ type }))
    throw new Error(`Invalid Architect source transition ${state} → ${type}`)
  return transition(architectSourceMachine, current, { type })[0].value as ArchitectSourceState
}
