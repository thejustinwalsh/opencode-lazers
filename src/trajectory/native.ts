import type { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { DateTime, Effect } from "effect"
import { privacyStats, safeError } from "./privacy.ts"

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
  messageStatus: "available" | "unavailable"
  messageError: string | null
}

export interface TrajectoryHost {
  /** Called only with an ID obtained from an owned runner_attempt row. */
  session(id: string): Promise<TrajectorySession | null>
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
): TrajectoryHost {
  return {
    async session(id) {
      const session = await Effect.runPromise(
        ctx.session
          .get({ sessionID: Session.ID.make(id) })
          .pipe(
            Effect.catch((error) => (notFound(error) ? Effect.succeed(null) : Effect.fail(error))),
          ),
      )
      if (!session) return null
      if (session.id !== id || session.projectID !== projectID) throw new TrajectoryIdentityError()

      let messages: ReadonlyArray<SessionMessage.Info> | null = null
      let messageStatus: TrajectorySession["messageStatus"] = "available"
      let messageError: string | null = null
      try {
        messages = await Effect.runPromise(ctx.session.context({ sessionID: session.id }))
      } catch (error) {
        messageStatus = "unavailable"
        messageError = safeError(error, privacyStats())
      }

      const busy = session.time.busy ? DateTime.toEpochMillis(session.time.busy) : null
      const idle = session.time.idle ? DateTime.toEpochMillis(session.time.idle) : null
      const tokens = session.tokens
      return {
        id: session.id,
        projectID: session.projectID,
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
    },
  }
}
