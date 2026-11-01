import { z } from "zod"
import { privacyStats, safeText } from "../../trajectory/privacy.ts"

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)

/** Store only concise facts and references, never arbitrary native payloads. */
function safeTextSchema(maximum: number) {
  return z
    .string()
    .min(1)
    .max(maximum)
    .regex(/\S/, "Must contain non-whitespace text")
    .superRefine((value, ctx) => {
      const trimmed = value.trimStart()
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          const parsed: unknown = JSON.parse(value)
          if (typeof parsed === "object" && parsed !== null) {
            ctx.addIssue({
              code: "custom",
              message: "Store a concise fact, not structured payload",
            })
            return
          }
        } catch {
          // Ordinary prose may begin with a brace; continue with secret checks.
        }
      }
      if (safeText(value, privacyStats(), maximum) !== value)
        ctx.addIssue({ code: "custom", message: "Remove credentials or sensitive data" })
    })
}

const shortText = safeTextSchema(500)
const reference = safeTextSchema(1_024)
const fact = safeTextSchema(2_000)
const requestID = z.string().min(1).max(200).regex(/\S/)
const actorSchema = z.strictObject({
  sessionID: safeTextSchema(200),
  agent: identifier,
})

/** Durable source record identity; revision changes invalidate older receipts. */
export const ProbeBasisSchema = z.strictObject({
  recordID: safeTextSchema(500),
  revision: safeTextSchema(200),
})
export type ProbeBasis = z.infer<typeof ProbeBasisSchema>

export const ProbeCandidateSchema = z.strictObject({
  // Candidate freshness is a Git object identity, not a content hash invented by this feature.
  revision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  workspace: reference,
})
export type ProbeCandidate = z.infer<typeof ProbeCandidateSchema>

export const ProbeTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("task"), taskID: z.uuid() }),
  z.strictObject({ kind: z.literal("combined-candidate"), planID: z.uuid() }),
])
export type ProbeTarget = z.infer<typeof ProbeTargetSchema>

export const ProbeScenarioSchema = z.strictObject({
  id: identifier,
  summary: shortText,
  acceptanceIDs: z.array(identifier).min(1).max(100),
  procedure: ProbeBasisSchema,
})
export type ProbeScenario = z.infer<typeof ProbeScenarioSchema>

export const ProbeNotApplicableSchema = z.strictObject({
  acceptanceID: identifier,
  reason: fact,
})
export type ProbeNotApplicable = z.infer<typeof ProbeNotApplicableSchema>

export const ProbeDefinitionInputSchema = z
  .strictObject({
    requestID,
    definitionID: z.uuid().optional(),
    expectedRevision: z.int().positive().optional(),
    target: ProbeTargetSchema,
    scenarios: z.array(ProbeScenarioSchema).max(100),
    notApplicable: z.array(ProbeNotApplicableSchema).max(100),
  })
  .superRefine((input, ctx) => {
    if ((input.definitionID === undefined) !== (input.expectedRevision === undefined))
      ctx.addIssue({
        code: "custom",
        path: ["expectedRevision"],
        message: "A new revision requires both definitionID and expectedRevision",
      })
    const scenarioIDs = new Set<string>()
    input.scenarios.forEach((scenario, index) => {
      if (scenarioIDs.has(scenario.id))
        ctx.addIssue({
          code: "custom",
          path: ["scenarios", index, "id"],
          message: "Duplicate scenario ID",
        })
      scenarioIDs.add(scenario.id)
      if (new Set(scenario.acceptanceIDs).size !== scenario.acceptanceIDs.length)
        ctx.addIssue({
          code: "custom",
          path: ["scenarios", index, "acceptanceIDs"],
          message: "Duplicate acceptance reference",
        })
    })
    const notApplicableIDs = input.notApplicable.map((item) => item.acceptanceID)
    if (new Set(notApplicableIDs).size !== notApplicableIDs.length)
      ctx.addIssue({
        code: "custom",
        path: ["notApplicable"],
        message: "Duplicate not-applicable assertion",
      })
  })
export type ProbeDefinitionInput = z.infer<typeof ProbeDefinitionInputSchema>

export const ProbeDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  definitionID: z.uuid(),
  revision: z.int().positive(),
  target: ProbeTargetSchema,
  acceptanceBasis: z.strictObject({ revision: z.int().positive() }),
  scenarios: z.array(ProbeScenarioSchema),
  notApplicable: z.array(ProbeNotApplicableSchema),
  authoredBy: actorSchema,
  createdAt: z.number().int().nonnegative(),
})
export type ProbeDefinition = z.infer<typeof ProbeDefinitionSchema>

const ProbeActionSchema = z.strictObject({
  kind: z.enum(["setup", "navigate", "interact", "inspect", "cleanup", "other"]),
  summary: shortText,
  reference: reference.optional(),
})
export type ProbeAction = z.infer<typeof ProbeActionSchema>

const ProbeObservationSchema = z.strictObject({
  source: z.enum(["tool-observation", "worker-commentary", "architect-judgment"]),
  fact,
  reference: reference.optional(),
})
export type ProbeObservation = z.infer<typeof ProbeObservationSchema>

const ProbeEvidenceReferenceSchema = z.strictObject({
  kind: z.enum(["artifact", "interaction", "runtime", "external"]),
  reference,
})
export type ProbeEvidenceReference = z.infer<typeof ProbeEvidenceReferenceSchema>

export const ProbeTimingSchema = z.strictObject({
  startedAt: z.number().int().nonnegative().nullable(),
  finishedAt: z.number().int().nonnegative().nullable(),
  elapsedMs: z.number().int().nonnegative().nullable(),
})
export type ProbeTiming = z.infer<typeof ProbeTimingSchema>

export const ProbeUsageSchema = z.strictObject({
  tokens: z.number().int().nonnegative().nullable(),
  toolCalls: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
})
export type ProbeUsage = z.infer<typeof ProbeUsageSchema>

export const ProbeCleanupState = z.enum(["not-required", "pending", "complete", "failed"])
export type ProbeCleanupState = z.infer<typeof ProbeCleanupState>
export const ProbeLifecycle = z.enum(["pending", "interrupted", "cancelled", "completed"])
export type ProbeLifecycle = z.infer<typeof ProbeLifecycle>
export const ProbeVerdict = z.enum(["passed", "product-failed", "environment-blocked"])
export type ProbeVerdict = z.infer<typeof ProbeVerdict>

export const ProbeRunStartInputSchema = z.strictObject({
  requestID,
  definitionID: z.uuid(),
  definitionRevision: z.int().positive(),
  scenarioID: identifier,
  attemptID: z.uuid(),
  candidate: ProbeCandidateSchema,
  inputs: ProbeBasisSchema,
  environment: ProbeBasisSchema,
  capabilities: z.array(shortText).max(100),
  setupReferences: z.array(reference).max(100),
  fixtureReferences: z.array(reference).max(100),
  actions: z.array(ProbeActionSchema).max(200),
  observations: z.array(ProbeObservationSchema).max(200),
  evidenceReferences: z.array(ProbeEvidenceReferenceSchema).max(100),
  timing: ProbeTimingSchema,
  usage: ProbeUsageSchema,
  cleanupState: ProbeCleanupState,
})
export type ProbeRunStartInput = z.infer<typeof ProbeRunStartInputSchema>

export const ProbeRunUpdateInputSchema = z
  .strictObject({
    requestID,
    runID: z.uuid(),
    expectedVersion: z.int().positive(),
    lifecycle: ProbeLifecycle,
    verdict: ProbeVerdict.nullable(),
    actions: z.array(ProbeActionSchema).max(200),
    observations: z.array(ProbeObservationSchema).max(200),
    evidenceReferences: z.array(ProbeEvidenceReferenceSchema).max(100),
    timing: ProbeTimingSchema,
    usage: ProbeUsageSchema,
    cleanupState: ProbeCleanupState,
  })
  .superRefine((input, ctx) => {
    if ((input.lifecycle === "completed") !== (input.verdict !== null))
      ctx.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "Only a completed run has a product or environment verdict",
      })
  })
export type ProbeRunUpdateInput = z.infer<typeof ProbeRunUpdateInputSchema>

export const ProbeRunSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    runID: z.uuid(),
    requestID,
    version: z.int().positive(),
    definitionID: z.uuid(),
    definitionRevision: z.int().positive(),
    scenarioID: identifier,
    acceptanceIDs: z.array(identifier),
    target: ProbeTargetSchema,
    taskID: z.uuid(),
    planID: z.uuid(),
    attemptID: z.uuid(),
    sessionID: safeTextSchema(200),
    producer: actorSchema,
    candidate: ProbeCandidateSchema,
    procedure: ProbeBasisSchema,
    inputs: ProbeBasisSchema,
    environment: ProbeBasisSchema,
    capabilities: z.array(shortText),
    setupReferences: z.array(reference),
    fixtureReferences: z.array(reference),
    actions: z.array(ProbeActionSchema),
    observations: z.array(ProbeObservationSchema),
    evidenceReferences: z.array(ProbeEvidenceReferenceSchema),
    timing: ProbeTimingSchema,
    usage: ProbeUsageSchema,
    lifecycle: ProbeLifecycle,
    verdict: ProbeVerdict.nullable(),
    cleanupState: ProbeCleanupState,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .superRefine((run, ctx) => {
    if ((run.lifecycle === "completed") !== (run.verdict !== null))
      ctx.addIssue({ code: "custom", path: ["verdict"], message: "Lifecycle and verdict disagree" })
  })
export type ProbeRun = z.infer<typeof ProbeRunSchema>

export const ProbeEligibilityInputSchema = z.strictObject({
  candidate: ProbeCandidateSchema,
  procedure: ProbeBasisSchema,
  inputs: ProbeBasisSchema,
  environment: ProbeBasisSchema,
})
export type ProbeEligibilityInput = z.infer<typeof ProbeEligibilityInputSchema>

export const ProbeActorSchema = actorSchema
export type ProbeActor = z.infer<typeof ProbeActorSchema>
