import { createMachine, transition } from "xstate"

/**
 * Project-wide Architect contact. A user-set pause is a legitimate hold: while
 * paused LAZERS never creates, prompts, resumes or forks an Architect session.
 * Notices stay queued and deliver after UNPAUSE.
 */
export type ArchitectContactState = "enabled" | "paused"

export const architectContactMachine = createMachine({
  id: "architect-contact",
  initial: "enabled",
  states: {
    enabled: { on: { PAUSE: "paused" } },
    paused: { on: { PAUSE: "paused", UNPAUSE: "enabled" } },
  },
})

export function architectContactTransition(
  state: ArchitectContactState,
  type: "PAUSE" | "UNPAUSE",
): ArchitectContactState {
  const current = architectContactMachine.resolveState({ value: state, context: {} })
  if (!current.can({ type })) throw new Error(`Invalid Architect contact ${state} → ${type}`)
  return transition(architectContactMachine, current, { type })[0].value as ArchitectContactState
}
