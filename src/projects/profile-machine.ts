import { createMachine } from "xstate"

/**
 * One stored profile revision. A proposal waits for the owner; only a confirmed revision is
 * ever read by the runtime. A newer proposal replaces a pending one; a confirmed revision is
 * superseded by a newer confirmation, which is a query over revisions, not a transition. Both
 * outcomes are final, so the machine has exactly one non-terminal state and it has exits.
 */
export type ProfileRevisionState = "proposed" | "confirmed" | "discarded"
export type ProfileRevisionEvent = "OWNER_CONFIRMED" | "OWNER_DISCARDED" | "REPLACED"

export const profileRevisionMachine = createMachine({
  id: "project-profile-revision",
  initial: "proposed",
  states: {
    proposed: {
      on: { OWNER_CONFIRMED: "confirmed", OWNER_DISCARDED: "discarded", REPLACED: "discarded" },
    },
    confirmed: { type: "final" },
    discarded: { type: "final" },
  },
})
