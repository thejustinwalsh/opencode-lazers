import { z } from "zod"

export const RetainedVerificationPhase = z.enum(["task", "combined"])
export type RetainedVerificationPhase = z.infer<typeof RetainedVerificationPhase>

export const RetainedVerificationState = z.enum([
  "pending",
  "task-checks",
  "combined-checks",
  "waiting-human",
  "waiting-human-combined",
  "accepted",
  "failed",
  "held",
  "cancelled",
])
export type RetainedVerificationState = z.infer<typeof RetainedVerificationState>

export const RetainedVerificationCleanupState = z.enum(["pending", "complete", "failed"])
export type RetainedVerificationCleanupState = z.infer<typeof RetainedVerificationCleanupState>

export const RetainedVerificationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  generation: z.int().positive(),
  projectID: z.string().min(1).max(200),
  projectDirectory: z.string().min(1).max(1_024),
  planID: z.uuid(),
  planRevision: z.int().positive(),
  planVersion: z.int().positive(),
  owner: z.string().min(1).max(200),
  ownerEpoch: z.int().nonnegative(),
  taskID: z.uuid(),
  taskRevision: z.int().positive(),
  attemptID: z.uuid(),
  originalSessionID: z.string().min(1).max(200),
  originalMessageID: z.string().min(1).max(200),
  originalWorkspace: z.string().min(1).max(1_024),
  artifact: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  combinedArtifact: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  taskWorkspace: z.string().min(1).max(1_024).nullable(),
  taskWorkspaceState: z.enum(["reserved", "owned", "uncertain", "removed"]).nullable(),
  combinedWorkspace: z.string().min(1).max(1_024).nullable(),
  combinedWorkspaceState: z.enum(["reserved", "owned", "uncertain", "removed"]).nullable(),
  inputFingerprint: z.string().min(1),
  environmentIdentity: z.string().min(1),
  reason: z.string().min(1).max(2_000),
  state: RetainedVerificationState,
  holdReason: z.string().max(2_000).nullable(),
  cleanupState: RetainedVerificationCleanupState,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})
export type RetainedVerification = z.infer<typeof RetainedVerificationSchema>

export const RetainedVerificationCheckSchema = z.strictObject({
  operationID: z.uuid(),
  phase: RetainedVerificationPhase,
  checkID: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  checkJSON: z.string().min(1),
  workspace: z.string().min(1),
  artifact: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  inputFingerprint: z.string().min(1),
  environmentIdentity: z.string().min(1),
  receiptPath: z.string().min(1),
  state: z.enum(["intended", "completed", "uncertain"]),
  receipt: z.string().nullable(),
  contextPath: z.string().min(1),
  cleanupState: RetainedVerificationCleanupState,
  createdAt: z.number().int().nonnegative(),
})
export type RetainedVerificationCheck = z.infer<typeof RetainedVerificationCheckSchema>

export const RetainedVerificationEvidenceSchema = z.strictObject({
  id: z.uuid(),
  operationID: z.uuid(),
  generation: z.int().positive(),
  phase: RetainedVerificationPhase,
  taskID: z.uuid().nullable(),
  assertionID: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  artifact: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  body: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
})
export type RetainedVerificationEvidence = z.infer<typeof RetainedVerificationEvidenceSchema>
