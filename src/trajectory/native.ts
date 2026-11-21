import { SessionMessage } from "@opencode/schema/session-message"

/** The transcript bound of one report; a longer history is read to one past it so it can be flagged. */
export const MAX_CONTEXT_MESSAGES = 10_000

export type UsageSnapshot = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export type TrajectorySession = {
  id: string
  projectID: string
  parentID: string | null
  model: { providerID: string; id: string; variant?: string } | null
  outcome: "succeeded" | "failed" | "interrupted" | null
  busy: boolean
  time: { created: number; updated: number; busy: number | null; idle: number | null }
  tokens: UsageSnapshot | null
  messages: ReadonlyArray<SessionMessage.Info> | null
  messageStatus: "available" | "unavailable" | "not-read"
  messageError: string | null
}

type OwnedAttempt = { id: string; workspace: string }

/** Receives the transcript one page at a time, oldest first; the host keeps no page it has passed. */
export type MessageSink = (page: ReadonlyArray<SessionMessage.Info>) => void

export interface TrajectoryHost {
  /**
   * Called only with an ID obtained from an owned runner_attempt row. With a `sink` the transcript
   * is handed to it page by page and the returned session carries `messages: null`: no more than
   * one page is ever held. Without one the pages are collected into `messages`.
   */
  session(id: string, attempt?: OwnedAttempt, sink?: MessageSink): Promise<TrajectorySession | null>
  /** Reads live session metadata without loading transcript context. */
  status?(id: string, attempt?: OwnedAttempt): Promise<TrajectorySession | null>
}

export class TrajectoryIdentityError extends Error {
  constructor() {
    super("Owned worker session identity is outside this project")
  }
}
