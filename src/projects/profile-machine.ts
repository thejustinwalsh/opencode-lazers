import { createMachine } from "xstate"

/**
 * One stored profile revision. A revision is written active and stays active until the next
 * revision of the same project supersedes it; nothing waits for an approval. `superseded` is
 * final: the revision stays readable by id (a run that started with it keeps it) but is never
 * the current profile again.
 */
export type ProfileRevisionState = "active" | "superseded"
export type ProfileRevisionEvent = "SUPERSEDED"

export const profileRevisionMachine = createMachine({
  id: "project-profile-revision",
  initial: "active",
  states: {
    active: { on: { SUPERSEDED: "superseded" } },
    superseded: { type: "final" },
  },
})
