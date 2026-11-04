import type { ModelPolicy } from "./schema.ts"
import type { OutcomeOwnership, OutcomeInboxEntry } from "./inbox.ts"

export type HostMessage = {
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

export type ArchitectInputPage = {
  inbox: Array<Pick<OutcomeInboxEntry, "id" | "type" | "delivery" | "metadata">>
  messages: Array<{
    id: string
    type: string
    metadata?: Record<string, unknown>
    result?: ArchitectSourceResult
  }>
  nextCursor: string | null
}

export type HostBackgroundObservation =
  | {
      state: "observed"
      source: "experimental.idle"
      observedAt: number
      /** Current user/synthetic input reported by session context at the idle hook. */
      inputID: string
      /** Durable event epoch associated with the current foreground execution. */
      executionStartSequence: number
      /** Latest durable event sequence observed when the idle hook ran. */
      eventSequence: number
      /** Durable sequence of the matching native execution-success event. */
      terminalSequence?: number
      /** Native event that produced the terminal idle marker. */
      terminalEventID?: string
      /** Pinned SessionMessage.ID.fromEvent marker; distinct from the assistant response ID. */
      terminalMessageID?: string
      projectDirectory?: string
      projectID?: string
      attemptID?: string
      sessionID?: string
      workspace?: string
      assignedMessageID?: string
      /** Most recent older durable event ignored without overwriting this report. */
      staleEventSequence?: number
      count: number
      kinds: { shell: number; subagent: number; image: number }
    }
  | {
      state: "unknown"
      source: "experimental.idle"
      reason: string
      observedAt?: number
    }

export type HostSession = {
  id: string
  parentID?: string
  projectID: string
  directory: string
  agent?: string
  metadata?: Record<string, unknown>
  archived: boolean
  /** Current native foreground execution; absence is not a background-quiescence claim. */
  busy: boolean
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
  /** Reported idle-hook background work only; never a complete quiescence inventory. */
  background?: HostBackgroundObservation
  idleAt?: number
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
  tokens: number | null
  tools: number
  cost: number | null
  messages: HostMessage[]
}
export type WorkerInstruction = {
  sessionID: string
  attemptID: string
  projectID: string
  directory: string
  key: string
  text: string
}
export type RetainedWorkerArchive = {
  sessionID: string
  attemptID: string
  planID: string
  requestID: string
  projectID: string
  directory: string
  assignedMessageID: string
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
  outcomeInbox?(sessionID: string): Promise<OutcomeInboxEntry[]>
  /** One ordered page of original Architect inputs plus the current native inbox. */
  architectInputPage?(sessionID: string, cursor?: string): Promise<ArchitectInputPage>
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
  /** Archive only the stopped worker bound to a durable pending source quarantine. */
  archiveRetainedWorker?(input: RetainedWorkerArchive): Promise<void>
  prompt(input: { sessionID: string; id: string; text: string; directory: string }): Promise<void>
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
}
