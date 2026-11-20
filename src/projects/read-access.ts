import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import type { TaskRepository } from "../storage.ts"
import { canonicalPath, projectUnits } from "./scope.ts"
import type { CanRead, ProjectUnit } from "./scope.ts"

type AccessContext = Pick<Plugin.Context, "permission" | "session">

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
 * A lazy gate over the other projects: the caller's own project is always readable (its usual
 * assertion has already run); any other project is asked once per call, on its first page, with
 * the same `read` assertion on its checkouts. `permission.assert` may prompt the owner when a rule
 * says to ask, so a project is asked only when a page of it is about to be read, never up front.
 * A refused project is skipped without a trace.
 */
export function lazyGate(
  assertRead: (resources: string[]) => Promise<boolean>,
  units: readonly ProjectUnit[],
  ownDirectory: string,
): CanRead {
  const own = canonicalPath(ownDirectory)
  const answers = new Map<string, Promise<boolean>>()
  return (unit) => {
    const checkouts = units
      .filter((candidate) => candidate.project.key === unit.project.key)
      .map((candidate) => candidate.directory)
    if (checkouts.some((path) => canonicalPath(path) === own)) return Promise.resolve(true)
    let answer = answers.get(unit.project.key)
    if (!answer) answers.set(unit.project.key, (answer = assertRead(checkouts)))
    return answer
  }
}

/** `permission.assert` as a yes or no for one session and the `read` action. */
export function readAssertion(
  ctx: Pick<Plugin.Context, "permission">,
  session: { id: string; agent: string },
  action = "read",
) {
  return (resources: string[]) =>
    Effect.runPromise(
      ctx.permission.assert({
        sessionID: Session.ID.make(session.id),
        agent: Agent.ID.make(session.agent),
        action,
        resources,
      }),
    ).then(
      () => true,
      () => false,
    )
}

export type UnitAccess = { units: ProjectUnit[]; canRead: CanRead }

/**
 * Everything an all-projects read checks before it reads: today's session checks, the caller's own
 * project asserted exactly as the project scope asserts it (a refusal fails the read), then a lazy
 * gate over the other projects. `unavailable` is the message of the failed session check.
 */
export async function allProjectsAccess(
  ctx: AccessContext,
  input: {
    sessionID: string
    projectID: string
    repository: TaskRepository
    loaded: () => Iterable<string>
    unavailable: string
  },
): Promise<UnitAccess> {
  const session = await callerSession(ctx, input.sessionID, input.projectID)
  if (!session) throw new Error(input.unavailable)
  const directory = input.repository.projectDirectory
  await Effect.runPromise(
    ctx.permission.assert({
      sessionID: Session.ID.make(session.id),
      agent: Agent.ID.make(session.agent),
      action: "read",
      resources: [directory],
    }),
  )
  const units = projectUnits(input.repository, input.loaded)
  return { units, canRead: lazyGate(readAssertion(ctx, session), units, directory) }
}
