import type { Database } from "bun:sqlite"
import { git } from "./artifacts.ts"
import type { HostSession } from "./host.ts"
import { requireIntegration, type BaseReach, type IntegrationProof } from "./integration-proof.ts"
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

/**
 * The change must be contained in the reviewed branch, proven before the
 * transaction by `proveIntegration` (ancestry, change-id note, patch-id or
 * tree), so a rewritten history still proves. Never a bare SHA ancestry check.
 */
function reviewedBranchHead(
  directory: string,
  branch: string,
  artifact: string,
  proof: IntegrationProof | undefined,
) {
  if (git(directory, ["branch", "--show-current"]) !== branch)
    throw new Error("The current checkout is not the reviewed target branch")
  return requireIntegration(proof, artifact, "The accepted artifact", `branch ${branch}`)
}

export function recordIntegration(
  store: RunnerStore,
  db: Database,
  plan: PlanRow,
  command: CommandInput,
  directory: string,
  proof?: IntegrationProof,
) {
  if (command.taskID) {
    const node = store.nodes(plan.id).find((item) => item.task_id === command.taskID)
    if (node?.state !== "accepted" || !node.artifact)
      throw new Error("Only an accepted task result can be recorded as integrated")
    if (command.artifact !== node.artifact || !command.targetBranch || !command.reason)
      throw new Error("Record the accepted task artifact, reviewed targetBranch and reason")
    const head = reviewedBranchHead(directory, command.targetBranch, node.artifact, proof)
    store.record(plan.id, node.task_id, "TASK_INTEGRATION_RECORDED", {
      artifact: node.artifact,
      branch: command.targetBranch,
      head,
      reason: command.reason,
    })
    db.query("UPDATE runner_plans SET version=version+1 WHERE id=?").run(plan.id)
    // A task source landing is not combined acceptance. Keep its artifact
    // and workspace available to dependencies until normal plan cleanup.
    return { status: "task-integration-recorded", version: plan.version + 1, head }
  }
  if (!["accepted", "cleanup-blocked"].includes(plan.state) || !plan.artifact)
    throw new Error("Only an accepted result can be integrated")
  if (command.artifact !== plan.artifact || !command.targetBranch || !command.reason)
    throw new Error("Record the accepted artifact, reviewed targetBranch and reason")
  const head = reviewedBranchHead(directory, command.targetBranch, plan.artifact, proof)
  store.record(plan.id, null, "INTEGRATION_RECORDED", {
    artifact: plan.artifact,
    branch: command.targetBranch,
    head,
    reason: command.reason,
  })
  db.query(
    "UPDATE runner_plans SET state=lz_runner_transition('plan',state,'cleaning'),reason=NULL,version=version+1 WHERE id=?",
  ).run(plan.id)
  return { status: "cleanup-requested", version: store.plan(plan.id)!.version }
}

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
