import type { WorkerAgent } from "./worker-agent.ts"
import type { ModelPolicy } from "./schema.ts"
import type { OutcomeOwnership, OutcomeInboxEntry } from "./inbox.ts"
import type { PrivacyStats } from "../trajectory/privacy.ts"

export type RunnerHostMessage = {
  id: string
  text: string
  type?: string
  metadata?: Record<string, unknown>
}

export type ArchitectSourceResult = {
  state: "running" | "completed" | "failed"
  finish: "stop" | "length" | "tool-calls" | "content-filter" | "error" | "unknown" | null
  toolCounts: { running: number; completed: number; failed: number; other: number }
}

export type ArchitectSourceObservation = { updatedAt: number; inbox: string }
export type ArchitectInputPage = {
  inbox: Array<Pick<OutcomeInboxEntry, "id" | "type" | "delivery" | "metadata">>
  messages: Array<{
    id: string
    type: string
    metadata?: Record<string, unknown>
    result?: ArchitectSourceResult
  }>
  nextCursor: string | null
  observation?: ArchitectSourceObservation
  unchanged?: boolean
  archived?: boolean
}

export type ArchitectSourceMessage = {
  id: string
  type: "user" | "synthetic" | "assistant"
  text: string
  privacy: PrivacyStats
}

export type HostSession = {
  id: string
  parentID?: string
  projectID: string
  directory: string
  agent?: string
  metadata?: Record<string, unknown>
  archived: boolean
  /** Native `time.updated` of the session, when the host reports it. Moves with any change to it. */
  updatedAt?: number
  /** Current native foreground execution; absence is not a background-quiescence claim. */
  busy: boolean
  /**
   * `session.active()` listed this session but every other signal contradicts it
   * (completed newest turn, empty inbox, no approvals, shells or children). `busy`
   * is already false; the cause is for a one-time diagnostic.
   */
  staleActive?: { cause: string }
  /** A native inbox entry still awaits this worker. */
  pendingInput?: boolean
  /** Native permission/form requests remain open at this worker's assigned location. */
  pendingPermissions?: number
  pendingForms?: number
  /** Native execution observations changed during a detail read; retry before acting. */
  observationUnstable?: boolean
  /** Detail-read lineage for the most recent admitted native input. */
  turn?: {
    inputID: string | null
    state: "pending" | "completed" | "interrupted" | "unknown"
  }
  /**
   * Live background activity, read from the host at observation time. Running
   * shells have a cwd inside this worker's worktree; active children are
   * descendant sessions. Absent means none were observed.
   */
  runningShells?: number
  activeChildren?: number
  /**
   * Last time a running shell's output grew: the newest modification time of the output files
   * of this worker's running shells (their start when the file cannot be read). A shell that
   * keeps printing is alive; a silent one is not progress. Absent when no shell runs.
   */
  shellOutputAt?: number
  idleAt?: number
  /** Last model activity: assistant completion or request start. Preferred over `idleAt` for cache warmth. */
  activityAt?: number
  outcome?: "succeeded" | "failed" | "interrupted"
  model?: ModelPolicy
  usage?: {
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
    provenance: string
  }
  /**
   * Prompt size of the newest model request (input plus cache). Unlike `usage` and `tokens`,
   * which are cumulative spend, this is how full the session's context window is now.
   */
  contextTokens?: number
  tokens: number | null
  tools: number
  cost: number | null
  /**
   * The current turn when requested with `{ messages: true }`: the newest native input and every
   * message after it, oldest first. Earlier history is not read; use `RunnerHost.message` for
   * one older message.
   */
  messages: RunnerHostMessage[]
  /** Assistant messages in `messages` (detailed reads only). */
  turnAssistants?: number
}
export type WorkerInstruction = {
  sessionID: string
  attemptID: string
  projectID: string
  directory: string
  key: string
  text: string
}
export type WorktreeLocationRetirement =
  "evicted" | "not-loaded" | "active-session" | "current-location" | "unavailable"
/** All host uncertainty is an error. null means authoritative not-found only. */
export interface RunnerHost {
  /** Current native implementor-agent selection; never inferred from Architect identity. */
  workerModel?(agent?: WorkerAgent): Promise<ModelPolicy | undefined>
  /** Native adapters preserve only pinned typed creation failures; all other throws remain uncertain. */
  worktree(input: { directory: string; base: string }): Promise<string>
  worktrees(): Promise<string[]>
  removeWorktree(directory: string): Promise<void>
  /** Evict only a positively cleaned checkout with no active sessions; absence is a no-op. */
  retireWorktreeLocation?(directory: string): Promise<WorktreeLocationRetirement>
  /**
   * Session metadata is the normal heartbeat path. Request messages only for
   * explicit reconciliation or final accounting, where message history is
   * needed to prove a receipt or count completed tools.
   */
  session(id: string, options?: { messages?: boolean }): Promise<HostSession | null>
  /**
   * One message of a session by ID: a point read that does not depend on how much history the
   * session holds. Absent means the host has no such message. Older injected hosts without it
   * can still be asked through the current turn that `session(..., { messages: true })` returns.
   */
  message?(sessionID: string, messageID: string): Promise<RunnerHostMessage | undefined>
  /**
   * Text of the newest assistant message that precedes the current turn: one assistant-only
   * descending page, skipping the `skip` assistant messages the current turn already holds.
   */
  earlierAssistantText?(sessionID: string, skip: number): Promise<string | undefined>
  /** Public native inbox snapshot; the adapter verifies it belongs to this process. */
  outcomeInbox?(sessionID: string): Promise<OutcomeInboxEntry[]>
  /** One ordered page of original Architect inputs plus the current native inbox. */
  architectInputPage?(
    sessionID: string,
    cursor?: string,
    known?: ArchitectSourceObservation,
  ): Promise<ArchitectInputPage>
  /** Read one selected original message from an authenticated same-project Architect session. */
  architectSourceMessage?(sessionID: string, messageID: string): Promise<ArchitectSourceMessage>
  /** Revalidates ownership and queued state immediately before native cancellation. */
  cancelOutcome?(input: {
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
    planIDs?: string[]
    sourceSessionID: string
  }): Promise<void>
  /** Exact native session archive control; renewal requires this and input observation. */
  updateSession?(input: { sessionID: string; archived: boolean }): Promise<void>
  /** Waits for foreground completion only; callers must still inspect active/inbox controls. */
  waitForSession?(sessionID: string): Promise<void>
  /** Retire an already integrated worker after observing its current native inventory. */
  retireIntegratedWorker?(input: {
    projectID: string
    attemptID: string
    sessionID: string
    workspace: string
  }): Promise<void>
  prompt(input: {
    sessionID: string
    id: string
    text: string
    directory: string
    attemptID?: string
    model?: ModelPolicy
    moveIfNeeded?: boolean
  }): Promise<void>
  /** Durable keyed upsert/readback only; never prompts, moves or restarts a worker. */
  updateInstruction(input: WorkerInstruction): Promise<void>
  notify(input: {
    sessionID: string
    id: string
    text: string
    resume: boolean
    metadata?: OutcomeOwnership
  }): Promise<void>
  interrupt(id: string): Promise<void>
  /**
   * Steer one message into a running worker's current turn (consumed at its next step). Only the
   * attempt's own worker session; never resumes an idle worker.
   */
  steerWorker?(input: {
    sessionID: string
    attemptID: string
    directory: string
    id: string
    text: string
  }): Promise<void>
}
