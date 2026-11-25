import type { HostSession } from "../host.ts"
import type { RunnerTransitionRecord } from "../runtime-helpers.ts"

const OWNER_TRANSITIONS = new Set([
  "OWNER_ADOPTED",
  "OWNER_CONTINUED",
  "OWNER_CONTINUATION_ROLLED_BACK",
  "OWNER_REASSIGNED",
])

type RetainedRepairOwnerSession = Pick<HostSession, "id" | "agent" | "projectID" | "archived">

/** The current live Architect, not the repair's historical author, authorizes recovery. */
export function currentRetainedRepairAuthorityMatches(input: {
  callerID: string
  planOwnerID: string
  ownerSession: RetainedRepairOwnerSession | null | undefined
  projectID: string
}): boolean {
  return (
    input.callerID === input.planOwnerID &&
    input.ownerSession?.id === input.callerID &&
    input.ownerSession.agent === "architect" &&
    input.ownerSession.projectID === input.projectID &&
    !input.ownerSession.archived
  )
}

/** A repair author is immutable historical attribution, not a current authority token. */
export function hasRecordedRetainedRepairAuthor(author: unknown): author is string {
  return typeof author === "string" && author.trim().length > 0
}

/**
 * Prove the recorded repair author held plan ownership when the repair was requested.
 * Later automatic renewals, reassignments, and live-Architect adoptions may change the owner.
 */
export function retainedRepairAuthorMatchesHistory(input: {
  author: unknown
  currentOwnerID: string
  repairTransition: RunnerTransitionRecord
  history: readonly RunnerTransitionRecord[]
}): boolean {
  if (!hasRecordedRetainedRepairAuthor(input.author)) return false
  let repairPayload: unknown
  try {
    repairPayload = JSON.parse(input.repairTransition.payload) as unknown
  } catch {
    return false
  }
  if (
    typeof repairPayload !== "object" ||
    repairPayload === null ||
    Array.isArray(repairPayload) ||
    (repairPayload as { owner?: unknown }).owner !== input.author
  )
    return false

  let ownerID = input.currentOwnerID
  const laterOwnership = input.history
    .filter(
      (transition) =>
        transition.task_id === null &&
        transition.id > input.repairTransition.id &&
        OWNER_TRANSITIONS.has(transition.event),
    )
    .toReversed()

  for (const transition of laterOwnership) {
    let payload: unknown
    try {
      payload = JSON.parse(transition.payload) as unknown
    } catch {
      return false
    }
    if (typeof payload !== "object" || payload === null) return false
    const { from, to } = payload as { from?: unknown; to?: unknown }
    if (typeof from !== "string" || !from || typeof to !== "string" || !to || ownerID !== to)
      return false
    ownerID = from
  }

  return ownerID === input.author
}
