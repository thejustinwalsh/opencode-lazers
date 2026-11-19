import { z } from "zod"

const RetainedVerificationPhase = z.enum(["task", "combined"])
type RetainedVerificationPhase = z.infer<typeof RetainedVerificationPhase>

/** One call: pending, then task checks, then a recorded pass (accepted) or fail. */
const RetainedVerificationState = z.enum([
  "pending",
  "task-checks",
  "accepted",
  "failed",
  "cancelled",
])
type RetainedVerificationState = z.infer<typeof RetainedVerificationState>

const RetainedVerificationCleanupState = z.enum(["pending", "complete", "failed"])
type RetainedVerificationCleanupState = z.infer<typeof RetainedVerificationCleanupState>

export const RetainedVerificationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  projectID: z.string().min(1).max(200),
  projectDirectory: z.string().min(1).max(1_024),
  planID: z.uuid(),
  planRevision: z.int().positive(),
  owner: z.string().min(1).max(200),
  taskID: z.uuid(),
  taskRevision: z.int().positive(),
  attemptID: z.uuid(),
  originalSessionID: z.string().min(1).max(200),
  originalMessageID: z.string().min(1).max(200),
  originalWorkspace: z.string().min(1).max(1_024),
  artifact: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  repair: z
    .strictObject({
      operationID: z.string().min(1),
      previousArtifact: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    })
    .optional(),
  taskWorkspace: z.string().min(1).max(1_024).nullable(),
  taskWorkspaceState: z.enum(["reserved", "owned", "uncertain", "removed"]).nullable(),
  /**
   * Retired: older operations carry a second, combined checkout. Nothing creates
   * one now; terminal cleanup still removes the ones that exist.
   */
  combinedArtifact: z
    .string()
    .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
    .nullable()
    .optional(),
  combinedWorkspace: z.string().min(1).max(1_024).nullable().optional(),
  combinedWorkspaceState: z
    .enum(["reserved", "owned", "uncertain", "removed"])
    .nullable()
    .optional(),
  environmentIdentity: z.string().min(1),
  reason: z.string().min(1).max(2_000),
  state: RetainedVerificationState,
  /** Why the call failed; null while it runs or after it passes. */
  failureReason: z.string().max(2_000).nullable(),
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
