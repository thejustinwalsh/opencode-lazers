import { checkEnvironment } from "../checks.ts"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { lstat, readdir, realpath, rm } from "node:fs/promises"
import type { Dirent } from "node:fs"
import { join, relative, sep } from "node:path"
import { tmpdir } from "node:os"
import { fingerprint } from "../../identity.ts"
import {
  assertRetainedProcedureBinding,
  assertRetainedProcedureDeclaration,
  retainedProjectIdentity,
  retainedProjectResourceNames,
} from "./procedure.ts"
import type {
  RetainedProcedureBinding,
  RetainedProcedurePlan,
  RetainedProcedureResourceIdentity,
} from "./procedure.ts"

export type RetainedCheckContext = {
  schemaVersion: 1
  operationID: string
  phase: "task" | "combined"
  checkID: string
  directory: string
  originalWorkspace: string
  candidateWorkspace: string
  taskDatabase: string
  projectDirectory: string
  projectIdentity: string
  dependencyLink: { path: string; target: string } | null
  identity: string
  environmentIdentity: string
  procedureBinding: RetainedProcedureBinding
  resources: Array<{ name: string; path: string; realPath: string; device: number; inode: number }>
  environment: Record<string, string>
}

export type RetainedCheckSetupResource = {
  path: string
  realPath: string
  device: number
  inode: number
}

export type RetainedCheckSetupLink = {
  path: string
  target: string
  device: number
  inode: number
}

export type RetainedDependencyInstaller = (input: {
  candidateWorkspace: string
  environment: Record<string, string>
  signal: AbortSignal
}) => Promise<void>

export class RetainedSetupProcessTreeUncertainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RetainedSetupProcessTreeUncertainError"
  }
}

type OwnerMarker = {
  schemaVersion: 1
  operationID: string
  phase: "task" | "combined"
  checkID: string
  identity: string
}

const resourceNames = retainedProjectResourceNames
const markerName = ".lazers-retained-verification-owner.json"

export function retainedVerificationEnvironmentIdentity(): string {
  return JSON.stringify({
    bunRevision: Bun.revision,
    bunVersion: Bun.version,
    executable: process.execPath,
    platform: process.platform,
    architecture: process.arch,
    PATH: checkEnvironment().PATH ?? "/usr/bin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? null,
    TZ: process.env.TZ ?? null,
    CI: process.env.CI ?? null,
  })
}

function pathContains(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))
}

const walkConcurrency = 32
/** Passes over one immutable-in-practice tree within this window are shared. */
const walkMemoMs = 2000
const walkMemo = new Map<string, { at: number; pass: Promise<void> }>()

type Visit = (child: string, entry: Dirent) => Promise<boolean>

/**
 * Breadth-first walk with bounded concurrency. Every readdir awaits, so the
 * event loop gets a turn between directory batches; a copied node_modules tree
 * never holds the service thread.
 */
async function walkTree(start: string, visit: Visit): Promise<void> {
  const pending = [start]
  while (pending.length) {
    const batch = pending.splice(0, walkConcurrency)
    const descended = await Promise.all(
      batch.map(async (current) => {
        const directories: string[] = []
        for (const entry of await readdir(current, { withFileTypes: true })) {
          const child = join(current, entry.name)
          if (await visit(child, entry)) directories.push(child)
        }
        return directories
      }),
    )
    for (const directories of descended) pending.push(...directories)
  }
}

/** A directory entry's kind; falls back to lstat on filesystems without d_type. */
async function entryKind(
  child: string,
  entry: Dirent,
): Promise<"link" | "directory" | "file" | "other"> {
  if (entry.isSymbolicLink()) return "link"
  if (entry.isDirectory()) return "directory"
  if (entry.isFile()) return "file"
  const info = await lstat(child)
  return info.isSymbolicLink()
    ? "link"
    : info.isDirectory()
      ? "directory"
      : info.isFile()
        ? "file"
        : "other"
}

function memoized(kind: string, root: string, run: () => Promise<void>): Promise<void> {
  const key = `${kind}\0${root}`
  const hit = walkMemo.get(key)
  const now = Date.now()
  if (hit && now - hit.at < walkMemoMs) return hit.pass
  const pass = run()
  walkMemo.set(key, { at: now, pass })
  // A failed pass must never be reused: the next caller re-walks.
  pass.catch(() => {
    if (walkMemo.get(key)?.pass === pass) walkMemo.delete(key)
  })
  return pass
}

/** Exported for behavior tests. */
export async function assertNoSymlinks(directory: string): Promise<void> {
  const ownedRoot = await realpath(directory)
  await memoized("symlinks", ownedRoot, () =>
    walkTree(directory, async (child, entry) => {
      const kind = await entryKind(child, entry)
      if (kind === "link") {
        const target = await realpath(child)
        if (!pathContains(ownedRoot, target))
          throw new Error(
            `Verification resource contains a symbolic link outside its owned context: ${child} -> ${target}`,
          )
        return false
      }
      if (kind === "directory") return true
      if (kind !== "file") throw new Error("Verification resource contains a non-regular entry")
      return false
    }),
  )
}

/** Exported for behavior tests. */
export async function assertOwnedDependencyTree(directory: string): Promise<void> {
  const root = await realpath(directory)
  await memoized("dependencies", root, () =>
    walkTree(root, async (child, entry) => {
      const kind = await entryKind(child, entry)
      if (kind === "link") {
        let target: string
        try {
          target = await realpath(child)
        } catch {
          throw new Error("Project dependency snapshot contains a dangling symbolic link")
        }
        if (!pathContains(root, target))
          throw new Error("Project dependency snapshot links to a shared external resource")
        return false
      }
      if (kind === "directory") return true
      if (kind !== "file")
        throw new Error("Project dependency snapshot contains a non-regular entry")
      return false
    }),
  )
}

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const

const bunDependencyLockFiles = ["bun.lock", "bun.lockb"] as const

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint <= 0x1f || codePoint === 0x7f
  })
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

function candidatePackageManifest(directory: string): Record<string, unknown> | undefined {
  const path = join(directory, "package.json")
  const info = lstatIfPresent(path)
  if (!info) return undefined
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error("Candidate package.json is not a regular project manifest")
  const value: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Candidate package.json is not a JSON object")
  return value as Record<string, unknown>
}

function candidateDependencySpecs(manifest: Record<string, unknown>): Array<[string, string]> {
  const dependencies: Array<[string, string]> = []
  for (const field of dependencyFields) {
    const value = manifest[field]
    if (value === undefined) continue
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error(`Candidate package.json ${field} must be an object`)
    for (const [name, specification] of Object.entries(value)) {
      if (
        !/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(name) ||
        name.split("/").some((part) => part === "." || part === "..") ||
        typeof specification !== "string" ||
        !specification.trim() ||
        hasControlCharacters(specification)
      )
        throw new Error(`Candidate dependency ${name} cannot be safely resolved in isolation`)
      dependencies.push([name, specification])
    }
  }
  return dependencies.sort(([a], [b]) => a.localeCompare(b))
}

function assertCandidateDependencySetup(
  candidateWorkspace: string,
  _candidateArtifact: string,
  manifest: Record<string, unknown>,
): void {
  const candidateRoot = realpathSync(candidateWorkspace)
  const dependencies = candidateDependencySpecs(manifest)

  for (const [name, specification] of dependencies) {
    if (!specification.startsWith("file:")) continue
    const relativePath = specification.slice("file:".length)
    if (
      !relativePath ||
      relativePath.includes("\\") ||
      relativePath.startsWith("/") ||
      relativePath.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error(
        `Candidate dependency environment cannot be isolated: ${name} uses a file source outside the candidate-relative package contract`,
      )
    const packagePath = join(candidateRoot, relativePath)
    const info = lstatIfPresent(packagePath)
    if (
      !info ||
      info.isSymbolicLink() ||
      !info.isFile() ||
      !pathContains(candidateRoot, realpathSync(packagePath))
    )
      throw new Error(
        `Candidate dependency environment cannot be isolated: ${name} file source is unavailable inside the candidate`,
      )
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      if (error.code === "ESRCH") return false
      if (error.code === "EPERM") return true
    }
    throw error
  }
}

function signalProcessGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")
      return
    throw error
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false
    await Bun.sleep(20)
  }
  return true
}

async function terminateAndObserveProcessGroup(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  try {
    signalProcessGroup(child.pid, "SIGTERM")
    if (!(await waitForProcessGroupExit(child.pid, 1_000))) {
      signalProcessGroup(child.pid, "SIGKILL")
      if (!(await waitForProcessGroupExit(child.pid, 5_000)))
        throw new RetainedSetupProcessTreeUncertainError(
          "Could not confirm that the candidate dependency installer process tree stopped; preserve its partial resources",
        )
    }
    await child.exited
  } catch (error) {
    if (error instanceof RetainedSetupProcessTreeUncertainError) throw error
    throw new RetainedSetupProcessTreeUncertainError(
      `Could not terminate and observe the candidate dependency installer process tree: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** Run an installer command in an owned process group and observe all group members before returning. */
export async function runRetainedSetupProcess(input: {
  command: string[]
  candidateWorkspace: string
  environment: Record<string, string>
  signal: AbortSignal
  timeoutMs: number
  failedMessage: string
}): Promise<void> {
  if (input.signal.aborted) throw new Error("Candidate dependency setup was cancelled")
  if (process.platform === "win32")
    throw new Error(
      "Candidate dependency setup cannot prove installer process-tree cleanup on this platform",
    )
  const child = Bun.spawn(input.command, {
    cwd: input.candidateWorkspace,
    env: input.environment,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  })
  let timeout: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined
  const outcome = await Promise.race([
    child.exited.then((code) => ({ kind: "exit" as const, code })),
    new Promise<{ kind: "cancelled" | "timeout" }>((resolve) => {
      if (input.signal.aborted) {
        resolve({ kind: "cancelled" })
        return
      }
      abortListener = () => resolve({ kind: "cancelled" })
      input.signal.addEventListener("abort", abortListener, { once: true })
      timeout = setTimeout(() => resolve({ kind: "timeout" }), input.timeoutMs)
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout)
    if (abortListener) input.signal.removeEventListener("abort", abortListener)
  })
  if (outcome.kind !== "exit") {
    await terminateAndObserveProcessGroup(child)
    if (outcome.kind === "cancelled") throw new Error("Candidate dependency setup was cancelled")
    throw new Error(`Candidate dependency setup exceeded ${input.timeoutMs} milliseconds`)
  }
  if (!(await waitForProcessGroupExit(child.pid, 100))) {
    await terminateAndObserveProcessGroup(child)
    throw new Error("Candidate dependency installer exited while descendants were still running")
  }
  if (outcome.code !== 0) throw new Error(input.failedMessage)
}

async function installCandidateDependencies(input: {
  candidateWorkspace: string
  environment: Record<string, string>
  signal: AbortSignal
}): Promise<void> {
  const bun = Bun.which("bun", { PATH: input.environment.PATH })
  if (!bun) throw new Error("Candidate dependency setup requires Bun on the verification PATH")
  return runRetainedSetupProcess({
    command: [
      bun,
      "install",
      ...(bunDependencyLockFiles.some((name) => existsSync(join(input.candidateWorkspace, name)))
        ? ["--frozen-lockfile"]
        : []),
      "--ignore-scripts",
      "--no-save",
      "--no-progress",
    ],
    candidateWorkspace: input.candidateWorkspace,
    environment: input.environment,
    signal: input.signal,
    timeoutMs: 120_000,
    failedMessage:
      "Candidate dependency environment cannot be isolated: Bun could not install the committed candidate lockfile",
  })
}

function candidateDependencyEnvironmentIdentity(
  dependencyRoot: string,
  _manifest: Record<string, unknown> | undefined,
  candidateWorkspace: string,
): string {
  return JSON.stringify({
    root: realpathSync(dependencyRoot),
    candidateWorkspace: realpathSync(candidateWorkspace),
  })
}

function temporaryDirectoryAliasPath(input: {
  operationID: string
  phase: "task" | "combined"
  checkID: string
}): string | null {
  if (process.platform === "win32") return null
  const aliasRoot = "/tmp"
  const targetLength = tmpdir().length
  const prefix = `lazers-${fingerprint({
    operationID: input.operationID,
    phase: input.phase,
    checkID: input.checkID,
  }).slice(0, 32)}`
  const nameLength = targetLength - aliasRoot.length - 1
  if (nameLength < prefix.length || nameLength > 255 || !existsSync(aliasRoot)) return null
  return join(aliasRoot, prefix + "x".repeat(nameLength - prefix.length))
}

export function retainedTemporaryDirectoryAliasPath(input: {
  operationID: string
  phase: "task" | "combined"
  checkID: string
}): string | null {
  return temporaryDirectoryAliasPath(input)
}

function temporaryDirectoryAlias(input: {
  operationID: string
  phase: "task" | "combined"
  checkID: string
  target: string
  blockedPaths: string[]
  onReserved?: (link: RetainedCheckSetupLink) => void
}): RetainedProcedureBinding["temporaryDirectoryLink"] {
  const path = temporaryDirectoryAliasPath(input)
  if (!path) return null
  if (
    input.blockedPaths.some((blocked) => pathContains(path, blocked) || pathContains(blocked, path))
  )
    return null
  try {
    lstatSync(path)
    throw new Error("Temporary resource alias path is already occupied; ownership is uncertain")
  } catch (error) {
    if (!(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error
  }
  input.onReserved?.({ path, target: input.target, device: -1, inode: -1 })
  symlinkSync(input.target, path, "dir")
  const info = lstatSync(path)
  if (!info.isSymbolicLink() || realpathSync(path) !== input.target) {
    unlinkSync(path)
    throw new Error("Temporary resource alias does not resolve to its owned directory")
  }
  return { path, target: input.target, device: info.dev, inode: info.ino }
}

/** Allocate only runtime-owned, operation-specific writable check resources. */
export async function createRetainedCheckContext(input: {
  rootDirectory: string
  operationID: string
  phase: "task" | "combined"
  checkID: string
  originalWorkspace: string
  candidateWorkspace: string
  taskDatabase: string
  projectDirectory: string
  candidateArtifact: string
  priorResourcePaths: string[]
  procedurePlan: RetainedProcedurePlan
  signal?: AbortSignal
  dependencyInstaller?: RetainedDependencyInstaller
  onSetupPathReserved?: (path: string) => void
  onSetupPathCreated?: (resource: RetainedCheckSetupResource) => void
  onResourcesCreated?: (resources: RetainedCheckContext["resources"]) => void
  onDependencyLinkReserved?: (link: RetainedCheckSetupLink) => void
  onDependencyLink?: (link: RetainedCheckSetupLink) => void
  onTemporaryDirectoryLinkReserved?: (link: RetainedCheckSetupLink) => void
  onTemporaryDirectoryLink?: (link: RetainedCheckSetupLink) => void
}): Promise<RetainedCheckContext> {
  const signal = input.signal ?? new AbortController().signal
  const assertNotCancelled = () => {
    if (signal.aborted) throw new Error("Candidate dependency setup was cancelled")
  }
  assertNotCancelled()
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(input.checkID))
    throw new Error("Verification check ID is not a safe resource identity")
  const root = realpathSync(input.rootDirectory)
  const originalWorkspace = realpathSync(input.originalWorkspace)
  const candidateWorkspace = realpathSync(input.candidateWorkspace)
  const projectDirectory = realpathSync(input.projectDirectory)
  const projectIdentity = retainedProjectIdentity(
    projectDirectory,
    candidateWorkspace,
    input.candidateArtifact,
  )
  if (input.procedurePlan.schemaVersion !== 1)
    throw new Error("Unsupported retained project procedure binding")
  assertRetainedProcedureDeclaration(input.procedurePlan, candidateWorkspace)
  if (
    originalWorkspace === candidateWorkspace ||
    pathContains(originalWorkspace, candidateWorkspace) ||
    pathContains(candidateWorkspace, originalWorkspace)
  )
    throw new Error("Original and candidate workspaces must be distinct canonical checkouts")
  const candidateManifest = candidatePackageManifest(candidateWorkspace)
  if (candidateManifest)
    assertCandidateDependencySetup(candidateWorkspace, input.candidateArtifact, candidateManifest)
  const candidateDependencies = join(candidateWorkspace, "node_modules")
  const nativeDependencies = lstatIfPresent(candidateDependencies)
  if (nativeDependencies) {
    if (
      !candidateManifest ||
      !nativeDependencies.isDirectory() ||
      nativeDependencies.isSymbolicLink()
    )
      throw new Error("Candidate dependencies require a committed manifest and private directory")
    await assertOwnedDependencyTree(candidateDependencies)
  }
  const directory = join(root, `retained-${input.operationID}-${input.phase}-${input.checkID}`)
  if (lstatIfPresent(directory))
    throw new Error("Retained verification resources already exist; ownership is uncertain")
  input.onSetupPathReserved?.(directory)
  mkdirSync(directory, { mode: 0o700 })
  const directoryInfo = lstatSync(directory)
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory())
    throw new Error("Verification resource root is not a real owned directory")
  input.onSetupPathCreated?.({
    path: directory,
    realPath: directory,
    device: directoryInfo.dev,
    inode: directoryInfo.ino,
  })
  const canonicalDirectory = realpathSync(directory)
  if (canonicalDirectory !== directory || !pathContains(root, canonicalDirectory))
    throw new Error("Verification resources escaped the runtime-owned resource root")
  assertNotCancelled()

  const resources: RetainedCheckContext["resources"] = []
  for (const name of resourceNames) {
    const path = join(canonicalDirectory, name)
    // Native worktree creation awaits the project's startup command, which may
    // install dependencies. Move that private tree into this operation's resources
    // before running the ordinary candidate-lock installer and linking it back.
    if (name === "dependencies" && nativeDependencies) renameSync(candidateDependencies, path)
    else mkdirSync(path, { mode: 0o700 })
    const realPath = realpathSync(path)
    const info = statSync(realPath)
    if (realPath !== path || !info.isDirectory())
      throw new Error(`Verification resource ${name} is not a canonical owned directory`)
    resources.push({ name, path, realPath, device: info.dev, inode: info.ino })
  }
  input.onResourcesCreated?.(resources)
  assertNotCancelled()

  let dependencyLink: RetainedCheckContext["dependencyLink"] = null
  if (candidateManifest) {
    const dependencyResource = resources.find((resource) => resource.name === "dependencies")!
    const link = relative(candidateWorkspace, dependencyResource.realPath)
    if (lstatIfPresent(candidateDependencies))
      throw new Error("Candidate checkout dependency link path is already occupied")
    const reservedLink: RetainedCheckSetupLink = {
      path: candidateDependencies,
      target: dependencyResource.realPath,
      device: -1,
      inode: -1,
    }
    input.onDependencyLinkReserved?.(reservedLink)
    symlinkSync(link, candidateDependencies, "dir")
    const info = lstatSync(candidateDependencies)
    const createdLink: RetainedCheckSetupLink = {
      path: candidateDependencies,
      target: dependencyResource.realPath,
      device: info.dev,
      inode: info.ino,
    }
    if (
      !info.isSymbolicLink() ||
      realpathSync(candidateDependencies) !== dependencyResource.realPath
    )
      throw new Error("Candidate dependency link does not resolve to its owned resource")
    input.onDependencyLink?.(createdLink)
    dependencyLink = { path: candidateDependencies, target: dependencyResource.realPath }
  }

  const external = [
    originalWorkspace,
    candidateWorkspace,
    projectDirectory,
    realpathSync(input.taskDatabase),
    ...input.priorResourcePaths.map((path) => (existsSync(path) ? realpathSync(path) : path)),
  ]
  for (const resource of resources) {
    if (
      external.some(
        (path) => pathContains(path, resource.realPath) || pathContains(resource.realPath, path),
      )
    )
      throw new Error(
        `Verification resource ${resource.name} aliases a retained or shared resource`,
      )
    if (
      resources.some(
        (other) =>
          other !== resource &&
          (pathContains(other.realPath, resource.realPath) ||
            pathContains(resource.realPath, other.realPath) ||
            (other.device === resource.device && other.inode === resource.inode)),
      )
    )
      throw new Error(`Verification resource ${resource.name} overlaps another mutable resource`)
  }
  const temporaryDirectoryResource = resources.find((resource) => resource.name === "tmp")!
  const byName = Object.fromEntries(resources.map((resource) => [resource.name, resource.realPath]))
  const npmCache = join(byName.cache!, "npm")
  mkdirSync(npmCache, { mode: 0o700 })
  const globalGitConfig = join(byName.config!, "gitconfig")
  writeFileSync(globalGitConfig, "", { flag: "wx", mode: 0o600 })
  const environment: Record<string, string> = {
    PATH: checkEnvironment().PATH ?? "/usr/bin:/bin",
    HOME: byName.home!,
    TMPDIR: byName.tmp!,
    TMP: byName.tmp!,
    TEMP: byName.tmp!,
    XDG_CONFIG_HOME: byName.config!,
    XDG_DATA_HOME: byName.data!,
    XDG_CACHE_HOME: byName.cache!,
    XDG_STATE_HOME: byName.state!,
    BUN_INSTALL_CACHE_DIR: byName["bun-cache"]!,
    BUN_CONFIG_DIR: byName.config!,
    BUN_TMPDIR: byName.tmp!,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(byName["bun-cache"]!, "transpiler-cache"),
    npm_config_cache: npmCache,
    NPM_CONFIG_CACHE: npmCache,
    COREPACK_HOME: join(byName.data!, "corepack"),
    GIT_CONFIG_GLOBAL: globalGitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    LAZERS_VERIFICATION_SQLITE: join(
      resources.find((item) => item.name === "database")!.realPath,
      "verification.sqlite",
    ),
    LANG: process.env.LANG ?? "C.UTF-8",
    ...(process.env.LC_ALL === undefined ? {} : { LC_ALL: process.env.LC_ALL }),
    ...(process.env.TZ === undefined ? {} : { TZ: process.env.TZ }),
    ...(process.env.CI === undefined ? {} : { CI: process.env.CI }),
    GIT_TERMINAL_PROMPT: "0",
  }
  if (candidateManifest && candidateDependencySpecs(candidateManifest).length > 0)
    await (input.dependencyInstaller ?? installCandidateDependencies)({
      candidateWorkspace,
      environment,
      signal,
    })
  assertNotCancelled()
  const dependencyResource = resources.find((resource) => resource.name === "dependencies")!
  if (candidateManifest) {
    const resolverRoot = join(dependencyResource.realPath, "node_modules")
    if (lstatIfPresent(resolverRoot))
      throw new Error("Candidate dependency install occupied its reserved peer resolver path")
    // Package imports resolve peers through the same node_modules parent as the
    // candidate checkout, while remaining entirely inside this owned resource.
    symlinkSync(".", resolverRoot, "dir")
  }
  await assertOwnedDependencyTree(dependencyResource.realPath)
  const dependencyEnvironmentIdentity = candidateDependencyEnvironmentIdentity(
    dependencyResource.realPath,
    candidateManifest,
    candidateWorkspace,
  )
  const temporaryDirectoryLink = temporaryDirectoryAlias({
    operationID: input.operationID,
    phase: input.phase,
    checkID: input.checkID,
    target: temporaryDirectoryResource.realPath,
    blockedPaths: external,
    onReserved: input.onTemporaryDirectoryLinkReserved,
  })
  if (temporaryDirectoryLink) {
    const temporaryLinkIdentity: RetainedCheckSetupLink = temporaryDirectoryLink
    input.onTemporaryDirectoryLink?.(temporaryLinkIdentity)
    environment.TMPDIR = temporaryDirectoryLink.path
    environment.TMP = temporaryDirectoryLink.path
    environment.TEMP = temporaryDirectoryLink.path
  }
  assertNotCancelled()

  const identity = fingerprint({
    schemaVersion: 1,
    operationID: input.operationID,
    phase: input.phase,
    checkID: input.checkID,
    directory: canonicalDirectory,
    originalWorkspace,
    candidateWorkspace,
    taskDatabase: realpathSync(input.taskDatabase),
    projectDirectory,
    candidateArtifact: input.candidateArtifact,
    projectIdentity,
    procedurePlan: input.procedurePlan,
    dependencyLink,
    temporaryDirectoryLink,
    dependencyEnvironmentIdentity,
    resources: resources.map(({ name, realPath, device, inode }) => ({
      name,
      realPath,
      device,
      inode,
    })),
  })
  const owner: OwnerMarker = {
    schemaVersion: 1,
    operationID: input.operationID,
    phase: input.phase,
    checkID: input.checkID,
    identity,
  }
  writeFileSync(join(canonicalDirectory, markerName), JSON.stringify(owner), {
    flag: "wx",
    mode: 0o600,
  })
  const database = join(
    resources.find((item) => item.name === "database")!.realPath,
    "verification.sqlite",
  )
  const db = new Database(database)
  try {
    db.exec(`CREATE TABLE retained_verification_owner (
      operation_id TEXT NOT NULL, phase TEXT NOT NULL,
      check_id TEXT NOT NULL, identity TEXT NOT NULL
    );
    CREATE TABLE verification_witness (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
    db.query("INSERT INTO retained_verification_owner VALUES(?,?,?,?)").run(
      owner.operationID,
      owner.phase,
      owner.checkID,
      owner.identity,
    )
  } finally {
    db.close()
  }

  const environmentIdentity = fingerprint({
    base: retainedVerificationEnvironmentIdentity(),
    identity,
  })
  const resourceIdentities: RetainedProcedureResourceIdentity[] = resources.map(
    ({ name, realPath, device, inode }) => ({
      name: name as RetainedProcedureResourceIdentity["name"],
      realPath,
      device,
      inode,
    }),
  )
  const procedureBinding: RetainedProcedureBinding = {
    ...input.procedurePlan,
    projectDirectory,
    candidateWorkspace,
    candidateArtifact: input.candidateArtifact,
    projectIdentity,
    resourceIdentities,
    dependencyEnvironmentIdentity,
    dependencyLink,
    temporaryDirectoryLink,
  }
  return {
    schemaVersion: 1,
    operationID: input.operationID,
    phase: input.phase,
    checkID: input.checkID,
    directory: canonicalDirectory,
    originalWorkspace,
    candidateWorkspace,
    taskDatabase: realpathSync(input.taskDatabase),
    projectDirectory,
    projectIdentity,
    dependencyLink,
    identity,
    environmentIdentity,
    procedureBinding,
    resources,
    environment,
  }
}

/** Re-read ownership before a check; declarations and path strings alone are not evidence. */
export async function observeRetainedCheckContext(context: RetainedCheckContext): Promise<boolean> {
  try {
    if (realpathSync(context.directory) !== context.directory) return false
    const owner = JSON.parse(
      readFileSync(join(context.directory, markerName), "utf8"),
    ) as OwnerMarker
    if (
      owner.schemaVersion !== 1 ||
      owner.operationID !== context.operationID ||
      owner.phase !== context.phase ||
      owner.checkID !== context.checkID ||
      owner.identity !== context.identity
    )
      return false
    const procedureBinding = context.procedureBinding
    const plan: RetainedProcedurePlan = {
      schemaVersion: procedureBinding.schemaVersion,
      kind: procedureBinding.kind,
      commandFingerprint: procedureBinding.commandFingerprint,
      targets: procedureBinding.targets,
      projectScripts: procedureBinding.projectScripts,
      resources: procedureBinding.resources,
    }
    assertRetainedProcedureDeclaration(plan, context.candidateWorkspace)
    if (
      !assertRetainedProcedureBinding(procedureBinding, {
        plan,
        projectDirectory: context.projectDirectory,
        candidateWorkspace: context.candidateWorkspace,
        candidateArtifact: procedureBinding.candidateArtifact,
        projectIdentity: context.projectIdentity,
      }) ||
      retainedProjectIdentity(
        context.projectDirectory,
        context.candidateWorkspace,
        procedureBinding.candidateArtifact,
      ) !== context.projectIdentity
    )
      return false
    for (const resource of context.resources) {
      const info = statSync(resource.realPath)
      if (
        realpathSync(resource.path) !== resource.realPath ||
        !info.isDirectory() ||
        info.dev !== resource.device ||
        info.ino !== resource.inode
      )
        return false
      const bound = procedureBinding.resourceIdentities.find((item) => item.name === resource.name)
      if (
        !bound ||
        bound.realPath !== resource.realPath ||
        bound.device !== resource.device ||
        bound.inode !== resource.inode
      )
        return false
    }
    if (context.dependencyLink) {
      const link = lstatSync(context.dependencyLink.path)
      if (
        !link.isSymbolicLink() ||
        realpathSync(context.dependencyLink.path) !== context.dependencyLink.target ||
        context.dependencyLink.target !==
          context.resources.find((resource) => resource.name === "dependencies")?.realPath
      )
        return false
    } else {
      try {
        lstatSync(join(context.candidateWorkspace, "node_modules"))
        return false
      } catch {
        // No dependency mount was declared or created.
      }
    }
    const temporaryDirectory = context.resources.find((resource) => resource.name === "tmp")!
    const temporaryDirectoryLink = procedureBinding.temporaryDirectoryLink
    if (temporaryDirectoryLink) {
      const link = lstatSync(temporaryDirectoryLink.path)
      if (
        !link.isSymbolicLink() ||
        link.dev !== temporaryDirectoryLink.device ||
        link.ino !== temporaryDirectoryLink.inode ||
        realpathSync(temporaryDirectoryLink.path) !== temporaryDirectory.realPath ||
        temporaryDirectoryLink.target !== temporaryDirectory.realPath ||
        context.environment.TMPDIR !== temporaryDirectoryLink.path ||
        context.environment.TMP !== temporaryDirectoryLink.path ||
        context.environment.TEMP !== temporaryDirectoryLink.path
      )
        return false
    } else if (
      context.environment.TMPDIR !== temporaryDirectory.realPath ||
      context.environment.TMP !== temporaryDirectory.realPath ||
      context.environment.TEMP !== temporaryDirectory.realPath
    )
      return false
    const dependencyRoot = context.resources.find(
      (resource) => resource.name === "dependencies",
    )!.realPath
    const candidateManifest = candidatePackageManifest(context.candidateWorkspace)
    if (candidateManifest)
      assertCandidateDependencySetup(
        context.candidateWorkspace,
        procedureBinding.candidateArtifact,
        candidateManifest,
      )
    await assertOwnedDependencyTree(dependencyRoot)
    await assertNoSymlinks(context.directory)
    const database = join(
      context.resources.find((item) => item.name === "database")!.realPath,
      "verification.sqlite",
    )
    const db = new Database(database, { readonly: true })
    try {
      const row = db
        .query<
          {
            operation_id: string
            phase: string
            check_id: string
            identity: string
          },
          []
        >("SELECT * FROM retained_verification_owner")
        .get()
      return Boolean(
        row &&
        row.operation_id === context.operationID &&
        row.phase === context.phase &&
        row.check_id === context.checkID &&
        row.identity === context.identity,
      )
    } finally {
      db.close()
    }
  } catch {
    return false
  }
}

export function retainedCheckIsolationWitness(context: RetainedCheckContext) {
  return {
    schemaVersion: 1 as const,
    operationID: context.operationID,
    phase: context.phase,
    checkID: context.checkID,
    originalWorkspace: context.originalWorkspace,
    candidateWorkspace: context.candidateWorkspace,
    taskDatabase: context.taskDatabase,
    contextIdentity: context.identity,
    environmentIdentity: context.environmentIdentity,
    procedureBinding: context.procedureBinding,
    resources: context.resources.map(({ name, realPath, device, inode }) => ({
      name,
      realPath,
      device,
      inode,
      identity: createHash("sha256").update(`${device}:${inode}:${realPath}`).digest("hex"),
    })),
    sqlitePath: context.environment.LAZERS_VERIFICATION_SQLITE,
  }
}

/** Remove a setup that failed before a complete context witness was returned. */
export async function removeRetainedCheckSetupResources(input: {
  rootDirectory: string
  resource: RetainedCheckSetupResource
  candidateWorkspace: string
  dependencyLink?: RetainedCheckSetupLink
  temporaryDirectoryLink?: RetainedCheckSetupLink
}): Promise<void> {
  const root = realpathSync(input.rootDirectory)
  const setupPath = input.resource.path
  const setupRelativePath = relative(root, setupPath)
  if (
    !setupRelativePath ||
    setupRelativePath === "." ||
    setupRelativePath === ".." ||
    setupRelativePath.startsWith(`..${sep}`) ||
    setupRelativePath.includes(sep) ||
    input.resource.realPath !== setupPath
  )
    throw new Error("Verification setup ownership path is not a direct child of its private root")

  if (
    (input.dependencyLink &&
      (input.dependencyLink.path !== join(realpathSync(input.candidateWorkspace), "node_modules") ||
        input.dependencyLink.target !== join(setupPath, "dependencies"))) ||
    (input.temporaryDirectoryLink && input.temporaryDirectoryLink.target !== join(setupPath, "tmp"))
  )
    throw new Error("Verification setup link binding changed; preserve the partial context")

  const removeOwnedLink = (link: RetainedCheckSetupLink) => {
    if (!pathContains(setupPath, link.target))
      throw new Error("Verification setup link points outside its owned partial context")
    const info = lstatIfPresent(link.path)
    if (!info) return
    if (!info.isSymbolicLink() || info.dev !== link.device || info.ino !== link.inode)
      throw new Error("Verification setup link ownership changed; preserve the resource")
    if (realpathSync(link.path) !== link.target)
      throw new Error("Verification setup link target changed; preserve the resource")
    unlinkSync(link.path)
  }

  if (
    !input.dependencyLink &&
    lstatIfPresent(join(realpathSync(input.candidateWorkspace), "node_modules"))
  )
    throw new Error(
      "Verification dependency link has no persisted ownership witness; preserve the resource",
    )
  if (input.dependencyLink) removeOwnedLink(input.dependencyLink)
  if (input.temporaryDirectoryLink) removeOwnedLink(input.temporaryDirectoryLink)

  const info = lstatIfPresent(setupPath)
  if (!info) return
  if (
    input.resource.device < 0 ||
    input.resource.inode < 0 ||
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    info.dev !== input.resource.device ||
    info.ino !== input.resource.inode ||
    realpathSync(setupPath) !== setupPath
  )
    throw new Error("Verification setup directory ownership changed; preserve the resource")
  await rm(setupPath, { recursive: true, force: false })
  if (lstatIfPresent(setupPath))
    throw new Error("Verification setup directory remains after cleanup")
}

/** Non-forced, ownership-checked teardown. Unknown entries are never followed. */
export async function removeRetainedCheckContext(context: RetainedCheckContext): Promise<void> {
  if (!(await observeRetainedCheckContext(context)))
    throw new Error("Verification resource ownership changed; preserve the context")
  if (context.dependencyLink) unlinkSync(context.dependencyLink.path)
  if (context.procedureBinding.temporaryDirectoryLink)
    unlinkSync(context.procedureBinding.temporaryDirectoryLink.path)
  await assertNoSymlinks(context.directory)
  await rm(context.directory, { recursive: true, force: false })
}

export async function observeRetainedCheckIsolationWitness(
  contextPath: string,
  witness: unknown,
  expected: {
    operationID: string
    phase: "task" | "combined"
    checkID: string
    originalWorkspace: string
    candidateWorkspace: string
    taskDatabase: string
    projectDirectory: string
    candidateArtifact: string
    projectIdentity: string
    procedurePlan: RetainedProcedurePlan
  },
): Promise<boolean> {
  try {
    if (typeof witness !== "object" || witness === null || Array.isArray(witness)) return false
    const record = witness as Record<string, unknown>
    if (
      record.schemaVersion !== 1 ||
      record.operationID !== expected.operationID ||
      record.phase !== expected.phase ||
      record.checkID !== expected.checkID ||
      record.originalWorkspace !== realpathSync(expected.originalWorkspace) ||
      record.candidateWorkspace !== realpathSync(expected.candidateWorkspace) ||
      record.taskDatabase !== realpathSync(expected.taskDatabase) ||
      typeof record.contextIdentity !== "string" ||
      !Array.isArray(record.resources) ||
      record.resources.length !== resourceNames.length ||
      pathContains(record.originalWorkspace as string, record.candidateWorkspace as string) ||
      pathContains(record.candidateWorkspace as string, record.originalWorkspace as string)
    ) {
      return false
    }
    const procedureBinding = record.procedureBinding
    assertRetainedProcedureDeclaration(expected.procedurePlan, expected.candidateWorkspace)
    if (
      !assertRetainedProcedureBinding(procedureBinding, {
        plan: expected.procedurePlan,
        projectDirectory: expected.projectDirectory,
        candidateWorkspace: expected.candidateWorkspace,
        candidateArtifact: expected.candidateArtifact,
        projectIdentity: expected.projectIdentity,
      })
    ) {
      return false
    }
    if (
      retainedProjectIdentity(
        expected.projectDirectory,
        expected.candidateWorkspace,
        expected.candidateArtifact,
      ) !== expected.projectIdentity
    ) {
      return false
    }
    const root = realpathSync(contextPath)
    if (root !== contextPath) {
      return false
    }
    const marker = JSON.parse(readFileSync(join(root, markerName), "utf8")) as OwnerMarker
    if (
      marker.operationID !== expected.operationID ||
      marker.phase !== expected.phase ||
      marker.checkID !== expected.checkID ||
      marker.identity !== record.contextIdentity
    ) {
      return false
    }
    const external = [
      record.originalWorkspace,
      record.candidateWorkspace,
      record.taskDatabase,
      expected.projectDirectory,
    ].filter((value): value is string => typeof value === "string")
    const identities = new Set<string>()
    const names = new Set<string>()
    for (const value of record.resources) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false
      }
      const resource = value as Record<string, unknown>
      if (
        typeof resource.name !== "string" ||
        typeof resource.realPath !== "string" ||
        typeof resource.device !== "number" ||
        typeof resource.inode !== "number" ||
        typeof resource.identity !== "string"
      ) {
        return false
      }
      if (
        !resourceNames.includes(resource.name as (typeof resourceNames)[number]) ||
        names.has(resource.name)
      ) {
        return false
      }
      names.add(resource.name)
      const bound = procedureBinding.resourceIdentities.find((item) => item.name === resource.name)
      if (
        !bound ||
        bound.realPath !== resource.realPath ||
        bound.device !== resource.device ||
        bound.inode !== resource.inode
      ) {
        return false
      }
      const path = join(root, resource.name)
      const realPath = realpathSync(path)
      const info = statSync(realPath)
      if (
        realPath !== resource.realPath ||
        !info.isDirectory() ||
        !pathContains(root, realPath) ||
        info.dev !== resource.device ||
        info.ino !== resource.inode ||
        resource.identity !==
          createHash("sha256").update(`${info.dev}:${info.ino}:${realPath}`).digest("hex") ||
        external.some(
          (pathValue) => pathContains(pathValue, realPath) || pathContains(realPath, pathValue),
        ) ||
        identities.has(`${info.dev}:${info.ino}`)
      ) {
        return false
      }
      identities.add(`${info.dev}:${info.ino}`)
    }
    if (names.size !== resourceNames.length) {
      return false
    }
    const candidateManifest = candidatePackageManifest(expected.candidateWorkspace)
    if (candidateManifest)
      assertCandidateDependencySetup(
        expected.candidateWorkspace,
        expected.candidateArtifact,
        candidateManifest,
      )
    await assertOwnedDependencyTree(join(root, "dependencies"))
    if (
      candidateDependencyEnvironmentIdentity(
        join(root, "dependencies"),
        candidateManifest,
        expected.candidateWorkspace,
      ) !== procedureBinding.dependencyEnvironmentIdentity
    ) {
      return false
    }
    await assertNoSymlinks(root)
    if (procedureBinding.dependencyLink) {
      const dependencyPath = join(record.candidateWorkspace as string, "node_modules")
      const dependencyResource = join(root, "dependencies")
      if (
        procedureBinding.dependencyLink.path !== dependencyPath ||
        procedureBinding.dependencyLink.target !== dependencyResource ||
        realpathSync(dependencyPath) !== dependencyResource ||
        !lstatSync(dependencyPath).isSymbolicLink()
      ) {
        return false
      }
    } else {
      try {
        lstatSync(join(expected.candidateWorkspace, "node_modules"))
        return false
      } catch {
        // No candidate dependency mount was declared.
      }
    }
    if (procedureBinding.temporaryDirectoryLink) {
      const temporaryDirectory = procedureBinding.resourceIdentities.find(
        (resource) => resource.name === "tmp",
      )
      const link = lstatSync(procedureBinding.temporaryDirectoryLink.path)
      if (
        !temporaryDirectory ||
        !link.isSymbolicLink() ||
        link.dev !== procedureBinding.temporaryDirectoryLink.device ||
        link.ino !== procedureBinding.temporaryDirectoryLink.inode ||
        procedureBinding.temporaryDirectoryLink.target !== temporaryDirectory.realPath ||
        realpathSync(procedureBinding.temporaryDirectoryLink.path) !== temporaryDirectory.realPath
      ) {
        return false
      }
    }
    const databasePath = record.sqlitePath
    const expectedDatabase = join(root, "database", "verification.sqlite")
    if (
      typeof databasePath !== "string" ||
      databasePath !== expectedDatabase ||
      realpathSync(join(root, "database")) !== join(root, "database") ||
      pathContains(expected.originalWorkspace, databasePath) ||
      pathContains(expected.candidateWorkspace, databasePath)
    ) {
      return false
    }
    const db = new Database(databasePath, { readonly: true })
    try {
      const owner = db
        .query<
          {
            operation_id: string
            phase: string
            check_id: string
            identity: string
          },
          []
        >("SELECT * FROM retained_verification_owner")
        .get()
      return Boolean(
        owner &&
        owner.operation_id === expected.operationID &&
        owner.phase === expected.phase &&
        owner.check_id === expected.checkID &&
        owner.identity === record.contextIdentity,
      )
    } finally {
      db.close()
    }
  } catch {
    return false
  }
}

export async function removeRetainedCheckContextFromWitness(
  contextPath: string,
  witness: unknown,
  expected: Parameters<typeof observeRetainedCheckIsolationWitness>[2],
): Promise<void> {
  if (!(await observeRetainedCheckIsolationWitness(contextPath, witness, expected)))
    throw new Error("Verification resource ownership changed; preserve the context")
  const binding = (witness as { procedureBinding: RetainedProcedureBinding }).procedureBinding
  if (binding.dependencyLink) unlinkSync(binding.dependencyLink.path)
  if (binding.temporaryDirectoryLink) unlinkSync(binding.temporaryDirectoryLink.path)
  await assertNoSymlinks(contextPath)
  await rm(contextPath, { recursive: true, force: false })
}
