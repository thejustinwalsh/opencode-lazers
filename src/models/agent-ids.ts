import { z } from "zod"
import { WorkerPersona } from "../runner/schema.ts"

/** The agents LAZERS starts, in display order. OpenCode's own built-ins are not here. */
export const LAZERS_AGENTS = [
  { agentID: "architect", label: "Architect" },
  { agentID: "lazers-implementor", label: "Implementor" },
  { agentID: "auditor", label: "Auditor" },
] as const

export const AgentRouteID = z.enum(["architect", "lazers-implementor", "auditor"])
export type AgentRouteID = z.infer<typeof AgentRouteID>

/**
 * What a model route is saved for: a worker persona (UI, Systems, Small task) or a whole agent.
 * Both live in the one versioned mapping store, so agent routes get the same layers (all
 * projects, this project), revisions and history as persona routes.
 */
export const ModelMappingSubject = z.enum([...WorkerPersona.options, ...AgentRouteID.options])
export type ModelMappingSubject = z.infer<typeof ModelMappingSubject>

export const isAgentSubject = (subject: string): subject is AgentRouteID =>
  AgentRouteID.safeParse(subject).success

export const agentLabels: Record<AgentRouteID, string> = {
  architect: "Architect",
  "lazers-implementor": "Implementor",
  auditor: "Auditor",
}
