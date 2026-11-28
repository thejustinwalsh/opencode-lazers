export { recordIntegration, recordIntegrationTarget } from "./integration/record.ts"
import type { HostSession } from "./host.ts"
import type { BaseReach } from "./integration-proof.ts"
import { PlanInput, type CommandInput } from "./schema.ts"
import type { PlanRow, RunnerStore } from "./store.ts"

export const terminalPlanStates = new Set([
  "accepted",
  "failed",
  "cancelled",
  "exhausted",
  "incorporated",
  "integrated",
  "cleanup-blocked",
])

export function changeDispatchPause(
  store: RunnerStore,
  plan: PlanRow,
  command: CommandInput,
  caller: string,
  ownerSession: HostSession | null | undefined,
  validArchitect: boolean,
) {
  if (!validArchitect || ownerSession?.id !== plan.owner)
    throw new Error("Pause controls require the current Architect")
  if (terminalPlanStates.has(plan.state) || ["cancelling", "cleaning"].includes(plan.state))
    throw new Error("Plan has ended")
  const untilPlans = command.resumeAfterPlans ?? []
  if (command.action === "pause") store.validatePlanDependencies(untilPlans, plan.id)
  store.setDispatchPause(
    plan.id,
    command.action === "pause"
      ? { reason: command.reason ?? "Paused by Architect", untilPlans }
      : null,
    { caller, reason: command.reason },
  )
  return {
    status: command.action === "pause" ? "paused" : "unpaused",
    version: store.plan(plan.id)!.version,
  }
}

export function changeSchedule(
  store: RunnerStore,
  plan: PlanRow,
  command: CommandInput,
  caller: string,
  _directory: string,
  baseReach?: ReadonlyMap<string, BaseReach>,
) {
  if (
    terminalPlanStates.has(plan.state) ||
    plan.state === "cancelling" ||
    plan.state === "cleaning"
  )
    throw new Error("Plan has ended")
  if (!command.reason) throw new Error("Scheduling changes require a reason")
  const attempts = store.attempts(plan.id)
  if (
    attempts.length &&
    (command.afterPlans !== undefined ||
      command.baseCommit !== undefined ||
      command.workspaceMode !== undefined)
  )
    throw new Error("Only priority may change after execution has started")
  const updated = PlanInput.parse({
    ...JSON.parse(plan.body),
    ...(command.priority !== undefined ? { priority: command.priority } : {}),
    ...(command.afterPlans !== undefined ? { afterPlans: command.afterPlans } : {}),
    ...(command.baseCommit !== undefined ? { baseCommit: command.baseCommit } : {}),
    ...(command.workspaceMode !== undefined ? { workspaceMode: command.workspaceMode } : {}),
  })
  store.validatePlanDependencies(updated.afterPlans ?? [], plan.id)
  if (command.baseCommit) {
    const reach = baseReach?.get(command.baseCommit)
    if (!reach) throw new Error("The requested baseline was not checked against HEAD")
    if (!reach.ok) throw new Error(reach.reason)
  }
  store.revisePlan(plan, updated, "SCHEDULE_UPDATED", {
    caller,
    reason: command.reason,
    priority: updated.priority ?? 0,
    afterPlans: updated.afterPlans ?? [],
    baseCommit: updated.baseCommit,
  })
  return { status: "scheduled", version: store.plan(plan.id)!.version }
}
