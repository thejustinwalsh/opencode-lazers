import { createMachine, transition } from "xstate"

/**
 * Dispatch pause for a project or for every project. Pause stops new dispatch; work already
 * running finishes and is verified; nothing is cancelled. One machine serves both scopes, the
 * event names carry the scope. A repeated pause only updates its reason.
 */
export type DispatchPauseState = "enabled" | "paused"
export type DispatchPauseEvent =
  | "PROJECT_DISPATCH_PAUSED"
  | "PROJECT_DISPATCH_UNPAUSED"
  | "GLOBAL_DISPATCH_PAUSED"
  | "GLOBAL_DISPATCH_UNPAUSED"

export const dispatchPauseMachine = createMachine({
  id: "dispatch-pause",
  initial: "enabled",
  states: {
    enabled: {
      on: { PROJECT_DISPATCH_PAUSED: "paused", GLOBAL_DISPATCH_PAUSED: "paused" },
    },
    paused: {
      on: {
        PROJECT_DISPATCH_PAUSED: "paused",
        GLOBAL_DISPATCH_PAUSED: "paused",
        PROJECT_DISPATCH_UNPAUSED: "enabled",
        GLOBAL_DISPATCH_UNPAUSED: "enabled",
      },
    },
  },
})

export function dispatchPauseTransition(
  state: DispatchPauseState,
  type: DispatchPauseEvent,
): DispatchPauseState {
  const current = dispatchPauseMachine.resolveState({ value: state, context: {} })
  if (!current.can({ type })) throw new Error(`Invalid dispatch pause ${state} → ${type}`)
  return transition(dispatchPauseMachine, current, { type })[0].value as DispatchPauseState
}
