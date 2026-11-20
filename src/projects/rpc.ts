import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { timedRpc } from "../diagnostics/stall-probe.ts"
import type { TaskRepository } from "../storage.ts"
import { Projects } from "./contract.ts"
import type { ProjectScope, ProjectsListing, ProjectsOutcome } from "./contract.ts"
import { pauseRecords, setPause } from "./pause.ts"
import type { PauseScope } from "./pause.ts"
import { ProjectCodeError, projects, setProjectCode } from "./registry.ts"
import { isLoaded, liveDirectories } from "./scope.ts"
import { needsYouPage } from "./needs-you.ts"
import type { NeedsYouSession } from "./needs-you.ts"
import { allProjectsAccess } from "./read-access.ts"
import { globalSettings, projectSettings, setGlobalSetting, setProjectSetting } from "./settings.ts"
import type { GlobalSettings, ProjectSettings } from "./settings.ts"

export { Projects }

export type ProjectsDefaults = {
  global?: Partial<GlobalSettings>
  project?: Partial<ProjectSettings>
}
type Controls = TaskRepository

const refuse = (
  refusal: Extract<ProjectsOutcome, { ok: false }>["refusal"],
  message: string,
): ProjectsOutcome => ({ ok: false, refusal, message })
const OK: ProjectsOutcome = { ok: true }

/** Architect-contact pause, per checkout in the runner table; the project is paused when any is. */
function architectContactReason(repository: Pick<TaskRepository, "read">, paths: string[]) {
  return repository.read((db) => {
    for (const path of paths) {
      const row = db
        .query<{ reason: string }, [string]>(
          "SELECT reason FROM runner_architect_contact WHERE project_directory=? AND state='paused'",
        )
        .get(path)
      if (row) return { reason: row.reason }
    }
    return null
  })
}

/** Everything the Projects section shows, read fresh from the shared database. */
export function listProjects(
  repository: Controls,
  loaded: () => Iterable<string>,
  defaults: ProjectsDefaults = {},
): ProjectsListing {
  const live = liveDirectories(loaded)
  const pauses = pauseRecords(repository)
  const pauseOf = (scope: PauseScope) => {
    const record = pauses.find((candidate) =>
      scope.kind === "global"
        ? candidate.scope.kind === "global"
        : candidate.scope.kind === "project" && candidate.scope.key === scope.key,
    )
    return record ? { reason: record.reason, by: record.by, at: record.at } : null
  }
  return {
    projects: projects(repository).map((project) => ({
      key: project.key,
      code: project.code,
      name: project.name,
      checkouts: project.paths,
      loaded: isLoaded(project.paths, live),
      pause: pauseOf({ kind: "project", key: project.key }),
      architectContact: architectContactReason(repository, project.paths),
      settings: projectSettings(repository, project.key, defaults.project),
    })),
    globalPause: pauseOf({ kind: "global" }),
    globalSettings: globalSettings(repository, defaults.global),
  }
}

const projectExists = (repository: Controls, key: string) =>
  projects(repository).some((project) => project.key === key)

function guarded(repository: Controls, scope: ProjectScope, act: () => void): ProjectsOutcome {
  if (scope.kind === "project" && !projectExists(repository, scope.key))
    return refuse("PROJECT_MISSING", "That project is not registered.")
  try {
    act()
    return OK
  } catch (error) {
    return refuse("SETTING_INVALID", error instanceof Error ? error.message : String(error))
  }
}

/** The operations behind `lz.projects`; separate from registration so tests call them directly. */
export function projectsOperations(
  repository: Controls,
  options: {
    loaded: () => Iterable<string>
    defaults?: ProjectsDefaults
    /** Runs after an unpause so a held project dispatches on the next tick. */
    wake?: () => void
  },
) {
  return {
    list: () => listProjects(repository, options.loaded, options.defaults),
    setCode(key: string, code: string): ProjectsOutcome {
      if (!projectExists(repository, key))
        return refuse("PROJECT_MISSING", "That project is not registered.")
      try {
        setProjectCode(repository, key, code)
        return OK
      } catch (error) {
        if (error instanceof ProjectCodeError)
          return refuse(
            error.code,
            error.code === "PROJECT_CODE_TAKEN"
              ? "Another project already uses that code."
              : "Use 2 to 4 capital letters, optionally followed by digits.",
          )
        throw error
      }
    },
    setPause(scope: ProjectScope, paused: boolean, reason: string): ProjectsOutcome {
      const outcome = guarded(repository, scope, () =>
        setPause(repository, scope, { paused, reason: reason.trim(), by: "owner" }),
      )
      if (outcome.ok && !paused) options.wake?.()
      return outcome
    },
    setSetting(scope: ProjectScope, name: string, value: number | null): ProjectsOutcome {
      const stored = value === null ? undefined : value
      return guarded(repository, scope, () =>
        scope.kind === "global"
          ? setGlobalSetting(repository, name as keyof GlobalSettings, stored as never)
          : setProjectSetting(
              repository,
              scope.key,
              name as keyof ProjectSettings,
              stored as never,
            ),
      )
    },
  }
}

export function registerProjects(
  ctx: Pick<Plugin.Context, "rpc" | "permission" | "session">,
  repository: Controls,
  options: Parameters<typeof projectsOperations>[1] & {
    /** This location's OpenCode project id, for the caller's session check. */
    projectID: string
    /** Reads a session of this location's project; native questions come only from these. */
    sessionOf?: (sessionID: string) => Promise<NeedsYouSession | null>
  },
) {
  const operations = projectsOperations(repository, options)
  return timedRpc(ctx.rpc).register(Projects, {
    needsYou: (input) =>
      Effect.tryPromise({
        try: async () => {
          const access = await allProjectsAccess(ctx, {
            sessionID: input.sessionID,
            projectID: options.projectID,
            repository,
            loaded: options.loaded,
            unavailable: "Needs you scope is unavailable",
          })
          const page = await needsYouPage({
            repository,
            units: access.units,
            canRead: access.canRead,
            ownDirectory: repository.projectDirectory,
            ...(input.cursor ? { cursor: input.cursor } : {}),
            ...(options.sessionOf ? { sessionOf: options.sessionOf } : {}),
          })
          return page ?? { items: [], nextCursor: null }
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(Effect.orDie),
    list: () => Effect.sync(() => operations.list()),
    setCode: (input) => Effect.sync(() => operations.setCode(input.key, input.code)),
    setPause: (input) =>
      Effect.sync(() => operations.setPause(input.scope, input.paused, input.reason ?? "")),
    setSetting: (input) =>
      Effect.sync(() => operations.setSetting(input.scope, input.name, input.value)),
  })
}
