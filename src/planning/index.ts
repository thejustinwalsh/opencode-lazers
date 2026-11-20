import comprehension from "./agents/comprehension.md" with { type: "text" }
import critic from "./agents/critic.md" with { type: "text" }
import grounding from "./agents/grounding.md" with { type: "text" }
import readiness from "./agents/readiness.md" with { type: "text" }
import zoomOut from "./agents/zoom-out.md" with { type: "text" }
import shared from "./shared.md" with { type: "text" }
import type { PlanningAgentId } from "./contract.ts"

export type PlanningAgent = {
  id: PlanningAgentId
  /** One sentence the decision model ranks against; concrete triggers, no overlap with another agent. */
  useWhen: string
  /** The agent's own text, then the shared setup, working-room, evidence and output sections. */
  prompt: string
}

const agent = (id: PlanningAgentId, useWhen: string, own: string): PlanningAgent => ({
  id,
  useWhen,
  prompt: `${own.trim()}\n\n${shared.trim()}\n`,
})

/** The fixed list of planning agents, in the order the Architect runs them. */
export const planningAgents: readonly PlanningAgent[] = [
  agent(
    "comprehension",
    "The plan is long, new to the project, or uses many project-specific terms, so a reader could misread what to build.",
    comprehension,
  ),
  agent(
    "grounding",
    "The plan names existing files, functions, types, commands or tables, or changes code that other code calls.",
    grounding,
  ),
  agent(
    "readiness",
    "The plan has acceptance checks or verification commands, or leaves behaviour like data shapes, defaults and error cases to the builder.",
    readiness,
  ),
  agent(
    "critic",
    "The plan touches stored data, migrations, security, model cost, external services or running processes, or depends on stated assumptions.",
    critic,
  ),
  agent(
    "zoom-out",
    "The plan adds new modules, tools, tables or settings, or fixes a visible problem and may not address its cause.",
    zoomOut,
  ),
]

export const sharedPrompt = shared

export function planningAgent(id: PlanningAgentId): PlanningAgent {
  const found = planningAgents.find((entry) => entry.id === id)
  if (!found) throw new Error(`Unknown planning agent: ${id}`)
  return found
}
