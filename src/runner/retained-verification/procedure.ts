import { lstatSync, realpathSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { fingerprint } from "../../identity.ts"

export const retainedProjectResourceNames = [
  "home",
  "tmp",
  "config",
  "data",
  "cache",
  "state",
  "bun-cache",
  "dependencies",
  "database",
] as const

export type RetainedProjectResourceName = (typeof retainedProjectResourceNames)[number]
export type RetainedProcedureKind = "bun-test" | "bun-quality" | "command"

export type RetainedProcedurePlan = {
  schemaVersion: 1
  kind: RetainedProcedureKind
  commandFingerprint: string
  targets: string[]
  projectScripts: string[]
  resources: RetainedProjectResourceName[]
}

export type RetainedProcedureResourceIdentity = {
  name: RetainedProjectResourceName
  realPath: string
  device: number
  inode: number
}

export type RetainedProcedureBinding = RetainedProcedurePlan & {
  projectDirectory: string
  candidateWorkspace: string
  candidateArtifact: string
  projectIdentity: string
  resourceIdentities: RetainedProcedureResourceIdentity[]
  dependencyEnvironmentIdentity: string
  dependencyLink: { path: string; target: string } | null
  temporaryDirectoryLink: {
    path: string
    target: string
    device: number
    inode: number
  } | null
}

export type RetainedProcedurePlanResult =
  { status: "supported"; plan: RetainedProcedurePlan } | { status: "unsupported"; reason: string }

const qualityCommands = new Set([
  "bun fmt",
  "bun lint --fix",
  "bun fmt --check",
  "bun lint",
  "bun check",
  "git diff --check",
])

function isSafeProjectScriptName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(name)
}

function isSafeProjectTarget(path: string): boolean {
  return (
    /^(?:[A-Za-z0-9_@][A-Za-z0-9_.@-]*)(?:\/[A-Za-z0-9_@][A-Za-z0-9_.@-]*)*$/.test(path) &&
    !path.split("/").some((part) => part === "." || part === "..")
  )
}

function isContained(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep))
}

function commandProcedure(command: string): RetainedProcedurePlanResult {
  return {
    status: "supported",
    plan: {
      schemaVersion: 1,
      kind: "command",
      commandFingerprint: fingerprint(command),
      targets: [],
      projectScripts: [],
      resources: [...retainedProjectResourceNames],
    },
  }
}

/** Describe familiar commands for resource setup; other authorized commands use the same isolation. */
export function retainedProcedurePlan(command: string): RetainedProcedurePlanResult {
  const chain = command.split(" && ")
  if (chain.length > 1) {
    const plans: RetainedProcedurePlan[] = []
    for (const step of chain) {
      const result = retainedProcedurePlan(step)
      if (result.status === "unsupported") return result
      plans.push(result.plan)
    }
    return {
      status: "supported",
      plan: {
        schemaVersion: 1,
        kind: plans.every((plan) => plan.kind === "bun-test") ? "bun-test" : "bun-quality",
        commandFingerprint: fingerprint(command),
        targets: [...new Set(plans.flatMap((plan) => plan.targets))],
        projectScripts: [...new Set(plans.flatMap((plan) => plan.projectScripts))],
        resources: [...retainedProjectResourceNames],
      },
    }
  }
  const scopedFormat = /^bun fmt(?: --check)? (.+)$/.exec(command)
  if (scopedFormat) {
    const targets = scopedFormat[1]!.split(" ")
    if (targets.every(isSafeProjectTarget))
      return {
        status: "supported",
        plan: {
          schemaVersion: 1,
          kind: "bun-quality",
          commandFingerprint: fingerprint(command),
          targets: [...new Set(targets)],
          projectScripts: [],
          resources: [...retainedProjectResourceNames],
        },
      }
  }
  if (command === "bun test" || command.startsWith("bun test ")) {
    const targetText = command === "bun test" ? "" : command.slice("bun test ".length)
    if (command !== "bun test" && !targetText) return commandProcedure(command)
    const targets = targetText ? targetText.split(" ") : []
    if (targets.some((target) => !isSafeProjectTarget(target))) return commandProcedure(command)
    return {
      status: "supported",
      plan: {
        schemaVersion: 1,
        kind: "bun-test",
        commandFingerprint: fingerprint(command),
        targets: [...targets],
        projectScripts: [],
        resources: [...retainedProjectResourceNames],
      },
    }
  }
  const steps = command.split(" && ")
  if (steps.length > 0 && steps.join(" && ") === command) {
    const projectScripts: string[] = []
    let containsAuthoredProcedure = false
    for (const step of steps) {
      if (qualityCommands.has(step)) {
        containsAuthoredProcedure = true
        continue
      }
      const script = /^bun run ([A-Za-z0-9][A-Za-z0-9._:-]*)$/.exec(step)?.[1]
      if (!script || !isSafeProjectScriptName(script)) {
        containsAuthoredProcedure = false
        break
      }
      projectScripts.push(script)
      containsAuthoredProcedure = true
    }
    if (containsAuthoredProcedure && steps.length > 0)
      return {
        status: "supported",
        plan: {
          schemaVersion: 1,
          kind: "bun-quality",
          commandFingerprint: fingerprint(command),
          targets: [],
          projectScripts: [...new Set(projectScripts)],
          resources: [...retainedProjectResourceNames],
        },
      }
  }
  return commandProcedure(command)
}

/** Resolve known test targets inside the candidate; scripts report their own execution errors. */
export function assertRetainedProcedureDeclaration(
  plan: RetainedProcedurePlan,
  candidateWorkspace: string,
): void {
  assertRetainedProcedureTargets(plan, realpathSync(candidateWorkspace))
}

/**
 * Describe the source checkout and revision observed by the procedure.
 */
export function retainedProjectIdentity(
  projectDirectoryInput: string,
  candidateWorkspaceInput: string,
  candidateArtifact: string,
): string {
  const projectDirectory = realpathSync(projectDirectoryInput)
  const candidateWorkspace = realpathSync(candidateWorkspaceInput)
  return JSON.stringify({ projectDirectory, candidateWorkspace, candidateArtifact })
}

export function assertRetainedProcedureTargets(
  plan: RetainedProcedurePlan,
  candidateWorkspace: string,
): void {
  const candidate = realpathSync(candidateWorkspace)
  for (const target of plan.targets) {
    if (!isSafeProjectTarget(target))
      throw new Error("Project test target is not a safe relative path")
    const targetPath = join(candidate, target)
    try {
      lstatSync(targetPath)
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        continue
      throw error
    }
    const canonicalTarget = realpathSync(targetPath)
    if (!isContained(candidate, canonicalTarget))
      throw new Error(`Project test target ${target} escapes the exact candidate checkout`)
  }
}

export function assertRetainedProcedureBinding(
  value: unknown,
  expected: {
    plan: RetainedProcedurePlan
    projectDirectory: string
    candidateWorkspace: string
    candidateArtifact: string
    projectIdentity: string
  },
): value is RetainedProcedureBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const binding = value as Partial<RetainedProcedureBinding>
  if (!(
    binding.schemaVersion === 1 &&
    binding.kind === expected.plan.kind &&
    binding.commandFingerprint === expected.plan.commandFingerprint &&
    fingerprint(binding.targets) === fingerprint(expected.plan.targets) &&
    fingerprint(binding.projectScripts) === fingerprint(expected.plan.projectScripts) &&
    fingerprint(binding.resources) === fingerprint(expected.plan.resources) &&
    binding.projectDirectory === realpathSync(expected.projectDirectory) &&
    binding.candidateWorkspace === realpathSync(expected.candidateWorkspace) &&
    binding.candidateArtifact === expected.candidateArtifact &&
    typeof binding.dependencyEnvironmentIdentity === "string" &&
    Array.isArray(binding.resourceIdentities) &&
    binding.resourceIdentities.length === expected.plan.resources.length &&
    (binding.dependencyLink === null ||
      (typeof binding.dependencyLink === "object" &&
        typeof binding.dependencyLink.path === "string" &&
        typeof binding.dependencyLink.target === "string")) &&
    (binding.temporaryDirectoryLink === null ||
      (typeof binding.temporaryDirectoryLink === "object" &&
        typeof binding.temporaryDirectoryLink.path === "string" &&
        typeof binding.temporaryDirectoryLink.target === "string" &&
        typeof binding.temporaryDirectoryLink.device === "number" &&
        typeof binding.temporaryDirectoryLink.inode === "number"))
  ))
    return false
  const identities = binding.resourceIdentities
  return expected.plan.resources.every((name, index) => {
    const identity = identities[index]
    return (
      typeof identity === "object" &&
      identity !== null &&
      identity.name === name &&
      typeof identity.realPath === "string" &&
      typeof identity.device === "number" &&
      typeof identity.inode === "number"
    )
  })
}
