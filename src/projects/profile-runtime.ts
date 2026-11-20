import type { ProfileIdentity } from "../runner/artifacts.ts"
import type { ActiveProfile } from "./profile-store.ts"
import type { RetainedCheckProfile } from "../runner/retained-verification/isolation.ts"
import type { TaskRepository } from "../storage.ts"
import {
  activeProfile,
  pinnedProfileRevision,
  pinProfileRevision,
  profileRevisionByID,
} from "./profile-store.ts"
import { effectiveInstall, type EffectiveInstall } from "./toolchains.ts"

/**
 * What the runner needs from an `ActiveProfile`. Readers take `ActiveProfile | undefined` and
 * keep today's code for `undefined`; nothing here runs unless a profile is active.
 */
export type ProfileCommands = {
  toolchains: readonly string[]
  verify: readonly string[]
  fix: readonly string[]
}
export type CheckRunProfile = {
  revisionID: number
  toolchains: readonly string[]
  commands: ProfileCommands
  identity: ProfileIdentity
}

export function checkRunProfile(active: ActiveProfile): CheckRunProfile {
  const { profile } = active
  const toolVersions: Record<string, string> = {}
  for (const name of profile.toolchains) {
    const version = active.proofs.get(`tool:${name}`)?.toolVersion
    if (version) toolVersions[name] = version
  }
  return {
    revisionID: active.revisionID,
    toolchains: profile.toolchains,
    commands: {
      toolchains: profile.toolchains,
      verify: profile.verify.map((entry) => entry.command),
      fix: profile.fix.map((entry) => entry.command),
    },
    identity: {
      revision: active.revision,
      toolchains: profile.toolchains,
      env: profile.env,
      toolVersions,
    },
  }
}

/** Fix entries whose proof passed, in profile order. An unproven fix never runs unattended. */
export function runnableFix(
  active: ActiveProfile,
): { index: number; command: string; files?: string[] }[] {
  return active.profile.fix.flatMap((entry, index) =>
    active.proofs.get(`fix:${index}`)?.outcome === "proven"
      ? [{ index, command: entry.command, ...(entry.files ? { files: entry.files } : {}) }]
      : [],
  )
}

/** Install entries whose proof passed; an unproven install never runs unattended. */
export function runnableInstall(active: ActiveProfile, workspace: string): EffectiveInstall[] {
  return effectiveInstall(active.profile, workspace).flatMap((entry, index) =>
    entry.source !== "none" && active.proofs.get(`install:${index}`)?.outcome === "proven"
      ? [entry]
      : [],
  )
}

/**
 * The profile an isolated recheck is set up with, with only its proven installs. Spread into
 * `createRetainedCheckContext`'s input; empty when the run has no profile. With an `operationID`
 * the revision is pinned on first use, so a recheck resumed after a restart keeps the revision it
 * started with, even if a newer one became active meanwhile.
 */
export function retainedProfileInput(
  repository: Pick<TaskRepository, "read" | "atomic">,
  projectDirectory: string,
  workspace: string,
  operationID?: string,
): { profile?: RetainedCheckProfile } {
  const scope = operationID === undefined ? undefined : `retained:${operationID}`
  const pinned = scope === undefined ? undefined : pinnedProfileRevision(repository, scope)
  const active =
    pinned === undefined
      ? activeProfile(repository, projectDirectory)
      : pinned === 0
        ? undefined
        : profileRevisionByID(repository, pinned)
  if (scope !== undefined && pinned === undefined)
    pinProfileRevision(repository, scope, active?.revisionID ?? 0)
  if (!active) return {}
  return {
    profile: {
      revisionID: active.revisionID,
      revision: active.revision,
      profile: active.profile,
      installs: runnableInstall(active, workspace),
    },
  }
}

/** Whether the project's active profile turns the Fallow audit off (no profile: it does not). */
export function auditIsOff(
  repository: Pick<TaskRepository, "read">,
  projectDirectory: string,
): boolean {
  return activeProfile(repository, projectDirectory)?.profile.audit === "off"
}
