import { basename, dirname, isAbsolute } from "node:path"
import { z } from "zod"

const identifier = z.string().min(1).max(256).regex(/\S/)
const path = z.string().min(1).max(4_096).refine(isAbsolute, "Expected an absolute path")
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const positiveInteger = z.number().int().positive().safe()

export const MaintenanceProcessIdentitySchema = z.strictObject({
  pid: positiveInteger,
  startedAt: z.string().min(1).max(256).regex(/\S/),
  command: z.string().min(1).max(4_096).regex(/\S/),
})
export type MaintenanceProcessIdentity = z.infer<typeof MaintenanceProcessIdentitySchema>

/** Exact durable bindings supplied to an offline maintenance inspection. */
export const MaintenanceBindingSchema = z
  .strictObject({
    projectID: identifier,
    projectDirectory: path,
    ownerID: identifier,
    planID: z.uuid(),
    planVersion: positiveInteger,
    taskID: z.uuid(),
    taskRevision: positiveInteger,
    nodeVersion: positiveInteger,
    attemptID: z.uuid(),
    attemptNumber: positiveInteger,
    attemptSessionID: identifier,
    attemptMessageID: identifier,
    effectID: sha256,
    effectKind: z.literal("verify:runner"),
    effectState: z.literal("uncertain"),
    artifact: commit,
    workspace: path,
    checkID: z.literal("runner"),
    command: z.string().min(1).max(8_000).regex(/\S/),
    timeoutMs: positiveInteger,
    inputIdentity: identifier,
    receiptPath: path,
  })
  .superRefine((binding, ctx) => {
    if (binding.inputIdentity !== binding.artifact)
      ctx.addIssue({
        code: "custom",
        path: ["inputIdentity"],
        message: "Must match artifact identity",
      })
    if (
      basename(binding.receiptPath) !== `${binding.checkID}-${binding.artifact}.json` ||
      basename(dirname(binding.receiptPath)) !== binding.attemptID ||
      basename(dirname(dirname(binding.receiptPath))) !== "receipts"
    )
      ctx.addIssue({
        code: "custom",
        path: ["receiptPath"],
        message: "Does not match runner receipt location",
      })
  })
export type MaintenanceBinding = z.infer<typeof MaintenanceBindingSchema>

export const MaintenanceRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestID: identifier,
  binding: MaintenanceBindingSchema,
  /** Missing identity is itself evidence that old-check containment cannot be proven. */
  originalChild: MaintenanceProcessIdentitySchema.nullable(),
})
export type MaintenanceRequest = z.infer<typeof MaintenanceRequestSchema>

const ProjectSnapshotSchema = z.strictObject({
  id: identifier,
  directory: path,
})

const PlanSnapshotSchema = z.strictObject({
  id: z.uuid(),
  projectDirectory: path,
  ownerID: identifier,
  version: positiveInteger,
})

const TaskSnapshotSchema = z.strictObject({
  id: z.uuid(),
  revision: positiveInteger,
  nodeVersion: positiveInteger,
  state: identifier,
  artifact: commit.nullable(),
})

const AttemptSnapshotSchema = z.strictObject({
  id: z.uuid(),
  planID: z.uuid(),
  taskID: z.uuid(),
  number: positiveInteger,
  sessionID: identifier,
  messageID: identifier,
  workspace: path,
  artifact: commit.nullable(),
  state: identifier,
})

const EffectSnapshotSchema = z.strictObject({
  ordinal: positiveInteger,
  id: sha256,
  planID: z.uuid(),
  taskID: z.uuid().nullable(),
  attemptID: z.uuid().nullable(),
  kind: identifier,
  state: identifier,
  payload: z.string().max(32_768),
  receipt: z.string().max(32_768).nullable(),
})

const CandidateSnapshotSchema = z.strictObject({
  workspace: path,
  head: commit.nullable(),
  clean: z.boolean().nullable(),
  unmerged: z.boolean().nullable(),
  /** Accepted for compatibility with old snapshots, but never inspected. */
  manifest: z.unknown().optional(),
})

const SuppliedReceiptSnapshotSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("missing") }),
  z.strictObject({ status: z.literal("present"), receipt: z.unknown() }),
  z.strictObject({ status: z.literal("unavailable") }),
])

const SuppliedClaimsSchema = z.strictObject({
  ready: z.boolean().optional(),
  containmentProven: z.boolean().optional(),
  executionPermitted: z.boolean().optional(),
})

/**
 * An inspection file is a supplied snapshot, not a live database read. The
 * evaluator compares its bindings and separately re-reads the candidate and
 * receipt through injected read-only readers.
 */
export const MaintenanceInspectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  snapshotID: identifier,
  capturedAt: z.number().int().nonnegative(),
  project: ProjectSnapshotSchema,
  plan: PlanSnapshotSchema,
  task: TaskSnapshotSchema,
  attempts: z.array(AttemptSnapshotSchema).min(1).max(1_000),
  effects: z.array(EffectSnapshotSchema).min(1).max(10_000),
  candidate: CandidateSnapshotSchema,
  receipt: SuppliedReceiptSnapshotSchema,
  claims: SuppliedClaimsSchema.optional(),
})
export type MaintenanceInspection = z.infer<typeof MaintenanceInspectionSchema>

/** Existing runner CheckReceipt shape, validated without executing a check. */
export const CheckReceiptSchema = z.strictObject({
  id: identifier,
  command: z.string().min(1).max(8_000).regex(/\S/),
  cwd: path,
  artifact: commit,
  inputIdentity: identifier,
  environmentIdentity: z.string().min(1).regex(/\S/),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  stdout: z.string().max(32_832),
  stderr: z.string().max(32_832),
  unchanged: z.boolean(),
})
export type CheckReceipt = z.infer<typeof CheckReceiptSchema>

export const GitWorkspaceObservationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("observed"),
    root: path,
    head: commit.nullable(),
    clean: z.boolean(),
    unmerged: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("unavailable") }),
])
export type GitWorkspaceObservation = z.infer<typeof GitWorkspaceObservationSchema>

export const ReceiptObservationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("missing") }),
  z.strictObject({ kind: z.literal("present"), receipt: z.unknown() }),
  z.strictObject({ kind: z.literal("unavailable") }),
])
export type ReceiptObservation = z.infer<typeof ReceiptObservationSchema>
