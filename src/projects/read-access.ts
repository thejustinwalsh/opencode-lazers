import type { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import type { TaskRepository } from "../storage.ts"
import { projectUnits } from "./scope.ts"
import type { UnitAccess } from "./scope.ts"

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

/**
 * Everything a GUI all-projects read checks before it reads: the calling session exists, belongs to
 * this OpenCode project and has an agent (a guard against malformed calls). It asserts no
 * permission, so it never prompts: a read over the GUI RPC is the owner looking at their own
 * machine's projects, the same as opening each project's panel. Agent tools never reach this.
 */
export async function allProjectsAccess(
  ctx: Pick<Plugin.Context, "session">,
  input: {
    sessionID: string
    projectID: string
    repository: TaskRepository
    loaded: () => Iterable<string>
    unavailable: string
  },
): Promise<UnitAccess> {
  if (!(await callerSession(ctx, input.sessionID, input.projectID)))
    throw new Error(input.unavailable)
  return { units: projectUnits(input.repository, input.loaded) }
}
