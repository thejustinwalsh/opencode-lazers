import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { ModelPolicy } from "../runner/schema.ts"
import { ModelMappingSubject } from "./agent-ids.ts"
import { ModelComparisonOutputSchema, ModelComparisonReadInputSchema } from "./comparison-schema.ts"
import {
  ModelMappingRecordSchema,
  ModelMappingResolutionSchema,
  ModelMappingUpdateSchema,
} from "./mapping-schema.ts"
import { ModelEvidenceOutputSchema, ModelEvidenceReadInputSchema } from "./source-schema.ts"
import {
  ModelConfigurationsOutputSchema,
  ModelConfigurationsReadInputSchema,
  ModelGroupsOutputSchema,
  ModelGroupsReadInputSchema,
} from "./model-group-schema.ts"
import {
  ModelPriceSourceSettingsSchema,
  ModelPriceSourceUpdateSchema,
  ModelPriceSourceWriteOutputSchema,
} from "./price-source-settings.ts"

const SessionID = z.string().min(1).max(200)

export const ModelSettingsInputSchema = z.strictObject({
  taskID: z.uuid().optional(),
})
export type ModelSettingsInput = z.infer<typeof ModelSettingsInputSchema>

export const ModelSettingsRPCInputSchema = z.strictObject({
  sessionID: SessionID,
  ...ModelSettingsInputSchema.shape,
})

export const ModelConfigureRPCInputSchema = z.strictObject({
  sessionID: SessionID,
  ...ModelMappingUpdateSchema.shape,
})

export const ModelCatalogRPCInputSchema = z.strictObject({ sessionID: SessionID })
export const ModelEvidenceRPCInputSchema = z.strictObject({
  sessionID: SessionID,
  ...ModelEvidenceReadInputSchema.shape,
})
export const ModelSourceRefreshRPCInputSchema = z.strictObject({
  sessionID: SessionID,
  /** The refresh button: fetch every source now, whatever its age. */
  force: z.boolean().optional(),
})
export const ModelComparisonRPCInputSchema = z.strictObject({
  sessionID: SessionID,
  ...ModelComparisonReadInputSchema.shape,
})
export const ModelGroupsRPCInputSchema = z.strictObject({
  sessionID: SessionID,
  ...ModelGroupsReadInputSchema.shape,
})
export const ModelConfigurationsRPCInputSchema = z.strictObject({
  sessionID: SessionID,
  ...ModelConfigurationsReadInputSchema.shape,
})
export const ModelPriceSourceSettingsRPCInputSchema = z.strictObject({ sessionID: SessionID })
export const ModelPriceSourceConfigureRPCInputSchema = z.strictObject({
  sessionID: SessionID,
  ...ModelPriceSourceUpdateSchema.shape,
})

const ModelPersonaSettingsSchema = z.strictObject({
  /** A worker persona, or an agent id: both are routes in the one mapping store. */
  persona: ModelMappingSubject,
  personaLabel: z.string().min(1),
  layers: z.strictObject({
    task: ModelMappingRecordSchema.nullable(),
    project: ModelMappingRecordSchema.nullable(),
    shared: ModelMappingRecordSchema.nullable(),
  }),
  resolution: ModelMappingResolutionSchema,
})

export const ModelSettingsOutputSchema = z.strictObject({
  projectDirectory: z.string().min(1),
  taskID: z.uuid().nullable(),
  // The three personas, then the three agents (Architect, Implementor, Auditor).
  personas: z.array(ModelPersonaSettingsSchema).min(3).max(6),
  /**
   * Every agent LAZERS starts, with the model native OpenCode resolves for it: a LAZERS route
   * (project, then all projects) when one is set, else the agent's native configuration, else
   * the plugin default. Absent from older servers.
   */
  agents: z
    .array(
      z.strictObject({
        agentID: z.enum(["architect", "lazers-implementor", "auditor"]),
        label: z.string().min(1),
        /** The effective model; null when the agent pins none and uses the session's. */
        model: ModelPolicy.nullable(),
        source: z.enum(["project", "shared", "native", "plugin-default", "none"]),
      }),
    )
    .optional(),
})
export type ModelSettingsOutput = z.infer<typeof ModelSettingsOutputSchema>

export const ModelMappingWriteOutputSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("updated"),
    mapping: ModelMappingRecordSchema,
  }),
  z.strictObject({
    status: z.literal("conflict"),
    expectedRevision: z.int().nonnegative(),
    currentRevision: z.int().nonnegative(),
    current: ModelMappingRecordSchema.nullable(),
  }),
])

export const ModelCatalogOutputSchema = z.strictObject({
  source: z.literal("Live native OpenCode model catalog"),
  observedAt: z.iso.datetime(),
  advisoryOnly: z.literal(true),
  note: z.string(),
  configuredImplementor: z
    .strictObject({
      providerID: z.string().min(1),
      id: z.string().min(1),
      variant: z.string().optional(),
    })
    .nullable(),
  options: z.array(
    z.strictObject({
      providerID: z.string().min(1),
      id: z.string().min(1),
      name: z.string(),
      enabled: z.boolean().nullable(),
      type: z.string().nullable(),
      capabilities: z.strictObject({
        tools: z.boolean().nullable(),
        input: z.array(z.string()).nullable(),
        output: z.array(z.string()).nullable(),
      }),
      contextTokens: z.number().nullable(),
      pricesUSDPerMillionTokens: z
        .array(
          z.strictObject({
            contextTierTokens: z.number().nullable(),
            input: z.number(),
            output: z.number(),
            cacheRead: z.number(),
            cacheWrite: z.number(),
          }),
        )
        .nullable(),
      variants: z.array(z.string()),
    }),
  ),
})

export const Models = Rpc.define({
  id: "lazers.models",
  events: {},
  methods: {
    settings: { input: ModelSettingsRPCInputSchema, output: ModelSettingsOutputSchema },
    configure: { input: ModelConfigureRPCInputSchema, output: ModelMappingWriteOutputSchema },
    catalog: { input: ModelCatalogRPCInputSchema, output: ModelCatalogOutputSchema },
    sourceEvidence: { input: ModelEvidenceRPCInputSchema, output: ModelEvidenceOutputSchema },
    refreshSources: { input: ModelSourceRefreshRPCInputSchema, output: ModelEvidenceOutputSchema },
    comparison: { input: ModelComparisonRPCInputSchema, output: ModelComparisonOutputSchema },
    modelGroups: { input: ModelGroupsRPCInputSchema, output: ModelGroupsOutputSchema },
    modelConfigurations: {
      input: ModelConfigurationsRPCInputSchema,
      output: ModelConfigurationsOutputSchema,
    },
    priceSources: {
      input: ModelPriceSourceSettingsRPCInputSchema,
      output: ModelPriceSourceSettingsSchema,
    },
    configurePriceSources: {
      input: ModelPriceSourceConfigureRPCInputSchema,
      output: ModelPriceSourceWriteOutputSchema,
    },
  },
})
