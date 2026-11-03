import { z } from "zod"

export const TaskKindV1 = z.enum([
  "bug-repair",
  "feature-implementation",
  "refactoring",
  "testing",
  "documentation",
  "maintenance",
])
export type TaskKindV1 = z.infer<typeof TaskKindV1>

/** Explicit, versioned primary task kind. Persona and execution outcome are separate. */
export const TaskClassification = z.strictObject({
  taxonomy: z.literal("task-kind/v1"),
  primaryKind: TaskKindV1,
})
export type TaskClassification = z.infer<typeof TaskClassification>

export const TaskClassificationAnnotationInput = z.strictObject({
  taskID: z.uuid(),
  requestID: z.string().min(1).max(200).regex(/\S/, "requestID must contain non-whitespace text"),
  expectedRevision: z.int().nonnegative(),
  classification: TaskClassification,
  reason: z.string().trim().min(1).max(2_000),
})
export type TaskClassificationAnnotationInput = z.infer<typeof TaskClassificationAnnotationInput>

export const TaskClassificationAnnotationRecord = z.strictObject({
  id: z.int().positive(),
  taskID: z.uuid(),
  requestID: z.string(),
  revision: z.int().positive(),
  classification: TaskClassification,
  reason: z.string(),
  sessionID: z.string().min(1),
  agent: z.string().min(1),
  createdAt: z.iso.datetime(),
})
export type TaskClassificationAnnotationRecord = z.infer<typeof TaskClassificationAnnotationRecord>

export const TaskClassificationProvenance = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("legacy") }),
  z.strictObject({
    kind: z.literal("embedded"),
    sessionID: z.string(),
    createdAt: z.iso.datetime(),
  }),
  z.strictObject({
    kind: z.literal("annotation"),
    requestID: z.string(),
    sessionID: z.string(),
    agent: z.string(),
    reason: z.string(),
    createdAt: z.iso.datetime(),
  }),
])

export const TaskClassificationRevision = z.strictObject({
  revision: z.int().nonnegative(),
  classification: TaskClassification.nullable(),
  provenance: TaskClassificationProvenance,
})
export type TaskClassificationRevision = z.infer<typeof TaskClassificationRevision>

export const TaskClassificationSnapshot = z.strictObject({
  current: TaskClassificationRevision,
  history: z.array(TaskClassificationRevision),
})
export type TaskClassificationSnapshot = z.infer<typeof TaskClassificationSnapshot>

export const TaskClassificationAnnotationReceipt = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("recorded"),
    annotation: TaskClassificationAnnotationRecord,
  }),
  z.strictObject({
    status: z.literal("replayed"),
    annotation: TaskClassificationAnnotationRecord,
  }),
  z.strictObject({
    status: z.literal("conflict"),
    taskID: z.uuid(),
    message: z.string(),
    expectedRevision: z.int().nonnegative().optional(),
    currentRevision: z.int().nonnegative().optional(),
  }),
])
export type TaskClassificationAnnotationReceipt = z.infer<
  typeof TaskClassificationAnnotationReceipt
>
