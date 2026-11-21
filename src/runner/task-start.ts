import type { TaskSpec } from "../task.ts"
import type { PlanInput } from "./schema.ts"

export const taskStartRequestID = (taskID: string) => `task-start:${taskID}:1`

export function assertTaskPersonaForManualStart(task: TaskSpec): void {
  if (task.proposal.persona === undefined)
    throw new Error("Select an implementor model in native OpenCode agent configuration")
}

export function taskStartPlanInput(task: TaskSpec, baseCommit: string): PlanInput {
  const { proposal } = task
  return {
    requestID: taskStartRequestID(task.id),
    objective: proposal.objective,
    baseCommit,
    workspaceMode: "shared",
    nodes: [
      {
        taskID: task.id,
        revision: task.revision,
        ...(proposal.persona === undefined ? {} : { persona: proposal.persona }),
      },
    ],
    dependencies: [],
    integrationOrder: [task.id],
    verification: proposal.verification,
    acceptance: proposal.acceptance,
    dispositions: [],
  }
}
