import { spawnSync } from "node:child_process"
import { TaskSubmissionSchema } from "./task.ts"
import type { TaskRepository } from "./storage.ts"
import type { TaskSpec } from "./task.ts"
import { taskTitle } from "./tasks/presentation.ts"
import {
  invalidVerificationTimings,
  verificationTimeoutDefaults,
} from "./runner/verification-timeout.ts"
import type { VerificationTimeoutDefaults } from "./runner/verification-timeout.ts"

class InvalidVerificationTimingError extends Error {
  constructor(
    readonly index: number,
    readonly checkID: string,
  ) {
    super("Inactivity allowance cannot exceed the total hard backstop")
  }
}

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
  timeoutDefaults: VerificationTimeoutDefaults = verificationTimeoutDefaults(),
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
  try {
    return repository.submitOnce(idempotencyKey, proposal, () => {
      const invalid = invalidVerificationTimings(proposal.verification, timeoutDefaults)[0]
      if (invalid) throw new InvalidVerificationTimingError(invalid.index, invalid.checkID)
      return {
        schemaVersion: 1 as const,
        id: crypto.randomUUID(),
        revision: 1 as const,
        status: "submitted" as const,
        createdAt: new Date().toISOString(),
        provenance: provenance(),
        proposal,
      }
    })
  } catch (error) {
    if (!(error instanceof InvalidVerificationTimingError)) throw error
    return {
      status: "invalid" as const,
      errors: [
        {
          path: `verification.${error.index}.inactivityTimeoutMs`,
          message: `${error.message} (check ${error.checkID})`,
        },
      ],
    }
  }
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
