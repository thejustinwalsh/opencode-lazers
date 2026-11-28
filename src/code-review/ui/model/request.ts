import type { CodeReviewHistory } from "../../contract.ts"
import type { ReviewRequest } from "./anchor.ts"
import type { ResolveRequest, ReviewTask } from "../transport.ts"

export type Revision = CodeReviewHistory["revisions"][number]

/** The resolve input for the chosen view, filled from the task's history where the reader left it open. */
export function resolveRequest(
  taskID: string,
  request: ReviewRequest,
  task: Pick<ReviewTask, "planID"> | undefined,
  revisions: readonly Revision[],
): ResolveRequest | undefined {
  const artifacts = revisions.filter((revision) => revision.artifactRevision)
  switch (request.mode) {
    case "task":
      return { taskID, mode: "task" }
    case "live":
      return {
        taskID,
        mode: "live",
        ...(request.attemptID ? { attemptID: request.attemptID } : {}),
      }
    case "plan": {
      const planID = request.planID ?? task?.planID ?? undefined
      return planID ? { taskID, mode: "plan", planID } : undefined
    }
    case "attempt": {
      const attemptID = request.attemptID ?? artifacts[0]?.attemptID
      return attemptID ? { taskID, mode: "attempt", attemptID } : undefined
    }
    case "since": {
      const headAttemptID = request.headAttemptID ?? artifacts[0]?.attemptID
      const head = artifacts.findIndex((revision) => revision.attemptID === headAttemptID)
      const baseAttemptID = request.baseAttemptID ?? artifacts[head + 1]?.attemptID
      return headAttemptID && baseAttemptID && headAttemptID !== baseAttemptID
        ? { taskID, mode: "since", baseAttemptID, headAttemptID }
        : undefined
    }
  }
}
