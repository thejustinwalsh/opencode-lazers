import { sameNativeModel } from "./model-route.ts"
import { isWorkerAgent } from "./worker-agent.ts"
import { z } from "zod"
import type { HostMessage, HostSession } from "./host.ts"
import { ModelPolicy } from "./schema.ts"

const ReviewInputMetadata = z.object({
  taskID: z.uuid(),
  attemptID: z.uuid(),
  requestID: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => value.trim().length > 0),
})

/** Legacy aliases recorded the retired experimental.idle report; they remain readable. */
const LegacyReviewIdleObservation = z.strictObject({
  observedAt: z.number().finite(),
  inputID: z.string().min(1),
  executionStartSequence: z.number().int().nonnegative().safe(),
  eventSequence: z.number().int().nonnegative().safe(),
  terminalSequence: z.number().int().nonnegative().safe(),
  terminalEventID: z.string().min(1),
  terminalMessageID: z.string().min(1),
  projectDirectory: z.string().min(1),
  projectID: z.string().min(1),
  attemptID: z.uuid(),
  sessionID: z.string().min(1),
  workspace: z.string().min(1),
  assignedMessageID: z.string().min(1),
  count: z.literal(0),
  kinds: z.strictObject({ shell: z.literal(0), subagent: z.literal(0), image: z.literal(0) }),
})

const ReviewInputAlias = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("owner-reviewed-native-input-alias"),
  source: z.literal("observed-native-review-input"),
  runtimeSentMessage: z.literal(false),
  projectDirectory: z.string().min(1),
  projectID: z.string().min(1),
  planID: z.uuid(),
  taskID: z.uuid(),
  attemptID: z.uuid(),
  sessionID: z.string().min(1),
  workspace: z.string().min(1),
  assignedMessageID: z.string().min(1),
  reviewInputID: z.string().min(1).max(200),
  reviewRequestID: z.string().min(1).max(200),
  ownerSessionID: z.string().min(1),
  commandRequestID: z.string().min(1).max(200),
  expectedPlanVersion: z.number().int().positive().safe(),
  model: ModelPolicy,
  input: z.strictObject({
    type: z.literal("synthetic"),
    taskID: z.uuid(),
    attemptID: z.uuid(),
    requestID: z.string().min(1).max(200),
  }),
  observation: z.strictObject({
    outcome: z.literal("succeeded"),
    inputID: z.string().min(1).max(200),
    turnState: z.literal("completed"),
    idle: LegacyReviewIdleObservation.optional(),
  }),
})
type ReviewInputAlias = z.infer<typeof ReviewInputAlias>

export type ReviewInputBinding = {
  projectDirectory: string
  projectID: string
  planID: string
  taskID: string
  attemptID: string
  sessionID: string
  workspace: string
  assignedMessageID: string
  reviewInputID: string
  ownerSessionID: string
  commandRequestID: string
  expectedPlanVersion: number
  model: z.infer<typeof ModelPolicy>
}

export type ReviewInputEvidence = ReturnType<typeof observeReviewInput>

function reviewMetadata(
  message: HostMessage,
  binding: Pick<ReviewInputBinding, "taskID" | "attemptID">,
) {
  if (message.type !== "synthetic") return undefined
  const metadata = message.metadata
  if (!metadata || !("lazersReview" in metadata)) return undefined
  const review = ReviewInputMetadata.safeParse(metadata.lazersReview)
  if (
    !review.success ||
    review.data.taskID !== binding.taskID ||
    review.data.attemptID !== binding.attemptID
  )
    return undefined
  return review.data
}

function sameModel(actual: HostSession["model"], expected: z.infer<typeof ModelPolicy>) {
  return sameNativeModel(actual, expected)
}

/**
 * Accepts only the exact native message/current-turn pair and stable terminal
 * live idle observation. The returned relationship is lineage, never acceptance proof.
 */
export function observeReviewInput(worker: HostSession, binding: ReviewInputBinding) {
  if (
    worker.id !== binding.sessionID ||
    worker.projectID !== binding.projectID ||
    worker.directory !== binding.workspace ||
    !isWorkerAgent(worker.agent) ||
    worker.archived ||
    worker.metadata?.lazersAttemptID !== binding.attemptID
  )
    throw new Error("Review input is not in the exact owned worker session")
  if (!sameModel(worker.model, binding.model))
    throw new Error("Review input worker route differs from the admitted attempt")
  if (
    worker.busy ||
    worker.pendingInput !== false ||
    worker.observationUnstable ||
    worker.pendingPermissions !== 0 ||
    worker.pendingForms !== 0
  )
    throw new Error(
      "Review input requires a stable, idle worker with no pending input or approvals",
    )
  const turn = worker.turn
  if (
    worker.outcome !== "succeeded" ||
    !turn ||
    turn.inputID !== binding.reviewInputID ||
    turn.state !== "completed"
  )
    throw new Error("Review input is not the current completed successful native turn")

  const messages = worker.messages.filter((message) => message.id === binding.reviewInputID)
  if (messages.length !== 1) throw new Error("Exact native review input message is unavailable")
  const message = messages[0]!
  const review = reviewMetadata(message, binding)
  if (!review)
    throw new Error("Native input is not a confirmed same-task, same-attempt review input")
  if ((worker.runningShells ?? 0) !== 0 || (worker.activeChildren ?? 0) !== 0)
    throw new Error("Review input requires a worker with no running shells or child sessions")

  return {
    reviewRequestID: review.requestID,
    input: {
      type: "synthetic" as const,
      taskID: review.taskID,
      attemptID: review.attemptID,
      requestID: review.requestID,
    },
    observation: {
      outcome: "succeeded" as const,
      inputID: turn.inputID,
      turnState: "completed" as const,
    },
  }
}

export function parseReviewInputAlias(value: unknown): ReviewInputAlias | undefined {
  const parsed = ReviewInputAlias.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export function matchesReviewInputAlias(
  alias: ReviewInputAlias,
  binding: Pick<
    ReviewInputBinding,
    | "projectDirectory"
    | "projectID"
    | "planID"
    | "taskID"
    | "attemptID"
    | "sessionID"
    | "workspace"
    | "assignedMessageID"
    | "reviewInputID"
  >,
) {
  return (
    alias.kind === "owner-reviewed-native-input-alias" &&
    alias.projectDirectory === binding.projectDirectory &&
    alias.projectID === binding.projectID &&
    alias.planID === binding.planID &&
    alias.taskID === binding.taskID &&
    alias.attemptID === binding.attemptID &&
    alias.sessionID === binding.sessionID &&
    alias.workspace === binding.workspace &&
    alias.assignedMessageID === binding.assignedMessageID &&
    alias.reviewInputID === binding.reviewInputID
  )
}
