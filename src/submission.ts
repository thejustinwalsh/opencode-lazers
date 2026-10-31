import { spawnSync } from "node:child_process"
import { TaskSubmissionSchema } from "./task.ts"
import type { TaskRepository } from "./storage.ts"
import type { TaskSpec } from "./task.ts"

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
