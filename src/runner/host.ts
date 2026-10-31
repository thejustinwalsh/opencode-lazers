import type { ModelPolicy } from "./schema.ts"
import type { OutcomeOwnership, OutcomeInboxEntry } from "./inbox.ts"

export type HostMessage = {
  id: string
  text: string
  type?: string
  metadata?: Record<string, unknown>
}

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
  messages: HostMessage[]
}
/** All host uncertainty is an error. null means authoritative not-found only. */
export interface RunnerHost {
  /** Current native implementor-agent selection; never inferred from Architect identity. */
  workerModel?(): Promise<ModelPolicy | undefined>
  worktree(input: { directory: string; base: string }): Promise<string>
  worktrees(): Promise<string[]>
  removeWorktree(directory: string): Promise<void>
  /**
   * Session metadata is the normal heartbeat path. Request messages only for
   * explicit reconciliation or final accounting, where message history is
   * needed to prove a receipt or count completed tools.
   */
  session(id: string, options?: { messages?: boolean }): Promise<HostSession | null>
  /** Public native inbox snapshot; the adapter verifies it belongs to this process. */
  outcomeInbox(sessionID: string): Promise<OutcomeInboxEntry[]>
  /** Revalidates ownership and queued state immediately before native cancellation. */
  cancelOutcome(input: {
    sessionID: string
    inboxID: string
    ownership: OutcomeOwnership
  }): Promise<void>
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
  notify(input: {
    sessionID: string
    id: string
    text: string
    resume: boolean
    metadata?: OutcomeOwnership
  }): Promise<void>
  interrupt(id: string): Promise<void>
}
