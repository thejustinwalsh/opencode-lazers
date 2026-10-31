import type { ModelPolicy } from "./schema.ts"
import type { TaskProposal } from "../task.ts"

export type HostSession = {
  id: string
  parentID?: string
  projectID: string
  directory: string
  archived: boolean
  busy: boolean
  outcome?: "succeeded" | "failed" | "interrupted"
  model?: ModelPolicy
  tokens: number | null
  tools: number
  cost: number | null
  messages: { id: string; text: string }[]
}
export type SkillSource = { id: string; path: string; content: string; revision: string }
/** All host uncertainty is an error. null means authoritative not-found only. */
export interface RunnerHost {
  worktree(input: { directory: string; base: string }): Promise<string>
  worktrees(): Promise<string[]>
  session(id: string): Promise<HostSession | null>
  skills(sessionID: string, ids: string[]): Promise<SkillSource[]>
  assemble(input: {
    sessionID: string
    directory: string
    proposal: TaskProposal
    skills: SkillSource[]
    source: string
  }): Promise<{ text: string; metadata: unknown }>
  create(input: {
    id: string
    parentID: string
    agent: string
    model: ModelPolicy
    directory: string
    title: string
    attemptID: string
  }): Promise<void>
  prompt(input: { sessionID: string; id: string; text: string }): Promise<void>
  notify(input: { sessionID: string; id: string; text: string; resume: boolean }): Promise<void>
  interrupt(id: string): Promise<void>
}
