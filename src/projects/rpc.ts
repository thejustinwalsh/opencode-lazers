import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { timedRpc } from "../diagnostics/stall-probe.ts"
import type { TaskRepository } from "../storage.ts"
import { Projects } from "./contract.ts"
import type {
  ProfileOutcomeView,
  ProfileRevisionView,
  ProfileView,
  ProjectScope,
  ProjectsListing,
  ProjectsOutcome,
} from "./contract.ts"
import { pauseRecords, setPause } from "./pause.ts"
import type { PauseScope } from "./pause.ts"
import { ProjectCodeError, projects, setProjectCode } from "./registry.ts"
import { isLoaded, liveDirectories } from "./scope.ts"
import { needsYouPage } from "./needs-you.ts"
import type { NeedsYouSession } from "./needs-you.ts"
import { allProjectsAccess } from "./read-access.ts"
import {
  globalSettings,
  projectKeyOfDirectory,
  projectSettings,
  setGlobalSetting,
  setProjectSetting,
} from "./settings.ts"
import { repoMapSource } from "../context/repo-map-store.ts"
import { credentialLikeEnv, parseProfile, profileDiff } from "./profile.ts"
import { proveProfile } from "./profile-proof.ts"
import type { ProofWorkspace } from "./profile-proof.ts"
import {
  activeProfileForKey,
  confirmRevision,
  discardRevision,
  pendingRevision,
  ProfileStoreError,
  profileRevisions,
  proposeRevision,
} from "./profile-store.ts"
import type { ProfileRevisionRow } from "./profile-store.ts"
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

function profileState(repository: Controls, key: string) {
  const active = activeProfileForKey(repository, key)
  const pending = pendingRevision(repository, key)
  return {
    state: pending ? ("pending" as const) : active ? ("active" as const) : ("none" as const),
    ...(active ? { revision: active.revision } : {}),
    ...(pending ? { pendingRevision: pending.revision } : {}),
  }
}

const revisionView = (row: ProfileRevisionRow): ProfileRevisionView => ({
  revision: row.revision,
  state: row.state,
  profile: row.profile,
  author:
    row.author.kind === "architect"
      ? { kind: "architect", sessionID: row.author.sessionID }
      : { kind: "owner" },
  reason: row.reason,
  createdAt: row.createdAt,
  ...(row.decidedAt === undefined ? {} : { decidedAt: row.decidedAt }),
  proofs: row.proofs,
  ...(row.mapPreview ? { mapPreview: row.mapPreview } : {}),
  credentialLikeEnv: row.profile.env.filter(credentialLikeEnv),
})

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
      profile: profileState(repository, project.key),
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
    /** Where proofs run: the native worktree adapter of this location. */
    proofWorkspace?: ProofWorkspace
    /** Receipts of proof runs are written under this directory. */
    dataDirectory?: string
  },
) {
  const proposalRefusal = (message: string): ProfileOutcomeView => ({
    ok: false,
    refusal: "PROJECT_NOT_LOADED",
    message,
  })
  const decide = (
    key: string,
    revision: number,
    act: typeof confirmRevision | typeof discardRevision,
  ): ProjectsOutcome => {
    if (!projectExists(repository, key))
      return refuse("PROJECT_MISSING", "That project is not registered.")
    try {
      act(repository, { projectKey: key, revision, by: "owner" })
      return OK
    } catch (error) {
      if (error instanceof ProfileStoreError)
        return refuse(
          error.code === "PROFILE_INVALID" ? "PROFILE_INVALID" : "PROFILE_REVISION_NOT_PENDING",
          error.message,
        )
      throw error
    }
  }
  return {
    profile(key: string): ProfileView {
      const revisions = profileRevisions(repository, key)
      const active = activeProfileForKey(repository, key)
      const activeRow = active ? revisions.find((row) => row.id === active.revisionID) : undefined
      const pendingRow = pendingRevision(repository, key)
      const legacy = projects(repository)
        .find((project) => project.key === key)
        ?.paths.map((path) => repoMapSource(repository, path))
        .find(Boolean)
      return {
        key,
        ...(activeRow ? { active: revisionView(activeRow) } : {}),
        ...(pendingRow
          ? {
              pending: {
                ...revisionView(pendingRow),
                changes: profileDiff(activeRow?.profile, pendingRow.profile),
              },
            }
          : {}),
        ...(legacy ? { legacySource: { include: legacy.include, exclude: legacy.exclude } } : {}),
        setupDismissedAt: projectSettings(repository, key).setupDismissedAt,
      }
    },
    async proposeProfile(input: {
      key: string
      profile: unknown
      reason: string
      proofTargets?: Record<string, string[]>
    }): Promise<ProfileOutcomeView> {
      if (!projectExists(repository, input.key))
        return { ok: false, refusal: "PROJECT_MISSING", message: "That project is not registered." }
      if (projectKeyOfDirectory(repository, repository.projectDirectory) !== input.key)
        return proposalRefusal(
          "Proving a profile needs this project's own checkout; open the project to set it up.",
        )
      if (!options.proofWorkspace || !options.dataDirectory)
        return proposalRefusal("This location cannot create a proof worktree.")
      const parsed = parseProfile(input.profile)
      if (!parsed.ok) {
        const [first] = parsed.issues
        return {
          ok: false,
          refusal: "PROFILE_INVALID",
          message: first ? `${first.path || "profile"}: ${first.message}` : "Invalid profile",
        }
      }
      const proof = await proveProfile({
        projectDirectory: repository.projectDirectory,
        dataDirectory: options.dataDirectory,
        profile: parsed.profile,
        ...(input.proofTargets ? { proofTargets: input.proofTargets } : {}),
        workspace: options.proofWorkspace,
        repository,
      })
      const row = proposeRevision(repository, {
        projectKey: input.key,
        profile: parsed.profile,
        author: { kind: "owner" },
        reason: input.reason,
        proofs: proof.proofs,
        mapPreview: proof.mapPreview,
      })
      return {
        ok: true,
        revision: row.revision,
        proofs: row.proofs,
        mapPreview: proof.mapPreview,
        changes: profileDiff(activeProfileForKey(repository, input.key)?.profile, parsed.profile),
      }
    },
    confirmProfile: (key: string, revision: number) => decide(key, revision, confirmRevision),
    discardProfile: (key: string, revision: number) => decide(key, revision, discardRevision),
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
    setSetting(scope: ProjectScope, name: string, value: unknown): ProjectsOutcome {
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
            ownDirectory: repository.projectDirectory,
            ...(input.cursor ? { cursor: input.cursor } : {}),
            ...(options.sessionOf ? { sessionOf: options.sessionOf } : {}),
          })
          return page ?? { items: [], nextCursor: null }
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(Effect.orDie),
    list: () => Effect.sync(() => operations.list()),
    profile: (input) => Effect.sync(() => operations.profile(input.key)),
    proposeProfile: (input) =>
      Effect.tryPromise({
        try: () => operations.proposeProfile(input),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(Effect.orDie),
    confirmProfile: (input) =>
      Effect.sync(() => operations.confirmProfile(input.key, input.revision)),
    discardProfile: (input) =>
      Effect.sync(() => operations.discardProfile(input.key, input.revision)),
    setCode: (input) => Effect.sync(() => operations.setCode(input.key, input.code)),
    setPause: (input) =>
      Effect.sync(() => operations.setPause(input.scope, input.paused, input.reason ?? "")),
    setSetting: (input) =>
      Effect.sync(() => operations.setSetting(input.scope, input.name, input.value)),
  })
}
