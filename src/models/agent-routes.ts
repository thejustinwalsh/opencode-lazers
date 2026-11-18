import { Agent } from "@opencode/schema/agent"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { AUDITOR_DEFAULT_MODEL } from "../runner/roles.ts"
import type { ModelPolicy } from "../runner/schema.ts"

/** Every agent LAZERS itself starts, in display order. OpenCode's own built-ins are not here. */
export const LAZERS_AGENTS = [
  { agentID: "architect", label: "Architect" },
  { agentID: "lazers-implementor", label: "Implementor" },
  { agentID: "auditor", label: "Auditor" },
] as const

export type LazersAgentID = (typeof LAZERS_AGENTS)[number]["agentID"]

export type AgentRoute = {
  agentID: LazersAgentID
  label: string
  /** The effective model; null when the agent pins none and uses the session's. */
  model: ModelPolicy | null
  /** `plugin-default` only for the Auditor when native configuration pinned nothing. */
  source: "native" | "plugin-default" | "none"
}

/**
 * The model native OpenCode resolves for each LAZERS agent: its own configuration, else (for the
 * Auditor) the plugin's default, else none. Read from the native agent after LAZERS' registration,
 * so the Auditor default is already applied; a model equal to it is labelled the default.
 */
export async function readAgentRoutes(
  ctx: Pick<Plugin.Context, "agent">,
  signal?: AbortSignal,
): Promise<AgentRoute[]> {
  return Promise.all(
    LAZERS_AGENTS.map(async ({ agentID, label }): Promise<AgentRoute> => {
      try {
        const { data } = await Effect.runPromise(
          ctx.agent.get({ agentID: Agent.ID.make(agentID) }),
          signal ? { signal } : undefined,
        )
        const ref = data.model
        if (!ref) return { agentID, label, model: null, source: "none" }
        const model: ModelPolicy = {
          providerID: String(ref.providerID),
          id: String(ref.id),
          ...(ref.variant !== undefined ? { variant: String(ref.variant) } : {}),
        }
        const isDefault =
          agentID === "auditor" &&
          model.providerID === AUDITOR_DEFAULT_MODEL.providerID &&
          model.id === AUDITOR_DEFAULT_MODEL.id
        return { agentID, label, model, source: isDefault ? "plugin-default" : "native" }
      } catch {
        // An agent the host does not know yet has no model to show: say so, invent nothing.
        return { agentID, label, model: null, source: "none" }
      }
    }),
  )
}
