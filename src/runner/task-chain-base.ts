import type { AttemptRow } from "./store.ts"

export type TaskChainAttempt = Pick<
  AttemptRow,
  "plan_id" | "task_id" | "number" | "base_commit" | "artifact"
>

/**
 * Finds the first baseline in a contiguous repair/resume chain. A new attempt joins its prior
 * attempt only when its base is that attempt's artifact; retrying from a different baseline starts
 * a new chain and must not attribute integrated work from elsewhere to the task.
 */
export function taskChainBase(
  attempt: TaskChainAttempt,
  attempts: readonly TaskChainAttempt[],
): string {
  let base = attempt.base_commit
  const earlier = attempts
    .filter(
      (candidate) =>
        candidate.plan_id === attempt.plan_id &&
        candidate.task_id === attempt.task_id &&
        candidate.number < attempt.number,
    )
    .toSorted((left, right) => right.number - left.number)
  for (const previous of earlier) {
    if (previous.artifact !== base) break
    base = previous.base_commit
  }
  return base
}
