import { Agent } from "@opencode/schema/agent"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { AUDITOR_DEFAULT_MODEL } from "../runner/roles.ts"
import type { ModelPolicy } from "../runner/schema.ts"

import { LAZERS_AGENTS } from "./agent-ids.ts"
export { LAZERS_AGENTS }
type LazersAgentID = (typeof LAZERS_AGENTS)[number]["agentID"]

export type AgentRoute = {
  agentID: LazersAgentID
  label: string
  /** The effective model; null when the agent pins none and uses the session's. */
  model: ModelPolicy | null
  /** `project` or `shared` when a LAZERS route is set; `plugin-default` only for the Auditor. */
  source: "project" | "shared" | "native" | "plugin-default" | "none"
}

/**
 * The model native OpenCode resolves for each LAZERS agent: its own configuration, else (for the
 * Auditor) the plugin's default, else none. Read from the native agent after LAZERS' registration,
 * so the Auditor default is already applied; a model equal to it is labelled the default.
 */
export async function readAgentRoutes(
  ctx: Pick<Plugin.Context, "agent">,
  signal?: AbortSignal,
  /** Where each agent's LAZERS route comes from, when one is set. */
  lazers: (agentID: string) => {
    scope: "project" | "shared"
    route: ModelPolicy
  } | null = () => null,
): Promise<AgentRoute[]> {
  return Promise.all(
    LAZERS_AGENTS.map(async ({ agentID, label }): Promise<AgentRoute> => {
      try {
        const set = lazers(agentID)
        // The planning route is shared by five host agents; one of them shows its effect.
        const hostID = agentID === "lazers-planning" ? "lazers-planning-comprehension" : agentID
        const { data } = await Effect.runPromise(
          ctx.agent.get({ agentID: Agent.ID.make(hostID) }),
          signal ? { signal } : undefined,
        )
        const ref = data.model
        // The host's effective model wins (it is what a session will use); a LAZERS route the
        // host has not applied yet is still the configured model.
        const model: ModelPolicy | null = ref
          ? {
              providerID: String(ref.providerID),
              id: String(ref.id),
              ...(ref.variant !== undefined ? { variant: String(ref.variant) } : {}),
            }
          : (set?.route ?? null)
        if (set) return { agentID, label, model, source: set.scope }
        if (!model) return { agentID, label, model: null, source: "none" }
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
