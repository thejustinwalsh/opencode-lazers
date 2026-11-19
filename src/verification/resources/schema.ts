import { z } from "zod"
import { ProbeActorSchema, ProbeCandidateSchema, ProbeBasisSchema } from "../probe/schema.ts"
import { privacyStats, safeText } from "../../trajectory/privacy.ts"

const requestID = z.string().min(1).max(200).regex(/\S/)
const resourceName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
const fixtureContents = z
  .string()
  .max(32_768)
  .superRefine((value, ctx) => {
    if (safeText(value, privacyStats(), 32_768) !== value)
      ctx.addIssue({
        code: "custom",
        message: "Fixture contents must not retain credentials or private data",
      })
  })

export const ResourceOwnerSchema = z.strictObject({
  projectDirectory: z.string().min(1).max(1_024).regex(/\S/),
  runID: z.uuid(),
  taskID: z.uuid(),
  planID: z.uuid(),
  attemptID: z.uuid(),
  sessionID: z.string().min(1).max(200).regex(/\S/),
  producer: ProbeActorSchema,
  candidate: ProbeCandidateSchema,
  environment: ProbeBasisSchema,
})
export type ResourceOwner = z.infer<typeof ResourceOwnerSchema>

/** One bounded text fixture scoped to the adapter's configured root. */
export const ResourceRegistrationInputSchema = z.strictObject({
  requestID,
  generation: z.int().positive(),
  name: resourceName,
  contents: fixtureContents,
})
export type ResourceRegistrationInput = z.infer<typeof ResourceRegistrationInputSchema>

/** Adapter-derived canonical identity; callers cannot choose a conflict key. */
export const ResourceDescriptorSchema = z.strictObject({
  requestID,
  generation: z.int().positive(),
  name: resourceName,
  contents: fixtureContents,
  resourceKey: z.string().min(1).max(2_048).regex(/\S/),
})
export type ResourceDescriptor = z.infer<typeof ResourceDescriptorSchema>

const ResourceStateSchema = z.enum([
  "reserved",
  "creating",
  "active",
  "deleting",
  "uncertain",
  "removed",
])
export type ResourceState = z.infer<typeof ResourceStateSchema>

export const OwnedResourceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  resourceID: z.uuid(),
  requestID,
  runID: z.uuid(),
  owner: ResourceOwnerSchema,
  resourceKey: z.string().min(1).max(2_048).regex(/\S/),
  name: resourceName,
  generation: z.int().positive(),
  contents: fixtureContents,
  state: ResourceStateSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})
export type OwnedResource = z.infer<typeof OwnedResourceSchema>

const ResourceExecutionPhaseSchema = z.enum([
  "registered",
  "preparing",
  "probing",
  "finished",
  "interrupted",
])
export type ResourceExecutionPhase = z.infer<typeof ResourceExecutionPhaseSchema>

export const ResourceExecutionSchema = z.strictObject({
  runID: z.uuid(),
  phase: ResourceExecutionPhaseSchema,
  updatedAt: z.number().int().nonnegative(),
})
export type ResourceExecution = z.infer<typeof ResourceExecutionSchema>

export type ResourceObservation = {
  state: "absent" | "owned" | "foreign" | "unknown"
  authoritative: boolean
  reason?: string | undefined
}
