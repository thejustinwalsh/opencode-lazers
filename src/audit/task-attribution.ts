import { runGit } from "./config.ts"
import { suppressedSymbol } from "./suppression-flow.ts"
import type { FallowFinding } from "./contract.ts"
import type { FallowReviewResult } from "./review.ts"

/** One task's own change inside a plan: what it was measured from and what it delivered. */
export type PlanTaskDiff = { taskID: string; base: string; artifact: string }

/** Added lines of a task's own diff outside `exceptFile`. */
async function addedLines(
  workspace: string,
  task: PlanTaskDiff,
  exceptFile: string,
): Promise<string[]> {
  const text = (await runGit(workspace, "diff", "-U0", task.base, task.artifact)) ?? ""
  const lines: string[] = []
  let current = ""
  for (const line of text.split("\n")) {
    if (line.startsWith("+++ ")) current = line.replace(/^\+\+\+ (?:b\/)?/, "")
    else if (line.startsWith("+") && current !== exceptFile) lines.push(line.slice(1))
  }
  return lines
}

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
  // A stale suppression belongs to the task that used the code it covers, not the one that wrote it.
  const consumers = new Map<string, string[]>()
  for (const finding of result.package?.findings ?? []) {
    if (finding.rule !== "stale-suppression") continue
    const name = await suppressedSymbol(workspace, finding.file, finding.line)
    if (!name) continue
    const word = new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`)
    const using: string[] = []
    for (const task of tasks)
      if ((await addedLines(workspace, task, finding.file)).some((line) => word.test(line)))
        using.push(task.taskID)
    if (using.length) consumers.set(finding.id, using)
  }
  const tag = (finding: FallowFinding): FallowFinding => {
    const consumer = consumers.get(finding.id)
    if (consumer)
      return consumer.length === 1
        ? { ...finding, taskID: consumer[0] }
        : { ...finding, taskIDs: consumer }
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
