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

export const HandoffKnowledge = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("known"), value: text }),
  z.strictObject({ status: z.literal("unknown"), reason: text.optional() }),
  z.strictObject({ status: z.literal("not-applicable"), reason: text.optional() }),
])
export type HandoffKnowledge = z.infer<typeof HandoffKnowledge>

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
export type HandoffDraft = z.infer<typeof HandoffDraft>

export const HandoffDraftSubmissionInput = z.strictObject({
  requestID: identifier,
  draftID: z.uuid(),
  draft: HandoffDraft,
})
export type HandoffDraftSubmissionInput = z.infer<typeof HandoffDraftSubmissionInput>

export const HandoffRequestBody = z.strictObject({
  purpose: text,
  references: HandoffEvidenceList,
})
export type HandoffRequestBody = z.infer<typeof HandoffRequestBody>

export const HandoffActor = z.strictObject({
  sessionID: identifier,
  agent: identifier,
  role: z.enum(["worker", "architect"]),
})
export type HandoffActor = z.infer<typeof HandoffActor>

export const HandoffRequestInput = z.strictObject({
  requestID: identifier,
  sourceAttemptID: z.uuid(),
  request: HandoffRequestBody,
})
export type HandoffRequestInput = z.infer<typeof HandoffRequestInput>

export const HandoffAttachment = z.strictObject({
  projectDirectory: reference,
  planID: z.uuid(),
  taskID: z.uuid(),
  specRevision: z.int().positive(),
  attemptID: z.uuid(),
  sourceSessionID: identifier,
  requestGeneration: z.int().positive(),
})
export type HandoffAttachment = z.infer<typeof HandoffAttachment>

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
export type HandoffReviewOutcomeInput = z.infer<typeof HandoffReviewOutcomeInput>

export const HandoffFinalizeInput = z.strictObject({
  finalizationID: z.uuid(),
  requestID: identifier,
  draftVersion: z.int().positive(),
  reviewID: z.uuid(),
  round: z.int().positive(),
})
export type HandoffFinalizeInput = z.infer<typeof HandoffFinalizeInput>

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

export type HandoffHistoryPage = {
  request: HandoffRequestRecord
  events: HandoffEventRecord[]
  nextCursor: string | null
}
