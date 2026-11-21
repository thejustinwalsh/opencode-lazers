import { FALLOW_CONFIG_REQUIRED, type FallowConfigRequired } from "./fallow-refusal.ts"
import type { TaskRepository } from "../storage.ts"
import { activeProfile } from "../projects/profile-store.ts"
import { getLatestFallowConfig, hasFallowConfig } from "./config.ts"

/**
 * Every project needs a Fallow config: the audit that reviews each task reads its entry points,
 * ignore patterns, rules and limits from it, and nothing is silently skipped without one. With
 * the review on, submitting work to a project that has none is refused with this typed result.
 * It is a validation result of the submit command, not a workflow state.
 */
const FALLOW_CONFIG_TOOLS = [
  "lz-fallow-config (mode suggest)",
  "lz-fallow-config (mode dry-run)",
  "lz-fallow-config-set",
] as const

export function missingConfigText(project: string): string {
  return `${project} has no Fallow config: no repository config file (.fallowrc.json, .fallowrc.jsonc, fallow.toml) and no stored LAZERS project config.`
}

/** The refusal for a project with no config, short enough for a gate and pointing at the guide. */
export function configRequired(project: string): FallowConfigRequired {
  return {
    status: "refused",
    code: FALLOW_CONFIG_REQUIRED,
    project,
    missing: missingConfigText(project),
    nothingQueued: true,
    next: [...FALLOW_CONFIG_TOOLS],
    guidance:
      "Architect: call lz-fallow-config with mode suggest. Its result carries the guidance for building the config (entry points, ignore patterns, rules and severities, thresholds); mode guide returns it again. Store the reviewed config with lz-fallow-config-set.",
  }
}

/** Undefined when the review is off or the project has a config; the refusal otherwise. */
export async function fallowConfigGate(input: {
  enabled: boolean
  directory: string
  repository: TaskRepository
  /** The profile's audit setting; defaults to the active profile's, else Fallow. */
  audit?: "fallow" | "off"
}): Promise<FallowConfigRequired | undefined> {
  if (!input.enabled) return undefined
  const audit =
    input.audit ?? activeProfile(input.repository, input.repository.projectDirectory)?.profile.audit
  if (audit === "off") return undefined
  const present = await hasFallowConfig({
    directory: input.directory,
    ref: "HEAD",
    repository: input.repository,
  })
  return present ? undefined : configRequired(input.repository.projectDirectory)
}

/** A stored LAZERS config settles the gate without touching git, so a dispatch need not wait. */
export function hasStoredFallowConfig(repository: TaskRepository): boolean {
  return getLatestFallowConfig(repository) !== undefined
}
