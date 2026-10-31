import { spawnSync } from "node:child_process"
import { TaskSubmissionSchema } from "./task.ts"
import type { TaskRepository } from "./storage.ts"
import type { TaskSpec } from "./task.ts"
import { taskTitle } from "./tasks/presentation.ts"

export function startingRevision(directory: string): TaskSpec["provenance"]["startingRevision"] {
  const git = (...args: string[]) =>
    spawnSync("git", args, { cwd: directory, encoding: "utf8", timeout: 5_000 })
  const head = git("rev-parse", "--verify", "HEAD")
  if (head.status === 0) return { kind: "git", commit: head.stdout.trim() }
  const branch = git("symbolic-ref", "--quiet", "HEAD")
  if (
    branch.status === 0 &&
    git("show-ref", "--verify", "--quiet", branch.stdout.trim()).status === 1
  ) {
    return { kind: "unborn" }
  }
  throw new Error("Cannot record Git starting revision; check repository access and HEAD")
}

export function submitTask(
  repository: TaskRepository,
  input: unknown,
  provenance: () => TaskSpec["provenance"],
) {
  const result = TaskSubmissionSchema.safeParse(input)
  if (!result.success) {
    return {
      status: "invalid" as const,
      errors: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    }
  }
  const { idempotencyKey, ...proposal } = result.data
  return repository.submitOnce(idempotencyKey, proposal, () => ({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: new Date().toISOString(),
    provenance: provenance(),
    proposal,
  }))
}

export function taskSubmissionSummary(
  receipt: Extract<ReturnType<TaskRepository["submitOnce"]>, { status: "submitted" }>,
  task: TaskSpec,
  state: string,
) {
  const proposal = task.proposal
  return {
    ...receipt,
    title: taskTitle(proposal.objective),
    goal: proposal.objective,
    doneWhen: proposal.acceptance.map(({ id, assertion }) => ({ id, assertion })),
    boundaries: {
      writeScope: proposal.writeScope,
      exclusions: proposal.exclusions,
      constraints: proposal.constraints,
      assumptions: proposal.assumptions,
    },
    state,
    note: "Submission records the task; it does not start execution.",
  }
}
