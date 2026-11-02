import { z } from "zod"
import { ModelPolicy, WorkerPersona } from "../runner/schema.ts"

export const ModelMappingTargetInputSchema = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("shared") }),
  z.strictObject({ scope: z.literal("project") }),
  z.strictObject({ scope: z.literal("task"), taskID: z.uuid() }),
])
export type ModelMappingTargetInput = z.infer<typeof ModelMappingTargetInputSchema>

export const ModelMappingTargetSchema = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("shared") }),
  z.strictObject({ scope: z.literal("project"), projectDirectory: z.string().min(1) }),
  z.strictObject({
    scope: z.literal("task"),
    projectDirectory: z.string().min(1),
    taskID: z.uuid(),
  }),
])
export type ModelMappingTarget = z.infer<typeof ModelMappingTargetSchema>

export const ModelMappingUpdateSchema = z.strictObject({
  target: ModelMappingTargetInputSchema,
  persona: WorkerPersona,
  expectedRevision: z.int().nonnegative(),
  /** Null removes an override while retaining its revision in history. */
  route: ModelPolicy.nullable(),
})
export type ModelMappingUpdate = z.infer<typeof ModelMappingUpdateSchema>

export const ModelMappingRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  target: ModelMappingTargetSchema,
  persona: WorkerPersona,
  revision: z.int().positive(),
  route: ModelPolicy.nullable(),
  updatedAt: z.int().nonnegative(),
})
export type ModelMappingRecord = z.infer<typeof ModelMappingRecordSchema>

export const ModelMappingResolutionInputSchema = z.strictObject({
  persona: WorkerPersona,
  taskID: z.uuid().optional(),
})
export type ModelMappingResolutionInput = z.infer<typeof ModelMappingResolutionInputSchema>

export const ModelMappingProvenanceSchema = z.strictObject({
  target: ModelMappingTargetSchema,
  revision: z.int().positive(),
})

export const ModelMappingResolutionSchema = z.discriminatedUnion("status", [
  z.strictObject({
    schemaVersion: z.literal(1),
    status: z.literal("assigned"),
    persona: WorkerPersona,
    personaLabel: z.string().min(1),
    route: ModelPolicy,
    provenance: ModelMappingProvenanceSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    status: z.literal("unassigned"),
    persona: WorkerPersona,
    personaLabel: z.string().min(1),
    route: z.null(),
    provenance: z.null(),
  }),
])
export type ModelMappingResolution = z.infer<typeof ModelMappingResolutionSchema>
