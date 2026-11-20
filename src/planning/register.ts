import { Agent } from "@opencode/schema/agent"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { applyAgentRoute } from "../models/agent-route-apply.ts"
import type { AgentRouteReader } from "../models/agent-route-apply.ts"
import { PLANNING_AGENT_IDS } from "./contract.ts"
import type { PlanningAgentId } from "./contract.ts"
import { planningAgent } from "./index.ts"

/** The one route subject the five planning agents share (the Models panel's Assignments row). */
export const PLANNING_ROUTE_ID = "lazers-planning"

/** The host agent name of a planning agent, beside `lazers-implementor`. */
export const planningHostID = (id: PlanningAgentId) => `lazers-planning-${id}`

const LABELS: Record<PlanningAgentId, string> = {
  comprehension: "Planning: comprehension",
  grounding: "Planning: grounding",
  readiness: "Planning: readiness",
  critic: "Planning: critic",
  "zoom-out": "Planning: zoom out",
}

type Rule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }

/**
 * Read-only by construction. Everything is denied first (so a tool added later, `lz-*` included,
 * is denied by default), then read, grep and glob are allowed, then the dangerous families are
 * denied again by name so an allow granted by user configuration cannot reopen them.
 */
export const PLANNING_PERMISSIONS: readonly Rule[] = [
  { action: "*", resource: "*", effect: "deny" },
  ...["read", "grep", "glob"].map((action): Rule => ({ action, resource: "*", effect: "allow" })),
  // Secrets stay unreadable.
  { action: "read", resource: "*.env", effect: "deny" },
  { action: "read", resource: "*.env.*", effect: "deny" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  ...[
    "edit",
    "write",
    "patch",
    "bash",
    "shell",
    "webfetch",
    "websearch",
    "subagent",
    "task",
    "lz-*",
    "lz-research",
    "lz-submit-plan",
    "lz-plan-command",
    "lz-submit-task",
  ].map((action): Rule => ({ action, resource: "*", effect: "deny" })),
]

/**
 * Registers the five planning agents: hidden subagents with the composed prompt, read-only
 * permissions and the shared `lazers-planning` model route (else the Implementor's route, else
 * the native configuration). Nothing starts them yet; the runtime flow is separate work.
 */
export function registerPlanningAgents(
  ctx: Pick<Plugin.Context, "agent">,
  routes?: AgentRouteReader,
) {
  return ctx.agent
    .transform((editor) =>
      PLANNING_AGENT_IDS.forEach((id) =>
        editor.update(Agent.ID.make(planningHostID(id)), (agent) => {
          agent.name = Agent.Name.make(LABELS[id])
          agent.description = planningAgent(id).useWhen
          agent.mode = "subagent"
          agent.hidden = true
          agent.system = planningAgent(id).prompt
          const set = routes?.(PLANNING_ROUTE_ID) ?? routes?.("lazers-implementor")
          if (set) applyAgentRoute(agent, set.route)
          agent.permissions = PLANNING_PERMISSIONS.map((rule) => ({ ...rule }))
          delete agent.steps
        }),
      ),
    )
    .pipe(Effect.asVoid)
}
