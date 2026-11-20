import type { ProfileIdentity } from "../runner/artifacts.ts"
import type { ActiveProfile } from "./profile-store.ts"
import type { RetainedCheckProfile } from "../runner/retained-verification/isolation.ts"
import type { TaskRepository } from "../storage.ts"
import { activeProfile } from "./profile-store.ts"
import { effectiveInstall, type EffectiveInstall } from "./toolchains.ts"

/**
 * What the runner needs from an `ActiveProfile`. Readers take `ActiveProfile | undefined` and
 * keep today's code for `undefined`; nothing here runs unless a profile was confirmed.
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
 * The profile an isolated recheck is set up with: the active revision, read once, with only its
 * proven installs. Spread into `createRetainedCheckContext`'s input; empty when no profile exists.
 */
export function retainedProfileInput(
  repository: Pick<TaskRepository, "read">,
  projectDirectory: string,
  workspace: string,
): { profile?: RetainedCheckProfile } {
  const active = activeProfile(repository, projectDirectory)
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
