import { z } from "zod"
import { ignoringLegacyFields } from "./legacy-fields.ts"

/** A reviewed, directed relation from a correction task to its same-goal original. */
export const TaskCorrectionInput = z.strictObject({
  taskID: z.uuid(),
  originalTaskID: z.uuid().nullable(),
  requestID: z.string().min(1).max(200).regex(/\S/, "requestID must contain non-whitespace text"),
  /** Compare-and-set guard for callers that read a revision; omitted writes against the current one. */
  expectedRevision: z.int().nonnegative().optional(),
  reason: z.string().trim().min(1).max(2_000),
})
type TaskCorrectionInput = z.infer<typeof TaskCorrectionInput>

/** The model tool never supplies a revision; a legacy `expectedRevision` is ignored. */
export const TaskCorrectionToolInput = ignoringLegacyFields(
  TaskCorrectionInput.omit({ expectedRevision: true }),
  ["expectedRevision"],
)

export const TaskCorrectionRecord = z.strictObject({
  id: z.int().positive(),
  taskID: z.uuid(),
  originalTaskID: z.uuid().nullable(),
  requestID: z.string(),
  revision: z.int().positive(),
  reason: z.string(),
  sessionID: z.string().min(1),
  agent: z.string().min(1),
  createdAt: z.iso.datetime(),
})
export type TaskCorrectionRecord = z.infer<typeof TaskCorrectionRecord>

export const TaskCorrectionReceipt = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("recorded"),
    correction: TaskCorrectionRecord,
  }),
  z.strictObject({
    status: z.literal("replayed"),
    correction: TaskCorrectionRecord,
  }),
  z.strictObject({
    status: z.literal("conflict"),
    taskID: z.uuid(),
    message: z.string(),
    expectedRevision: z.int().nonnegative().optional(),
    currentRevision: z.int().nonnegative().optional(),
  }),
])
export type TaskCorrectionReceipt = z.infer<typeof TaskCorrectionReceipt>

export const TaskCorrectionInspectionInput = z.strictObject({ taskID: z.uuid() })
type TaskCorrectionInspectionInput = z.infer<typeof TaskCorrectionInspectionInput>

export const TaskCorrectionRevisionIdentity = z.strictObject({
  schemaVersion: z.literal(1),
  projectDirectory: z.string(),
  storage: z.enum(["available", "missing-table"]),
  revision: z.int().nonnegative().nullable(),
  taskRevision: z.int().nonnegative().nullable(),
})
export type TaskCorrectionRevisionIdentity = z.infer<typeof TaskCorrectionRevisionIdentity>

const TaskCorrectionMembership = z.strictObject({
  taskID: z.uuid(),
  rootTaskID: z.uuid(),
  memberTaskIDs: z.array(z.uuid()),
  relation: z.enum(["unreviewed", "linked", "independent"]),
  originalTaskID: z.uuid().nullable(),
  revision: z.int().nonnegative(),
  history: z.array(TaskCorrectionRecord),
})
export type TaskCorrectionMembership = z.infer<typeof TaskCorrectionMembership>

export const TaskCorrectionsSnapshot = z.strictObject({
  identity: TaskCorrectionRevisionIdentity,
  tasks: z.array(TaskCorrectionMembership),
})
export type TaskCorrectionsSnapshot = z.infer<typeof TaskCorrectionsSnapshot>

export const TaskCorrectionInspection = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("found"),
    identity: TaskCorrectionRevisionIdentity,
    task: TaskCorrectionMembership,
    members: z.array(TaskCorrectionMembership),
  }),
  z.strictObject({
    status: z.literal("not_found"),
    identity: TaskCorrectionRevisionIdentity,
  }),
])
export type TaskCorrectionInspection = z.infer<typeof TaskCorrectionInspection>
