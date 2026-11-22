import type { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"

const isNotFound = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "SessionNotFoundError"

/** The calling session, when it exists, belongs to this OpenCode project and has an agent. */
export async function callerSession(
  ctx: Pick<Plugin.Context, "session">,
  sessionID: string,
  projectID: string,
) {
  const session = await Effect.runPromise(
    ctx.session
      .get({ sessionID: Session.ID.make(sessionID) })
      .pipe(
        Effect.catch((error) => (isNotFound(error) ? Effect.succeed(null) : Effect.fail(error))),
      ),
  )
  if (!session || session.id !== sessionID || session.projectID !== projectID || !session.agent)
    return undefined
  return { id: session.id, agent: session.agent }
}
