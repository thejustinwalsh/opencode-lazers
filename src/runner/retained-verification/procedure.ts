import { lstatSync, readFileSync, realpathSync } from "node:fs"
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
export type RetainedProcedureKind = "bun-test" | "bun-quality"

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

const qualityCommands = new Set(["bun fmt --check", "bun lint", "bun check", "git diff --check"])

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

function lstatIfPresent(path: string) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return undefined
    throw error
  }
}

/**
 * Recognize project-owned verification procedures, not their transitive shell
 * effects. Project tests and the narrow formatter/linter/typechecker/Git-diff
 * commands use the owned checkout, dependency snapshot, Bun cache and standard
 * user/cache/temp directories. Named package scripts must be declared by the
 * candidate itself, so build procedures stay project-owned without accepting
 * arbitrary shell commands.
 */
export function retainedProcedurePlan(command: string): RetainedProcedurePlanResult {
  if (command === "bun test" || command.startsWith("bun test ")) {
    const targetText = command === "bun test" ? "" : command.slice("bun test ".length)
    if (command !== "bun test" && !targetText)
      return {
        status: "unsupported",
        reason: "uses a Bun test target outside the safe project-relative procedure contract",
      }
    const targets = targetText ? targetText.split(" ") : []
    if (targets.some((target) => !isSafeProjectTarget(target)))
      return {
        status: "unsupported",
        reason: "uses a Bun test target outside the safe project-relative procedure contract",
      }
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
  return {
    status: "unsupported",
    reason:
      "has no project-authored procedure/resource binding; only project-relative Bun test targets, scoped quality commands, and candidate-declared Bun scripts are currently bound",
  }
}

/** Confirm every named build/check script is authored by the exact candidate. */
export function assertRetainedProcedureDeclaration(
  plan: RetainedProcedurePlan,
  candidateWorkspace: string,
): void {
  const candidate = realpathSync(candidateWorkspace)
  assertRetainedProcedureTargets(plan, candidate)
  if (plan.projectScripts.length === 0) return
  const manifestPath = join(candidate, "package.json")
  const manifestInfo = lstatIfPresent(manifestPath)
  if (!manifestInfo || manifestInfo.isSymbolicLink() || !manifestInfo.isFile())
    throw new Error("Candidate project procedure scripts require a regular package.json")
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"))
  const scripts =
    typeof manifest === "object" && manifest !== null && !Array.isArray(manifest)
      ? (manifest as { scripts?: unknown }).scripts
      : undefined
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts))
    throw new Error(
      "Candidate package.json does not declare the required project procedure scripts",
    )
  for (const name of plan.projectScripts) {
    const script = (scripts as Record<string, unknown>)[name]
    if (!isSafeProjectScriptName(name) || typeof script !== "string" || !script.trim())
      throw new Error(`Candidate package.json does not declare project procedure script ${name}`)
  }
}

/**
 * Bind a procedure plan to the exact candidate's own manifests and the
 * runtime-created resource identities. A worktree alone is not this binding.
 */
export function retainedProjectIdentity(
  projectDirectoryInput: string,
  candidateWorkspaceInput: string,
  candidateArtifact: string,
): string {
  const projectDirectory = realpathSync(projectDirectoryInput)
  const candidateWorkspace = realpathSync(candidateWorkspaceInput)
  const manifestFiles = [
    "package.json",
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bunfig.toml",
  ]
  const files = manifestFiles.map((name) => {
    const candidatePath = join(candidateWorkspace, name)
    const candidateInfo = lstatIfPresent(candidatePath)
    if (!candidateInfo) return { name, contents: null }
    if (candidateInfo.isSymbolicLink() || !candidateInfo.isFile())
      throw new Error(`Candidate procedure manifest ${name} is not a regular file`)
    const candidateContents = readFileSync(candidatePath)
    return { name, contents: candidateContents.toString("base64") }
  })
  return fingerprint({
    schemaVersion: 1,
    projectDirectory,
    candidateWorkspace,
    candidateArtifact,
    files,
  })
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
    binding.projectIdentity === expected.projectIdentity &&
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
