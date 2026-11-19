import { runGit } from "./config.ts"
import type { FallowFinding } from "./contract.ts"
import type { FallowReviewResult } from "./review.ts"

/** One task's own change inside a plan: what it was measured from and what it delivered. */
export type PlanTaskDiff = { taskID: string; base: string; artifact: string }

async function touchedFiles(workspace: string, task: PlanTaskDiff): Promise<Set<string>> {
  const text = await runGit(workspace, "diff", "--name-only", task.base, task.artifact)
  return new Set((text ?? "").split("\n").filter((line) => line.length > 0))
}

/**
 * Names the task(s) whose own diff touched a finding's file (or, for a clone or cycle, any of
 * the other files involved): `taskID` for exactly one, `taskIDs` for several. A finding no task
 * touched is left as is.
 */
export async function attributeFindingsToTasks(
  workspace: string,
  tasks: readonly PlanTaskDiff[],
  result: FallowReviewResult,
): Promise<FallowReviewResult> {
  const touched = new Map<string, Set<string>>()
  for (const task of tasks) touched.set(task.taskID, await touchedFiles(workspace, task))
  const tag = (finding: FallowFinding): FallowFinding => {
    const files = [finding.file, ...(finding.relatedLocations ?? []).map((other) => other.file)]
    const ids = tasks
      .map((task) => task.taskID)
      .filter((id) => files.some((file) => touched.get(id)?.has(file)))
    if (ids.length === 0) return finding
    return ids.length === 1 ? { ...finding, taskID: ids[0] } : { ...finding, taskIDs: ids }
  }
  if (!result.package) return result
  return { ...result, package: { ...result.package, findings: result.package.findings.map(tag) } }
}
