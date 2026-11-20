import { eachMessagePage, type HostMessageClient } from "../core/host-messages.ts"
import type { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { DateTime, Effect } from "effect"
import { isWorkerAgent } from "../runner/worker-agent.ts"
import { privacyStats, safeError } from "./privacy.ts"

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

const notFound = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "SessionNotFoundError"

export function nativeTrajectoryHost(
  ctx: Pick<Plugin.Context, "session">,
  projectID: string,
  /** Recorded attempt workspace belongs to this project; never boots the worktree's location. */
  ownsRecordedWorkspace: ((directory: string) => boolean) | undefined,
  hostMessages: HostMessageClient,
): TrajectoryHost {
  async function loadSession(
    id: string,
    includeContext: boolean,
    attempt?: OwnedAttempt,
    sink?: MessageSink,
  ) {
    const session = await Effect.runPromise(
      ctx.session
        .get({ sessionID: Session.ID.make(id) })
        .pipe(
          Effect.catch((error) => (notFound(error) ? Effect.succeed(null) : Effect.fail(error))),
        ),
    )
    if (!session) return null
    if (session.id !== id) throw new TrajectoryIdentityError()
    if (
      session.projectID !== projectID &&
      (!attempt ||
        !isWorkerAgent(session.agent) ||
        session.metadata?.lazersAttemptID !== attempt.id ||
        session.location.directory !== attempt.workspace ||
        !ownsRecordedWorkspace?.(attempt.workspace))
    )
      throw new TrajectoryIdentityError()

    let messages: ReadonlyArray<SessionMessage.Info> | null = null
    let messageStatus: TrajectorySession["messageStatus"] = includeContext
      ? "available"
      : "not-read"
    let messageError: string | null = null
    if (includeContext) {
      // A report, not a model prompt: the transcript is paged in, never read whole. A sink's own
      // failure is the caller's to see, not a host read failure.
      const collected: SessionMessage.Info[] = []
      let sinkError: { error: unknown } | undefined
      try {
        await eachMessagePage(hostMessages, session.id, MAX_CONTEXT_MESSAGES + 1, (page) => {
          const typed = page as unknown as ReadonlyArray<SessionMessage.Info>
          if (!sink) collected.push(...typed)
          else if (!sinkError)
            try {
              sink(typed)
            } catch (error) {
              sinkError = { error }
            }
        })
        if (!sink) messages = collected
      } catch (error) {
        messageStatus = "unavailable"
        messageError = safeError(error, privacyStats())
      }
      if (sinkError) throw sinkError.error
    }

    const busy = session.time.busy ? DateTime.toEpochMillis(session.time.busy) : null
    const idle = session.time.idle ? DateTime.toEpochMillis(session.time.idle) : null
    const tokens = session.tokens
    return {
      id: session.id,
      projectID,
      parentID: session.parentID ?? null,
      model: session.model
        ? {
            providerID: session.model.providerID,
            id: session.model.id,
            ...(session.model.variant ? { variant: session.model.variant } : {}),
          }
        : null,
      outcome: session.outcome ?? null,
      busy: busy !== null && (idle === null || busy > idle),
      time: {
        created: DateTime.toEpochMillis(session.time.created),
        updated: DateTime.toEpochMillis(session.time.updated),
        busy,
        idle,
      },
      tokens: tokens
        ? {
            input: tokens.input,
            output: tokens.output,
            reasoning: tokens.reasoning,
            cache: { read: tokens.cache.read, write: tokens.cache.write },
          }
        : null,
      messages,
      messageStatus,
      messageError,
    }
  }
  return {
    session: (id, attempt, sink) => loadSession(id, true, attempt, sink),
    status: (id, attempt) => loadSession(id, false, attempt),
  }
}
