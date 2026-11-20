import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import type { TaskRepository } from "../storage.ts"
import { canonicalPath, projectUnits } from "./scope.ts"
import type { ProjectUnit } from "./scope.ts"

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
 * The units of an all-projects read the caller may see: its own project (already asserted by the
 * caller's usual check) and every other project whose checkouts pass the same `read` assertion.
 * A refused project is dropped without a trace, so no page, cursor or error names it.
 */
export async function readableUnits(
  assertRead: (resources: string[]) => Promise<boolean>,
  units: readonly ProjectUnit[],
  ownDirectory: string,
): Promise<ProjectUnit[]> {
  const own = canonicalPath(ownDirectory)
  const paths = new Map<string, string[]>()
  for (const unit of units)
    paths.set(unit.project.key, [...(paths.get(unit.project.key) ?? []), unit.directory])
  const allowed = new Set<string>()
  for (const [key, checkouts] of paths) {
    if (checkouts.some((path) => canonicalPath(path) === own) || (await assertRead(checkouts)))
      allowed.add(key)
  }
  return units.filter((unit) => allowed.has(unit.project.key))
}

/** `permission.assert` as a yes or no for one session and the `read` action. */
export function readAssertion(ctx: AccessContext, session: { id: string; agent: string }) {
  return (resources: string[]) =>
    Effect.runPromise(
      ctx.permission.assert({
        sessionID: Session.ID.make(session.id),
        agent: Agent.ID.make(session.agent),
        action: "read",
        resources,
      }),
    ).then(
      () => true,
      () => false,
    )
}

/**
 * Everything an all-projects read checks before it reads: today's session checks, the caller's own
 * project asserted exactly as the project scope asserts it (a refusal fails the read), then the
 * readable subset of the other projects. `unavailable` is the message of the failed session check.
 */
export async function allowedUnitsFor(
  ctx: AccessContext,
  input: {
    sessionID: string
    projectID: string
    repository: TaskRepository
    loaded: () => Iterable<string>
    unavailable: string
  },
): Promise<ProjectUnit[]> {
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
  return readableUnits(
    readAssertion(ctx, session),
    projectUnits(input.repository, input.loaded),
    directory,
  )
}
