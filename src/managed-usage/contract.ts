import { z } from "zod"
import { ValuationRouteSchema } from "../models/valuation-schema.ts"

const NonnegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const ManagedUsageAssociationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("task"), planID: z.uuid(), taskID: z.uuid() }),
  z.strictObject({ kind: z.literal("plan"), planID: z.uuid() }),
  z.strictObject({ kind: z.literal("unallocated") }),
])
export type ManagedUsageAssociation = z.infer<typeof ManagedUsageAssociationSchema>

export const ManagedUsageScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("project"),
    projectID: z.string().min(1).max(512),
    projectDirectory: z.string().min(1).max(8_000),
  }),
  z.strictObject({
    kind: z.literal("plan"),
    projectID: z.string().min(1).max(512),
    projectDirectory: z.string().min(1).max(8_000),
    planID: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal("task"),
    projectID: z.string().min(1).max(512),
    projectDirectory: z.string().min(1).max(8_000),
    planID: z.uuid(),
    taskID: z.uuid(),
  }),
])
export type ManagedUsageScope = z.infer<typeof ManagedUsageScopeSchema>

export const ManagedUsageEnrollmentInputSchema = z.strictObject({
  requestID: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => /\S/.test(value)),
  projectID: z.string().min(1).max(512),
  projectDirectory: z.string().min(1).max(8_000),
  sessionID: z.string().min(1).max(256),
  expectedRevision: NonnegativeInteger,
  association: ManagedUsageAssociationSchema,
})
export type ManagedUsageEnrollmentInput = z.infer<typeof ManagedUsageEnrollmentInputSchema>

export const ManagedUsageReadInputSchema = z.strictObject({
  scope: ManagedUsageScopeSchema,
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(4_096).optional(),
})
export type ManagedUsageReadInput = z.infer<typeof ManagedUsageReadInputSchema>

export const ManagedUsageRouteSchema = ValuationRouteSchema
export type ManagedUsageRoute = z.infer<typeof ManagedUsageRouteSchema>

const CategoryFactSchema = z
  .strictObject({
    tokens: z.number().finite().nonnegative().nullable(),
    status: z.enum(["observed", "missing", "unavailable"]),
  })
  .superRefine((category, context) => {
    if ((category.status === "observed") !== (category.tokens !== null))
      context.addIssue({
        code: "custom",
        message: "Observed token categories require a value; missing/unavailable categories do not",
      })
  })

export const ManagedUsageCategoriesSchema = z.strictObject({
  uncachedInput: CategoryFactSchema,
  output: CategoryFactSchema,
  reasoning: CategoryFactSchema,
  cacheRead: CategoryFactSchema,
  cacheWrite: CategoryFactSchema,
})
export type ManagedUsageCategories = z.infer<typeof ManagedUsageCategoriesSchema>

export const ManagedUsageNativeFactSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionID: z.string().min(1).max(256),
  eventKey: z.string().min(1).max(600),
  nativeEventID: z.string().min(1).max(512).nullable(),
  eventType: z.enum(["started", "ended", "failed"]),
  assistantMessageID: z.string().min(1).max(256),
  sequence: NonnegativeInteger.nullable(),
  eventCreatedAt: z.number().finite().nullable(),
  recordedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  agent: z.string().min(1).max(256).nullable(),
  route: ManagedUsageRouteSchema.nullable(),
  routeStatus: z.enum(["observed", "missing", "invalid", "not-applicable"]),
  categories: ManagedUsageCategoriesSchema.nullable(),
})
export type ManagedUsageNativeFact = z.infer<typeof ManagedUsageNativeFactSchema>

export const MANAGED_USAGE_CATEGORIES = [
  "uncachedInput",
  "output",
  "reasoning",
  "cacheRead",
  "cacheWrite",
] as const
export type ManagedUsageCategory = (typeof MANAGED_USAGE_CATEGORIES)[number]
