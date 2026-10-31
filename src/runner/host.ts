import type { ModelPolicy } from "./schema.ts"

export type HostSession = {
  id: string
  parentID?: string
  projectID: string
  directory: string
  agent?: string
  metadata?: Record<string, unknown>
  archived: boolean
  busy: boolean
  outcome?: "succeeded" | "failed" | "interrupted"
  model?: ModelPolicy
  tokens: number | null
  tools: number
  cost: number | null
  messages: { id: string; text: string }[]
}
/** All host uncertainty is an error. null means authoritative not-found only. */
export interface RunnerHost {
  /** Current native implementor-agent selection; never inferred from Architect identity. */
  workerModel?(): Promise<ModelPolicy | undefined>
  worktree(input: { directory: string; base: string }): Promise<string>
  worktrees(): Promise<string[]>
  removeWorktree(directory: string): Promise<void>
  session(id: string): Promise<HostSession | null>
  create(input: {
    id: string
    parentID: string
    agent: string
    model: ModelPolicy
    directory: string
    title: string
    attemptID: string
  }): Promise<void>
  createArchitect(input: {
    id: string
    parentID?: string
    directory: string
    model?: ModelPolicy
    title: string
    planID: string
    sourceSessionID: string
  }): Promise<void>
  prompt(input: { sessionID: string; id: string; text: string; directory: string }): Promise<void>
  notify(input: { sessionID: string; id: string; text: string; resume: boolean }): Promise<void>
  interrupt(id: string): Promise<void>
}
