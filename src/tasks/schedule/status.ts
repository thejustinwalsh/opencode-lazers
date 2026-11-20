import { prerequisitePlanAction } from "../../runner/prerequisite-proof.ts"
import { scopePatternsConflict } from "../../runner/artifacts.ts"
import type { DispatchPause } from "../../runner/schema.ts"

export type PlanWait = {
  planID: string
  title: string | null
  state: string | null
  version: number | null
  reason: string | null
}

export type Reservation = { taskID: string; shared: boolean; scopes: readonly string[] }

export type StatusFacts = {
  node: { state: string; reason: string | null }
  plan: { state: string; reason: string | null }
  /** A pending or held descendant adoption of this task. */
  adoption: { id: string; holdReason: string | null } | null
  /** Same-plan prerequisites not yet accepted and integrated. */
  waitingOn: readonly string[]
  /** Prerequisite plans not yet integrated, whole. */
  waits: readonly PlanWait[]
  /** The pause holding the plan, project or global; consulted for queued or ready nodes. */
  pause: DispatchPause | undefined
  /** `undefined` when the plan body does not parse: reservations are then not consulted. */
  planMode: "shared" | "isolated" | undefined
  scope: readonly string[]
  reservations: readonly Reservation[]
  reference(taskID: string): string
}

export type EffectiveStatus = {
  status: string
  reason: string | null
  /** Task ids of the reservations holding the task back; empty unless they decided the status. */
  blockers: string[]
  dispatchPause: DispatchPause | undefined
}

/**
 * What the list shows for a task: `RunnerStore.execution` then `TaskReads.effectiveExecution`
 * (`src/tasks/read.ts`), as a function of stored facts. A plan body that fails to parse is no
 * longer reported as "prerequisite plan facts are incomplete": prerequisites are stored whole.
 */
export function effectiveStatus(facts: StatusFacts): EffectiveStatus {
  const { node, plan, adoption } = facts
  const open = node.state === "queued" || node.state === "ready"
  const state = adoption || (plan.state === "blocked" && open) ? "blocked" : node.state
  const reason =
    adoption?.holdReason ??
    (adoption ? `Descendant adoption ${adoption.id} is pending` : null) ??
    node.reason ??
    (plan.state === "blocked" ? plan.reason : null)
  const dispatchPause = open ? facts.pause : undefined
  const result = (status: string, why: string | null, blockers: string[] = []) => ({
    status,
    reason: why,
    blockers,
    dispatchPause,
  })
  if (plan.state === "cancelled") return result("cancelled", reason ?? plan.reason)
  if (
    plan.state !== "running" ||
    dispatchPause ||
    facts.waitingOn.length ||
    (state !== "queued" && state !== "ready")
  )
    return result(state, reason)
  if (facts.waits.length) {
    const details = facts.waits
      .slice(0, 4)
      .map(
        (required) =>
          `${required.title ?? "Prerequisite plan"} [${required.planID}] is ${required.state ?? "unavailable"}${required.reason ? `: ${required.reason}` : ""}`,
      )
      .join("; ")
    const more = facts.waits.length > 4 ? `; ${facts.waits.length - 4} more` : ""
    const actions = [
      ...new Set(facts.waits.map((required) => prerequisitePlanAction(required.state ?? ""))),
    ].join(" ")
    return result("blocked", `Waiting for prerequisite integration: ${details}${more}. ${actions}`)
  }
  if (!facts.planMode) return result(state, reason)
  const blockers = [
    ...new Set(
      facts.reservations
        .filter(
          (entry) =>
            facts.planMode === "shared" ||
            entry.shared ||
            scopePatternsConflict([...entry.scopes], [...facts.scope]),
        )
        .map((entry) => entry.taskID),
    ),
  ]
  if (!blockers.length) return result(state, reason)
  return result(
    "blocked",
    `Waiting for checkout or write scope: ${blockers.map((id) => facts.reference(id)).join(", ")}`,
    blockers,
  )
}

/** A digest of the active reservations in priority order; equal digests mean equal blockers and reasons. */
export function reservationFingerprint(set: readonly Reservation[]): string {
  return JSON.stringify(
    set.map((entry) => [entry.taskID, entry.shared, [...entry.scopes].sort()] as const),
  )
}
