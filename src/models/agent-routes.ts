import { Agent } from "@opencode/schema/agent"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { AUDITOR_DEFAULT_MODEL } from "../runner/roles.ts"
import type { ModelPolicy } from "../runner/schema.ts"
import { agentRouteOf, type AgentRouteView, type HostAgentFact } from "./assignment-settings.ts"

import { LAZERS_AGENTS } from "./agent-ids.ts"
export { LAZERS_AGENTS }
type LazersAgentID = (typeof LAZERS_AGENTS)[number]["agentID"]

export type AgentRoute = AgentRouteView

/**
 * What the host resolves for each LAZERS agent (`agent.get`), read after LAZERS' registration so
 * the Auditor default is already applied; a model equal to it is the plugin default. An agent the
 * host does not know yet is unreachable: nothing is shown for it, nothing is invented.
 */
export async function readHostAgentFacts(
  ctx: Pick<Plugin.Context, "agent">,
  signal?: AbortSignal,
): Promise<Array<{ agentID: LazersAgentID; fact: HostAgentFact }>> {
  return Promise.all(
    LAZERS_AGENTS.map(async ({ agentID }) => {
      try {
        // The planning route is shared by five host agents; one of them shows its effect.
        const hostID = agentID === "lazers-planning" ? "lazers-planning-comprehension" : agentID
        const { data } = await Effect.runPromise(
          ctx.agent.get({ agentID: Agent.ID.make(hostID) }),
          signal ? { signal } : undefined,
        )
        const ref = data.model
        const model: ModelPolicy | null = ref
          ? {
              providerID: String(ref.providerID),
              id: String(ref.id),
              ...(ref.variant !== undefined ? { variant: String(ref.variant) } : {}),
            }
          : null
        const pluginDefault =
          agentID === "auditor" &&
          model !== null &&
          model.providerID === AUDITOR_DEFAULT_MODEL.providerID &&
          model.id === AUDITOR_DEFAULT_MODEL.id
        return { agentID, fact: { reachable: true, model, pluginDefault } }
      } catch {
        return { agentID, fact: { reachable: false, model: null, pluginDefault: false } }
      }
    }),
  )
}

/**
 * The model native OpenCode resolves for each LAZERS agent: its own configuration, else (for the
 * Auditor) the plugin's default, else none; a LAZERS route names its layer (`agentRouteOf`).
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
  const facts = await readHostAgentFacts(ctx, signal)
  return facts.map(({ agentID, fact }) => agentRouteOf(agentID, fact, lazers(agentID)))
}
