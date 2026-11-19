import { z } from "zod"
import type { TaskRepository } from "../storage.ts"
import { getLatestFallowConfig, hasFallowConfig } from "./config.ts"

/**
 * Every project needs a Fallow config: the audit that reviews each task reads its entry points,
 * ignore patterns, rules and limits from it, and nothing is silently skipped without one. With
 * the review on, submitting work to a project that has none is refused with this typed result.
 * It is a validation result of the submit command, not a workflow state.
 */
export const FALLOW_CONFIG_REQUIRED = "FALLOW_CONFIG_REQUIRED"

export const FallowConfigRequired = z.strictObject({
  status: z.literal("refused"),
  code: z.literal(FALLOW_CONFIG_REQUIRED),
  /** The canonical project root that has no config. */
  project: z.string().min(1),
  missing: z.string().min(1),
  /** Always true: the refusal happens before anything is stored or queued. */
  nothingQueued: z.literal(true),
  /** The tools to use next, in order. */
  next: z.array(z.string().min(1)),
  guidance: z.string().min(1),
})
export type FallowConfigRequired = z.infer<typeof FallowConfigRequired>

export const FALLOW_CONFIG_TOOLS = [
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
      "Architect: propose a config with lz-fallow-config mode suggest, evaluate it on the whole repository with lz-fallow-config mode dry-run (sample the findings; a rule that is mostly wrong stays off), then store it with lz-fallow-config-set and a one-line reason. See the Fallow config section of your instructions: entry points, ignore patterns, rules and severities, thresholds.",
  }
}

/** Undefined when the review is off or the project has a config; the refusal otherwise. */
export async function fallowConfigGate(input: {
  enabled: boolean
  directory: string
  repository: TaskRepository
}): Promise<FallowConfigRequired | undefined> {
  if (!input.enabled) return undefined
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
