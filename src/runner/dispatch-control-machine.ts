import { createMachine, transition } from "xstate"

export const dispatchControlMachine = createMachine({
  id: "dispatch-control",
  initial: "enabled",
  states: {
    enabled: { on: { PAUSE: "paused" } },
    paused: { on: { PAUSE: "paused", UNPAUSE: "enabled" } },
  },
})
export function dispatchControlTransition(state: "enabled" | "paused", type: "PAUSE" | "UNPAUSE") {
  const current = dispatchControlMachine.resolveState({ value: state, context: {} })
  if (!current.can({ type })) throw new Error(`Invalid dispatch control ${state} → ${type}`)
  return transition(dispatchControlMachine, current, { type })[0].value as "enabled" | "paused"
}
