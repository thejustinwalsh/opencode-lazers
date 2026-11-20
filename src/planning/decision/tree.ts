import type { SystemOneQuestion } from "../../webgpu/system-one.ts"
import type { PlanningAgentId } from "../contract.ts"
import { planningAgents } from "../index.ts"

/** The agents in run order, from their definitions. */
export const AGENT_ORDER: readonly PlanningAgentId[] = planningAgents.map((entry) => entry.id)

export const SIZE_CHOICES = ["one task", "a few tasks", "a large effort"] as const
export type SizePick = (typeof SIZE_CHOICES)[number]

export const SIZE_INSTRUCTIONS = "How large is the work this text asks for?"
export const SIZE_CRITERIA: Record<SizePick, string> = {
  "one task": "one small change a single worker can finish",
  "a few tasks": "a few separate changes that depend on each other",
  "a large effort": "a large effort that needs several steps planned in order",
}

/** The one-line "use when" of an agent: the single definition the decider and the note share. */
export function useWhen(agent: PlanningAgentId): string {
  return planningAgents.find((entry) => entry.id === agent)!.useWhen
}

/** The size question as the decision model sees it. */
export function sizeQuestion(): SystemOneQuestion {
  return { type: "choice", instructions: SIZE_INSTRUCTIONS, criteria: { ...SIZE_CRITERIA } }
}

export const AGENT_INSTRUCTIONS = "Does this planning agent apply to the plan?"

/** Default per-agent form: one yes/no question per agent. */
export function agentQuestion(agent: PlanningAgentId): SystemOneQuestion {
  return {
    type: "noul",
    instructions: `${AGENT_INSTRUCTIONS} Use when: ${useWhen(agent)}`,
    criteria: { true: "yes, it applies", false: "no, it does not apply" },
  }
}

/** The 5-way form, kept for the replay script. */
export function agentChoiceQuestion(): SystemOneQuestion {
  return {
    type: "choice",
    instructions: "Which planning agent applies most to this text?",
    criteria: Object.fromEntries(AGENT_ORDER.map((id) => [id, useWhen(id)])),
  }
}

export type FollowUp = {
  id: string
  parent: { question: "size"; answer: SizePick }
  question: SystemOneQuestion
  effect: { kind: "floor-agent"; agent: PlanningAgentId; when: "yes" }
}

/** The follow-up table: data only. "yes" means the answer is at least 0.7, as `adaptDecision` reads it. */
export const FOLLOW_UPS: readonly FollowUp[] = [
  {
    id: "stored-data",
    parent: { question: "size", answer: "a large effort" },
    question: {
      type: "noul",
      instructions:
        "Does this text change stored data: a database table, a migration, a file format or saved settings?",
      criteria: { true: "yes, stored data changes", false: "no stored data changes" },
    },
    effect: { kind: "floor-agent", agent: "critic", when: "yes" },
  },
  {
    id: "existing-code",
    parent: { question: "size", answer: "a few tasks" },
    question: {
      type: "noul",
      instructions: "Does this text name existing files, functions, commands or tables?",
      criteria: { true: "yes, it names existing code", false: "no" },
    },
    effect: { kind: "floor-agent", agent: "grounding", when: "yes" },
  },
]
export const FOLLOW_UP_YES = 0.7
