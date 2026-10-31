import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Effect } from "effect"

/** Read-only native catalog context for an Architect's user-guided route choice. */
export async function nativeWorkerOptions(
  ctx: Pick<Plugin.Context, "agent" | "location" | "model">,
) {
  const [{ data: models }, { data: worker }] = await Promise.all([
    Effect.runPromise(ctx.model.list({ location: { directory: ctx.location.directory } })),
    Effect.runPromise(ctx.agent.get({ agentID: Agent.ID.make("lazers-implementor") })),
  ])

  const selected = worker.model
  return {
    source: "Live native OpenCode model catalog",
    observedAt: new Date().toISOString(),
    advisoryOnly: true,
    note: "Catalog metadata informs advice only. Native OpenCode governs route availability; an explicit user selection is not rejected or substituted by LAZERS.",
    configuredImplementor: selected
      ? {
          providerID: selected.providerID,
          id: selected.id,
          ...(selected.variant !== undefined ? { variant: selected.variant } : {}),
        }
      : null,
    options: models.map((model) => ({
      providerID: model.providerID,
      id: model.id,
      name: model.name,
      enabled: typeof model.enabled === "boolean" ? model.enabled : null,
      type: model.type ?? null,
      capabilities: {
        tools: typeof model.capabilities?.tools === "boolean" ? model.capabilities.tools : null,
        input: Array.isArray(model.capabilities?.input) ? [...model.capabilities.input] : null,
        output: Array.isArray(model.capabilities?.output) ? [...model.capabilities.output] : null,
      },
      contextTokens: typeof model.limit?.context === "number" ? model.limit.context : null,
      pricesUSDPerMillionTokens: model.cost?.length
        ? model.cost.map((price) => ({
            contextTierTokens: price.tier?.size ?? null,
            input: price.input,
            output: price.output,
            cacheRead: price.cache.read,
            cacheWrite: price.cache.write,
          }))
        : null,
      variants: Array.isArray(model.variants) ? model.variants.map((variant) => variant.id) : [],
    })),
  }
}
