import { z } from "zod"
import { TaskSpecSchema } from "../../task.ts"

const text = z
  .string()
  .min(1)
  .max(8_000)
  .refine((value) => value.trim().length > 0)
const reference = z
  .string()
  .min(1)
  .max(2_000)
  .refine((value) => value.trim().length > 0)
const identifier = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim().length > 0)

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
)
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema)
export type JsonObject = z.infer<typeof JsonObjectSchema>

const HandoffKnowledge = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("known"), value: text }),
  z.strictObject({ status: z.literal("unknown"), reason: text.optional() }),
  z.strictObject({ status: z.literal("not-applicable"), reason: text.optional() }),
])
type HandoffKnowledge = z.infer<typeof HandoffKnowledge>

export const HandoffEvidence = z.strictObject({
  kind: z.enum(["artifact", "verification", "trajectory", "task", "message", "human", "other"]),
  reference,
  note: text.optional(),
})
export type HandoffEvidence = z.infer<typeof HandoffEvidence>

const HandoffEvidenceList = z.array(HandoffEvidence).max(100)

export const HandoffDraft = z.strictObject({
  target: z.strictObject({
    outcome: HandoffKnowledge,
    originalUserIntent: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("reference"), reference }),
      z.strictObject({ status: z.literal("unknown"), reason: text.optional() }),
    ]),
    workerInterpretation: HandoffKnowledge,
    contractReferences: z
      .array(
        z.strictObject({
          kind: z.enum(["specification", "acceptance", "decision", "context"]),
          reference,
        }),
      )
      .max(100),
  }),
  completedWork: z.array(z.strictObject({ summary: text, evidence: HandoffEvidenceList })).max(100),
  partialWork: z.array(z.strictObject({ summary: text, evidence: HandoffEvidenceList })).max(100),
  workspaceState: HandoffKnowledge,
  approaches: z
    .array(
      z.strictObject({
        approach: text,
        result: HandoffKnowledge,
        evidence: HandoffEvidenceList,
      }),
    )
    .max(100),
  failure: z.strictObject({
    status: z.enum(["observed", "blocked", "none", "unknown"]),
    behavior: HandoffKnowledge,
    cause: z.enum(["product", "implementation", "environment", "unknown", "not-applicable"]),
    evidence: HandoffEvidenceList,
  }),
  assumptions: z
    .array(
      z.strictObject({
        claim: text,
        status: z.enum(["supported", "contradicted", "unknown"]),
        evidence: HandoffEvidenceList,
      }),
    )
    .max(100),
  evidence: HandoffEvidenceList,
  preservedObligations: z
    .array(z.strictObject({ requirement: text, sourceReference: reference }))
    .max(100),
  remainingWork: HandoffKnowledge,
  remainingDecisions: HandoffKnowledge,
  reportedOwnership: z.strictObject({
    writerActivity: HandoffKnowledge,
    backgroundActivity: HandoffKnowledge,
    unresolvedNativeEffects: HandoffKnowledge,
    reportedQuiescence: z.enum(["idle", "active", "unknown"]),
  }),
})
type HandoffDraft = z.infer<typeof HandoffDraft>

export const HandoffDraftSubmissionInput = z.strictObject({
  requestID: identifier,
  draftID: z.uuid(),
  draft: HandoffDraft,
})
type HandoffDraftSubmissionInput = z.infer<typeof HandoffDraftSubmissionInput>

export const HandoffRequestBody = z.strictObject({
  purpose: text,
  references: HandoffEvidenceList,
})
type HandoffRequestBody = z.infer<typeof HandoffRequestBody>

export const HandoffActor = z.strictObject({
  sessionID: identifier,
  agent: identifier,
  /** `runtime` is the scheduler's deterministic detector, never a session. */
  role: z.enum(["worker", "architect", "runtime"]),
})
export type HandoffActor = z.infer<typeof HandoffActor>

export const HandoffRequestInput = z.strictObject({
  requestID: identifier,
  sourceAttemptID: z.uuid(),
  request: HandoffRequestBody,
})
type HandoffRequestInput = z.infer<typeof HandoffRequestInput>

export const HandoffAttachment = z.strictObject({
  projectDirectory: reference,
  planID: z.uuid(),
  taskID: z.uuid(),
  specRevision: z.int().positive(),
  attemptID: z.uuid(),
  sourceSessionID: identifier,
  requestGeneration: z.int().positive(),
})
type HandoffAttachment = z.infer<typeof HandoffAttachment>

export const RecoverySource = z.strictObject({
  projectDirectory: reference,
  projectID: identifier,
  planID: z.uuid(),
  taskID: z.uuid(),
  specRevision: z.int().positive(),
  attemptID: z.uuid(),
  sessionID: identifier,
  workspace: reference,
  workerAgent: identifier.nullable(),
  ownerSessionID: identifier,
})
export type RecoverySource = z.infer<typeof RecoverySource>

const RecoveryEvidenceBoundary = z
  .strictObject({
    fromSequence: z.int().nonnegative(),
    throughSequence: z.int().nonnegative(),
  })
  .refine((boundary) => boundary.fromSequence <= boundary.throughSequence, {
    path: ["throughSequence"],
    message: "The evidence boundary cannot end before it begins.",
  })
type RecoveryEvidenceBoundary = z.infer<typeof RecoveryEvidenceBoundary>

const RecoveryEvidence = z
  .array(HandoffEvidence)
  .max(40)
  .superRefine((evidence, context) => {
    const bytes = new TextEncoder().encode(JSON.stringify(evidence)).byteLength
    if (bytes > 32_000)
      context.addIssue({
        code: "custom",
        message: "Recovery evidence must remain within 32,000 UTF-8 bytes.",
      })
  })

export const RecoveryConcernInput = z.strictObject({
  requestID: identifier,
  concernID: z.uuid(),
  sourceAttemptID: z.uuid(),
  ruleID: identifier,
  reason: text,
  evidenceBoundary: RecoveryEvidenceBoundary,
  evidence: RecoveryEvidence,
})
type RecoveryConcernInput = z.infer<typeof RecoveryConcernInput>

export const RecoveryConcernRecord = z.strictObject({
  requestID: identifier,
  concernID: z.uuid(),
  version: z.int().positive(),
  expectedVersion: z.int().nonnegative(),
  source: RecoverySource,
  ruleID: identifier,
  reason: text,
  evidenceBoundary: RecoveryEvidenceBoundary,
  evidence: RecoveryEvidence,
  lastDispositionID: z.uuid().nullable(),
  recordedBy: HandoffActor,
  createdAt: z.iso.datetime(),
})
export type RecoveryConcernRecord = z.infer<typeof RecoveryConcernRecord>

const RecoveryFollowUp = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("at"), dueAt: z.iso.datetime() }),
  z.strictObject({ kind: z.literal("condition"), condition: text }),
])
type RecoveryFollowUp = z.infer<typeof RecoveryFollowUp>

export const RecoveryDispositionInput = z
  .strictObject({
    requestID: identifier,
    dispositionID: z.uuid(),
    concernID: z.uuid(),
    decision: z.enum(["acknowledge", "follow-up"]),
    reason: text,
    evidenceBoundary: RecoveryEvidenceBoundary,
    followUp: RecoveryFollowUp.optional(),
  })
  .superRefine((input, context) => {
    if (input.decision === "follow-up" && !input.followUp)
      context.addIssue({
        code: "custom",
        path: ["followUp"],
        message: "A deferred follow-up requires a concrete time or condition.",
      })
    if (input.decision === "acknowledge" && input.followUp)
      context.addIssue({
        code: "custom",
        path: ["followUp"],
        message: "An acknowledgement cannot also schedule a follow-up.",
      })
  })
export type RecoveryDispositionInput = z.infer<typeof RecoveryDispositionInput>

export const RecoveryDispositionRecord = z.strictObject({
  ...RecoveryDispositionInput.shape,
  /** The concern version this decision covers; the store reads it, the caller never supplies it. */
  expectedVersion: z.int().positive(),
  version: z.int().positive(),
  source: RecoverySource,
  recordedBy: HandoffActor,
  createdAt: z.iso.datetime(),
})
export type RecoveryDispositionRecord = z.infer<typeof RecoveryDispositionRecord>

export const RecoveryConcernPage = z.strictObject({
  source: RecoverySource,
  concerns: z.array(
    z.strictObject({
      concern: RecoveryConcernRecord,
      dispositions: z.array(RecoveryDispositionRecord).max(100),
    }),
  ),
  nextCursor: z.string().nullable(),
})
export type RecoveryConcernPage = z.infer<typeof RecoveryConcernPage>

export const RecoveryCheckpointInput = z.strictObject({
  requestID: identifier,
  attemptID: z.uuid(),
  concernID: z.uuid(),
  evidenceBoundary: RecoveryEvidenceBoundary,
  guidance: text.optional(),
})
type RecoveryCheckpointInput = z.infer<typeof RecoveryCheckpointInput>

export const RecoveryCheckpointRecord = z.strictObject({
  ...RecoveryCheckpointInput.shape,
  /** The concern version this checkpoint covers; the store reads it, the caller never supplies it. */
  expectedVersion: z.int().positive(),
  messageID: identifier,
  source: RecoverySource,
  requestedBy: HandoffActor,
  createdAt: z.iso.datetime(),
})
export type RecoveryCheckpointRecord = z.infer<typeof RecoveryCheckpointRecord>

export const RecoveryCheckpointDelivery = z.strictObject({
  requestID: identifier,
  status: z.enum(["prepared", "admitted", "unknown"]),
  messageID: identifier,
  detail: text.optional(),
  observedAt: z.iso.datetime(),
})
type RecoveryCheckpointDelivery = z.infer<typeof RecoveryCheckpointDelivery>

export const RecoveryCheckpointConsumptionRecord = z.strictObject({
  requestID: identifier,
  messageID: identifier,
  observedCallID: identifier,
  observedBy: HandoffActor,
  createdAt: z.iso.datetime(),
})
type RecoveryCheckpointConsumptionRecord = z.infer<typeof RecoveryCheckpointConsumptionRecord>

export const RecoveryCheckpointResponseInput = z.strictObject({
  requestID: identifier,
  responseID: identifier,
  completed: text,
  attempted: z.array(text).max(20),
  currentBlockers: z.array(text).max(20),
  nextApproach: text,
  evidence: RecoveryEvidence,
})
export type RecoveryCheckpointResponseInput = z.infer<typeof RecoveryCheckpointResponseInput>

export const RecoveryCheckpointResponseRecord = z.strictObject({
  ...RecoveryCheckpointResponseInput.shape,
  source: RecoverySource,
  observedCallID: identifier,
  reportedBy: HandoffActor,
  createdAt: z.iso.datetime(),
})
export type RecoveryCheckpointResponseRecord = z.infer<typeof RecoveryCheckpointResponseRecord>

export const RecoveryCheckpointState = z.strictObject({
  command: RecoveryCheckpointRecord,
  delivery: RecoveryCheckpointDelivery,
  consumption: RecoveryCheckpointConsumptionRecord.nullable(),
  response: RecoveryCheckpointResponseRecord.nullable(),
})
export type RecoveryCheckpointState = z.infer<typeof RecoveryCheckpointState>

export const HandoffSource = z.strictObject({
  attachment: HandoffAttachment,
  task: TaskSpecSchema,
  plan: z.strictObject({
    revision: z.int().positive(),
    version: z.int().positive(),
    state: identifier,
    ownerSessionID: identifier,
    body: JsonObjectSchema,
  }),
  node: z.strictObject({
    state: identifier,
    ordinal: z.int().nonnegative(),
    specRevision: z.int().positive(),
    machineVersion: identifier,
    snapshot: JsonObjectSchema,
  }),
  attempt: z.strictObject({
    number: z.int().positive(),
    state: identifier,
    startedAt: z.number().int().nonnegative(),
    workspace: reference,
    baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
    artifact: z.string().nullable(),
    tokenCount: z.number().int().nonnegative().nullable(),
    toolCount: z.number().int().nonnegative(),
    retryCount: z.number().int().nonnegative(),
    costUSD: z.number().finite().nonnegative().nullable(),
    policyAgent: identifier.nullable(),
  }),
})
export type HandoffSource = z.infer<typeof HandoffSource>

export const HandoffRequestRecord = z.strictObject({
  requestID: identifier,
  requestGeneration: z.int().positive(),
  request: HandoffRequestBody,
  requestedBy: HandoffActor,
  source: HandoffSource,
  createdAt: z.iso.datetime(),
})
export type HandoffRequestRecord = z.infer<typeof HandoffRequestRecord>

export const HandoffDraftRecord = z.strictObject({
  requestID: identifier,
  draftID: z.uuid(),
  draftVersion: z.int().positive(),
  source: HandoffSource,
  author: HandoffActor,
  draft: HandoffDraft,
  createdAt: z.iso.datetime(),
})
export type HandoffDraftRecord = z.infer<typeof HandoffDraftRecord>

export const HandoffReviewCheck = z.strictObject({
  id: identifier,
  definition: JsonValueSchema,
})
export type HandoffReviewCheck = z.infer<typeof HandoffReviewCheck>

export const HandoffReviewReservationInput = z.strictObject({
  requestID: identifier,
  reviewID: z.uuid(),
  round: z.int().positive(),
  draftVersion: z.int().positive(),
  evidenceVersion: identifier,
  evidence: HandoffEvidenceList,
  effectiveContractVersion: identifier,
  effectiveContract: JsonObjectSchema,
  checkVersion: identifier,
  checks: z.array(HandoffReviewCheck).max(128),
})
export type HandoffReviewReservationInput = z.infer<typeof HandoffReviewReservationInput>

export const HandoffUsage = z.strictObject({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  cacheReadTokens: z.number().int().nonnegative().nullable(),
  cacheWriteTokens: z.number().int().nonnegative().nullable(),
  costUSD: z.number().finite().nonnegative().nullable(),
})
export type HandoffUsage = z.infer<typeof HandoffUsage>

export const HandoffReviewOutcome = z
  .strictObject({
    status: z.enum(["feedback", "completed", "completed_with_concerns", "disabled", "unavailable"]),
    result: JsonValueSchema.nullable(),
    concerns: z.array(text).max(100),
    errors: z.array(text).max(100),
    limitation: text.nullable(),
    elapsedMs: z.number().int().nonnegative().nullable(),
    usage: HandoffUsage,
  })
  .superRefine((outcome, context) => {
    const hasLimitation = outcome.status === "disabled" || outcome.status === "unavailable"
    if (hasLimitation !== (outcome.limitation !== null))
      context.addIssue({
        code: "custom",
        path: ["limitation"],
        message:
          "Disabled and unavailable reviews require an explicit limitation; other statuses do not.",
      })
  })
export type HandoffReviewOutcome = z.infer<typeof HandoffReviewOutcome>

export const HandoffReviewRoundRecord = z.strictObject({
  requestID: identifier,
  reviewID: z.uuid(),
  round: z.int().positive(),
  draftVersion: z.int().positive(),
  source: HandoffSource,
  reviewer: HandoffActor,
  evidenceVersion: identifier,
  evidence: HandoffEvidenceList,
  effectiveContractVersion: identifier,
  effectiveContract: JsonObjectSchema,
  checkVersion: identifier,
  checks: z.array(HandoffReviewCheck).max(128),
  reservedAt: z.iso.datetime(),
  outcome: HandoffReviewOutcome.optional(),
  completedAt: z.iso.datetime().optional(),
})
export type HandoffReviewRoundRecord = z.infer<typeof HandoffReviewRoundRecord>

export const HandoffReviewOutcomeInput = z.strictObject({
  requestID: identifier,
  reviewID: z.uuid(),
  round: z.int().positive(),
  outcome: HandoffReviewOutcome,
})
type HandoffReviewOutcomeInput = z.infer<typeof HandoffReviewOutcomeInput>

export const HandoffReviewFinalizationAuthorizationInput = z.strictObject({
  requestID: identifier,
  draftVersion: z.int().positive(),
  reviewID: z.uuid(),
  round: z.int().positive(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  result: JsonObjectSchema,
})
type HandoffReviewFinalizationAuthorizationInput = z.infer<
  typeof HandoffReviewFinalizationAuthorizationInput
>

export const HandoffFinalizeInput = z.strictObject({
  finalizationID: z.uuid(),
  requestID: identifier,
  draftVersion: z.int().positive(),
  reviewID: z.uuid(),
  round: z.int().positive(),
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
})
type HandoffFinalizeInput = z.infer<typeof HandoffFinalizeInput>

export const HandoffReportRecord = z.strictObject({
  reportID: z.uuid(),
  requestID: identifier,
  reportVersion: z.int().positive(),
  finalizationID: z.uuid(),
  draftVersion: z.int().positive(),
  reviewID: z.uuid(),
  round: z.int().positive(),
  reviewStatus: z.enum(["reviewed", "disabled", "unavailable"]),
  limitation: text.nullable(),
  concerns: z.array(text).max(100),
  reviewResult: JsonObjectSchema.optional(),
  source: HandoffSource,
  draft: HandoffDraftRecord,
  review: HandoffReviewRoundRecord,
  finalizedBy: HandoffActor,
  createdAt: z.iso.datetime(),
})
export type HandoffReportRecord = z.infer<typeof HandoffReportRecord>

export const HandoffNotificationIntent = z.strictObject({
  intentID: z.uuid(),
  requestID: identifier,
  reportID: z.uuid(),
  recipientSessionID: identifier,
  status: z.literal("pending"),
  createdAt: z.iso.datetime(),
})
export type HandoffNotificationIntent = z.infer<typeof HandoffNotificationIntent>

const ReferenceStatus = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("recorded"), reference }),
  z.strictObject({ status: z.literal("unknown"), reason: text.optional() }),
  z.strictObject({ status: z.literal("not-applicable") }),
])

export const HandoffDispositionInput = z
  .strictObject({
    dispositionID: z.uuid(),
    requestID: identifier,
    reportID: z.uuid(),
    decision: z.enum(["correct", "redirect", "clarify", "continue", "hold", "reject"]),
    correction: HandoffKnowledge,
    reason: text,
    evidence: HandoffEvidenceList,
    question: ReferenceStatus,
    answer: ReferenceStatus,
    relatedTaskIDs: z.array(z.uuid()).max(20),
  })
  .superRefine((input, context) => {
    if (input.answer.status === "recorded" && input.question.status !== "recorded")
      context.addIssue({
        code: "custom",
        path: ["answer"],
        message: "An answer reference requires the actual question reference.",
      })
    if (input.question.status === "recorded" && input.answer.status === "not-applicable")
      context.addIssue({
        code: "custom",
        path: ["answer"],
        message: "A recorded question with no recorded answer must remain explicitly unknown.",
      })
    if (input.question.status === "not-applicable" && input.answer.status !== "not-applicable")
      context.addIssue({
        code: "custom",
        path: ["answer"],
        message: "An answer cannot be recorded when no human question applies.",
      })
    if (new Set(input.relatedTaskIDs).size !== input.relatedTaskIDs.length)
      context.addIssue({
        code: "custom",
        path: ["relatedTaskIDs"],
        message: "Related task IDs must be unique.",
      })
  })
export type HandoffDispositionInput = z.infer<typeof HandoffDispositionInput>

export const HandoffDispositionRecord = z.strictObject({
  ...HandoffDispositionInput.shape,
  expectedVersion: z.int().nonnegative().optional(),
  version: z.int().positive().default(1),
  source: HandoffSource,
  recordedBy: HandoffActor,
  createdAt: z.iso.datetime(),
})
export type HandoffDispositionRecord = z.infer<typeof HandoffDispositionRecord>

export const HandoffEventRecord = z.strictObject({
  sequence: z.int().positive(),
  requestID: identifier,
  kind: z.enum([
    "request-created",
    "draft-saved",
    "review-reserved",
    "review-completed",
    "review-finalization-authorized",
    "report-finalized",
    "architect-disposition",
  ]),
  recordID: identifier,
  data: JsonValueSchema,
  createdAt: z.iso.datetime(),
})
export type HandoffEventRecord = z.infer<typeof HandoffEventRecord>

export const HandoffHistoryCursor = z.strictObject({
  requestID: identifier,
  before: z.int().positive(),
})

export const RecoveryConcernCursor = z.strictObject({
  attemptID: z.uuid(),
  afterConcernID: z.uuid(),
})

export type HandoffHistoryPage = {
  request: HandoffRequestRecord
  events: HandoffEventRecord[]
  nextCursor: string | null
}

/**
 * Earlier prompts sent a caller-supplied `expectedVersion` (and the first
 * concern version as `0`). The store now reads the current version inside its
 * own transaction, so the field is dropped before validation: an in-flight
 * Architect session whose prompt still names it does not start failing.
 */
export function ignoreLegacyVersion<T extends z.ZodType>(schema: T) {
  return z.preprocess((input) => {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return input
    if (!Object.hasOwn(input, "expectedVersion")) return input
    const { expectedVersion: _legacy, ...rest } = input as Record<string, unknown>
    return rest
  }, schema)
}
