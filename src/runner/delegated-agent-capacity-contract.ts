import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { DelegatedAgentLimit } from "./delegated-agent-capacity.ts"

const SessionID = z.string().min(1).max(200)

export const DelegatedAgentSettingsReadInput = z.strictObject({ sessionID: SessionID })
export const DelegatedAgentSettingsConfigureInput = z.strictObject({
  sessionID: SessionID,
  expectedRevision: z.number().int().nonnegative(),
  limit: DelegatedAgentLimit,
})

export const DelegatedAgentSettingsOutput = z.strictObject({
  projectDirectory: z.string().min(1),
  revision: z.number().int().nonnegative(),
  limit: DelegatedAgentLimit,
  active: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  reason: z.string().max(400).nullable(),
})

const DelegatedAgentSettingsRecord = z.strictObject({
  projectDirectory: z.string().min(1),
  revision: z.number().int().nonnegative(),
  limit: DelegatedAgentLimit,
})

export const DelegatedAgentSettingsWriteOutput = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("updated"), settings: DelegatedAgentSettingsRecord }),
  z.strictObject({
    status: z.literal("conflict"),
    expectedRevision: z.number().int().nonnegative(),
    currentRevision: z.number().int().nonnegative(),
    current: DelegatedAgentSettingsRecord,
  }),
])

export const DelegatedAgentCapacityRPC = Rpc.define({
  id: "lazers.delegated-agent-capacity",
  methods: {
    read: {
      input: DelegatedAgentSettingsReadInput,
      output: DelegatedAgentSettingsOutput,
    },
    configure: {
      input: DelegatedAgentSettingsConfigureInput,
      output: DelegatedAgentSettingsWriteOutput,
    },
  },
  events: {},
})
