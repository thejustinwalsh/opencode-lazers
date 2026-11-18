import { Model } from "@opencode/schema/model"
import { Schema } from "effect"
import type { ModelPolicy } from "../runner/schema.ts"
import type { TaskRepository } from "../storage.ts"
import { ModelMappingStore } from "./mapping-store.ts"

export type AgentRouteSetting = {
  route: ModelPolicy
  scope: "project" | "shared"
  revision: number
}

/** Where an agent's LAZERS route is read from: this project's, else the shared one. */
export type AgentRouteReader = (agentID: string) => AgentRouteSetting | null

/**
 * A reader over the plugin database. It never throws: a transform runs while the host builds
 * its agents, and an unreadable setting must leave the native configuration in force.
 */
export function agentRouteReader(repository: Pick<TaskRepository, "atomic" | "projectDirectory">) {
  const store = new ModelMappingStore(repository as TaskRepository)
  const read: AgentRouteReader = (agentID) => {
    try {
      return store.agentRoute(agentID)
    } catch {
      return null
    }
  }
  return read
}

/**
 * Set an agent's model, and with it the effort the native schema calls `variant`, to a LAZERS
 * route. OpenCode then starts every session of that agent on it; a model the user picks by hand
 * in the composer for a session they start themselves still wins for that session.
 */
export function applyAgentRoute(agent: { model?: unknown }, route: ModelPolicy) {
  agent.model = Schema.decodeUnknownSync(Model.Ref)({
    providerID: route.providerID,
    id: route.id,
    ...(route.variant ? { variant: route.variant } : {}),
  })
}

/**
 * The model of an Architect session LAZERS creates: the configured Architect route (this
 * project's, else the shared one) when set, else the model carried from the previous session.
 */
export function architectSessionModel(
  configured: AgentRouteSetting | null,
  carried: ModelPolicy | undefined,
): ModelPolicy | undefined {
  return configured?.route ?? carried
}
