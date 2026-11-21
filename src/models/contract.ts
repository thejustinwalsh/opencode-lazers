import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { ModelPolicy } from "../runner/schema.ts"
import { ModelMappingSubject } from "./agent-ids.ts"
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

export const ModelConfigureRPCInputSchema = z.strictObject({
  sessionID: SessionID,
  ...ModelMappingUpdateSchema.shape,
})

export const ModelEvidenceRPCInputSchema = z.strictObject({
  sessionID: SessionID,
  ...ModelEvidenceReadInputSchema.shape,
})
export const ModelSourceRefreshRPCInputSchema = z.strictObject({
  sessionID: SessionID,
  /** The refresh button: fetch every source now, whatever its age. */
  force: z.boolean().optional(),
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
  // The three personas, then the four agents (Architect, Implementor, Auditor, Planning agents).
  personas: z.array(ModelPersonaSettingsSchema).min(3).max(7),
  /**
   * Every agent LAZERS starts, with the model native OpenCode resolves for it: a LAZERS route
   * (project, then all projects) when one is set, else the agent's native configuration, else
   * the plugin default. Absent from older servers.
   */
  agents: z
    .array(
      z.strictObject({
        agentID: z.enum(["architect", "lazers-implementor", "auditor", "lazers-planning"]),
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

export const Models = Rpc.define({
  id: "lazers.models",
  events: {},
  methods: {
    configure: { input: ModelConfigureRPCInputSchema, output: ModelMappingWriteOutputSchema },
    sourceEvidence: { input: ModelEvidenceRPCInputSchema, output: ModelEvidenceOutputSchema },
    refreshSources: { input: ModelSourceRefreshRPCInputSchema, output: ModelEvidenceOutputSchema },
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
