import type { TaskRepository } from "../../storage.ts"
import { CodeReviewIntegrationTargetStore } from "../../code-review/integrations/target-store.ts"
import type { StoredIntegrationTarget } from "../../code-review/integrations/target-store.ts"
import { resolveLocalTargetHead } from "./target-ref.ts"

export type ManagedTaskPrerequisiteTarget =
  | { status: "legacy" }
  | { status: "ready"; target: StoredIntegrationTarget; baseline: string }
  | { status: "waiting"; reason: string }
  | { status: "unknown"; reason: string }

export async function managedTaskPrerequisiteTarget(input: {
  repository: TaskRepository
  projectID: string
  directory: string
  prerequisiteTaskIDs: readonly string[]
  dependentTaskID: string
  candidateBaseline?: string
}): Promise<ManagedTaskPrerequisiteTarget> {
  const targetStore = new CodeReviewIntegrationTargetStore(input.repository)
  const targets = [
    ...input.prerequisiteTaskIDs.map((taskID) => [taskID, "prerequisite"] as const),
    [input.dependentTaskID, "dependent task"] as const,
  ].map(([taskID, label]) => ({
    taskID,
    label,
    target: targetStore.targetForTask(taskID),
  }))

  if (targets.every((entry) => !entry.target)) return { status: "legacy" }
  if (targets.some((entry) => !entry.target))
    return {
      status: "waiting",
      reason:
        "The dependent task and every prerequisite must share one selected integration target.",
    }

  const selected = targets[0]!.target!
  for (const entry of targets) {
    if (entry.target!.target.projectID !== input.projectID)
      return {
        status: "waiting",
        reason: "The selected integration target belongs to another project.",
      }
    if (entry.target!.target.id !== selected.target.id)
      return {
        status: "waiting",
        reason: "Dependent tasks and prerequisites are bound to different integration targets.",
      }
    if (!entry.target!.target.taskIDs.includes(entry.taskID))
      return {
        status: "waiting",
        reason: `The selected integration target does not include its ${entry.label}.`,
      }
  }

  let baseline: string
  try {
    baseline = await resolveLocalTargetHead(input.directory, selected.target.branch)
  } catch {
    return {
      status: "unknown",
      reason: "The selected integration target branch could not be read.",
    }
  }
  if (baseline !== selected.observedHead)
    return {
      status: "waiting",
      reason:
        "The selected integration target changed; explicitly reconcile its observed head first.",
    }
  if (input.candidateBaseline && input.candidateBaseline !== baseline)
    return {
      status: "waiting",
      reason: "The managed integration target advanced after this candidate baseline was selected.",
    }
  return { status: "ready", target: selected, baseline }
}
