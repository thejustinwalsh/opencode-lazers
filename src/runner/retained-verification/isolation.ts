import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import {
  copyFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
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
  generation: number
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

type OwnerMarker = {
  schemaVersion: 1
  operationID: string
  generation: number
  phase: "task" | "combined"
  checkID: string
  identity: string
}

const resourceNames = retainedProjectResourceNames
const markerName = ".lazers-retained-verification-owner.json"

export function retainedVerificationEnvironmentIdentity(): string {
  return fingerprint({
    bunRevision: Bun.revision,
    bunVersion: Bun.version,
    executable: process.execPath,
    platform: process.platform,
    architecture: process.arch,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
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

function assertNoSymlinks(directory: string, allowedLinksWithin?: string) {
  const pending = [directory]
  while (pending.length) {
    const current = pending.pop()!
    for (const entry of readdirSync(current)) {
      const child = join(current, entry)
      const info = lstatSync(child)
      if (info.isSymbolicLink()) {
        if (!allowedLinksWithin || !pathContains(allowedLinksWithin, realpathSync(child)))
          throw new Error(
            "Verification resource contains a symbolic link outside its owned project dependency tree",
          )
        continue
      }
      if (info.isDirectory()) pending.push(child)
      else if (!info.isFile()) throw new Error("Verification resource contains a non-regular entry")
    }
  }
}

function assertOwnedDependencyTree(directory: string): void {
  const root = realpathSync(directory)
  const pending = [root]
  while (pending.length) {
    const current = pending.pop()!
    for (const entry of readdirSync(current)) {
      const child = join(current, entry)
      const info = lstatSync(child)
      if (info.isSymbolicLink()) {
        let target: string
        try {
          target = realpathSync(child)
        } catch {
          throw new Error("Project dependency snapshot contains a dangling symbolic link")
        }
        if (!pathContains(root, target))
          throw new Error("Project dependency snapshot links to a shared external resource")
      } else if (info.isDirectory()) pending.push(child)
      else if (!info.isFile())
        throw new Error("Project dependency snapshot contains a non-regular entry")
    }
  }
}

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const

const dependencyLockFiles = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
] as const

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
        typeof specification !== "string"
      )
        throw new Error(`Candidate dependency ${name} cannot be safely resolved in isolation`)
      dependencies.push([name, specification])
    }
  }
  return dependencies.sort(([a], [b]) => a.localeCompare(b))
}

function candidateDependencyEnvironmentIdentity(
  dependencyRoot: string,
  manifest: Record<string, unknown> | undefined,
): string {
  const root = realpathSync(dependencyRoot)
  const installed = (manifest ? candidateDependencySpecs(manifest) : []).map(
    ([name, specification]) => {
      const packageJSON = join(root, ...name.split("/"), "package.json")
      if (!existsSync(packageJSON))
        throw new Error(
          `Candidate dependency environment cannot be isolated: ${name}@${specification} is absent from the private snapshot`,
        )
      const resolved = realpathSync(packageJSON)
      if (!pathContains(root, resolved) || !lstatSync(resolved).isFile())
        throw new Error(
          `Candidate dependency environment cannot be isolated: ${name}@${specification} escapes its private snapshot`,
        )
      const contents = readFileSync(resolved)
      const value: unknown = JSON.parse(contents.toString("utf8"))
      const version =
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as { version?: unknown }).version
          : undefined
      let satisfies = false
      try {
        satisfies = typeof version === "string" && Bun.semver.satisfies(version, specification)
      } catch {
        // Unsupported protocols/ranges are a concrete missing candidate environment.
      }
      if (!satisfies)
        throw new Error(
          `Candidate dependency environment cannot be isolated: private ${name}@${String(version ?? "unknown")} does not satisfy ${specification}`,
        )
      return { name, specification, version, manifest: contents.toString("base64") }
    },
  )
  return fingerprint({ schemaVersion: 1, root, installed })
}

function assertCandidateDependencyEnvironment(
  projectDirectory: string,
  candidateWorkspace: string,
  dependencySource: string,
  manifest: Record<string, unknown>,
): void {
  for (const name of dependencyLockFiles) {
    const projectPath = join(projectDirectory, name)
    const candidatePath = join(candidateWorkspace, name)
    const projectInfo = lstatIfPresent(projectPath)
    const candidateInfo = lstatIfPresent(candidatePath)
    const projectExists = projectInfo !== undefined
    const candidateExists = candidateInfo !== undefined
    if (projectExists !== candidateExists)
      throw new Error(
        `Candidate dependency environment cannot be isolated: ${name} differs from the installed project lock state`,
      )
    if (!projectInfo || !candidateInfo) continue
    if (
      projectInfo.isSymbolicLink() ||
      candidateInfo.isSymbolicLink() ||
      !projectInfo.isFile() ||
      !candidateInfo.isFile() ||
      !readFileSync(projectPath).equals(readFileSync(candidatePath))
    )
      throw new Error(
        `Candidate dependency environment cannot be isolated: ${name} does not match the installed project lock`,
      )
  }

  for (const [name, specification] of candidateDependencySpecs(manifest)) {
    const packageJSON = join(dependencySource, ...name.split("/"), "package.json")
    if (!existsSync(packageJSON))
      throw new Error(
        `Candidate dependency environment cannot be isolated: ${name}@${specification} is not installed`,
      )
    let installed: unknown
    try {
      const path = realpathSync(packageJSON)
      if (!pathContains(realpathSync(dependencySource), path))
        throw new Error("dependency manifest resolves outside its installed project tree")
      installed = JSON.parse(readFileSync(path, "utf8"))
    } catch {
      throw new Error(
        `Candidate dependency environment cannot be isolated: ${name}@${specification} has no readable installed manifest`,
      )
    }
    const version =
      typeof installed === "object" && installed !== null && !Array.isArray(installed)
        ? (installed as { version?: unknown }).version
        : undefined
    let satisfies = false
    try {
      satisfies = typeof version === "string" && Bun.semver.satisfies(version, specification)
    } catch {
      // Unsupported protocols/ranges are a concrete inability to use this environment.
    }
    if (!satisfies)
      throw new Error(
        `Candidate dependency environment cannot be isolated: installed ${name}@${String(version ?? "unknown")} does not satisfy ${specification}`,
      )
  }
}

function temporaryDirectoryAlias(input: {
  operationID: string
  generation: number
  phase: "task" | "combined"
  checkID: string
  target: string
}): RetainedProcedureBinding["temporaryDirectoryLink"] {
  if (process.platform === "win32") return null
  const aliasRoot = "/tmp"
  const targetLength = tmpdir().length
  const prefix = `lazers-${fingerprint({
    operationID: input.operationID,
    generation: input.generation,
    phase: input.phase,
    checkID: input.checkID,
  }).slice(0, 32)}`
  const nameLength = targetLength - aliasRoot.length - 1
  if (nameLength < prefix.length || nameLength > 255 || !existsSync(aliasRoot)) return null
  const path = join(aliasRoot, prefix + "x".repeat(nameLength - prefix.length))
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
  symlinkSync(input.target, path, "dir")
  const info = lstatSync(path)
  if (!info.isSymbolicLink() || realpathSync(path) !== input.target) {
    unlinkSync(path)
    throw new Error("Temporary resource alias does not resolve to its owned directory")
  }
  return { path, target: input.target, device: info.dev, inode: info.ino }
}

function cloneDependencyTree(sourceInput: string, destination: string): void {
  const source = realpathSync(sourceInput)
  const rootInfo = lstatSync(source)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error("Project dependency source is not a real directory")
  if (readdirSync(destination).length)
    throw new Error("Project dependency resource is not empty before snapshot")

  const copyDirectory = (sourceDirectory: string, destinationDirectory: string): void => {
    for (const entry of readdirSync(sourceDirectory)) {
      if (sourceDirectory === source && [".cache", ".vite"].includes(entry)) continue
      const sourcePath = join(sourceDirectory, entry)
      const destinationPath = join(destinationDirectory, entry)
      const info = lstatSync(sourcePath)
      if (info.isSymbolicLink()) {
        let target: string
        try {
          target = realpathSync(sourcePath)
        } catch {
          throw new Error("Project dependency source contains a dangling symbolic link")
        }
        if (!pathContains(source, target))
          throw new Error("Project dependency source links to a shared external resource")
        const link = readlinkSync(sourcePath)
        const targetPath = isAbsolute(link)
          ? join(destination, relative(source, target))
          : resolve(dirname(sourcePath), link)
        const clonedLink = isAbsolute(link) ? relative(dirname(destinationPath), targetPath) : link
        symlinkSync(clonedLink, destinationPath)
      } else if (info.isDirectory()) {
        mkdirSync(destinationPath, { mode: info.mode & 0o777 })
        copyDirectory(sourcePath, destinationPath)
      } else if (info.isFile()) {
        copyFileSync(sourcePath, destinationPath, constants.COPYFILE_FICLONE)
        chmodSync(destinationPath, info.mode & 0o777)
      } else {
        throw new Error("Project dependency source contains a non-regular entry")
      }
    }
  }
  copyDirectory(source, destination)
  const resolverRoot = join(destination, "node_modules")
  try {
    lstatSync(resolverRoot)
    throw new Error(
      "Project dependency snapshot already uses its reserved node_modules resolver path",
    )
  } catch (error) {
    if (!(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error
  }
  // Bun's test runner and Node resolve peer imports from real package paths.
  // The candidate mount points here, so give canonicalized package paths the
  // same node_modules ancestor that the source project had.
  symlinkSync(".", resolverRoot, "dir")
  assertOwnedDependencyTree(destination)
}

/** Allocate only runtime-owned, operation-specific writable check resources. */
export function createRetainedCheckContext(input: {
  rootDirectory: string
  operationID: string
  generation: number
  phase: "task" | "combined"
  checkID: string
  originalWorkspace: string
  candidateWorkspace: string
  taskDatabase: string
  projectDirectory: string
  candidateArtifact: string
  priorResourcePaths: string[]
  procedurePlan: RetainedProcedurePlan
}): RetainedCheckContext {
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
  const directory = join(
    root,
    `retained-${input.operationID}-${input.generation}`,
    input.phase,
    input.checkID,
  )
  if (existsSync(directory))
    throw new Error("Retained verification resources already exist; ownership is uncertain")
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const canonicalDirectory = realpathSync(directory)
  if (canonicalDirectory !== directory || !pathContains(root, canonicalDirectory))
    throw new Error("Verification resources escaped the runtime-owned resource root")

  const resources: RetainedCheckContext["resources"] = []
  for (const name of resourceNames) {
    const path = join(canonicalDirectory, name)
    mkdirSync(path, { mode: 0o700 })
    const realPath = realpathSync(path)
    const info = statSync(realPath)
    if (realPath !== path || !info.isDirectory())
      throw new Error(`Verification resource ${name} is not a canonical owned directory`)
    resources.push({ name, path, realPath, device: info.dev, inode: info.ino })
  }

  const candidateManifest = candidatePackageManifest(candidateWorkspace)
  const dependencySource = join(projectDirectory, "node_modules")
  const candidateDependencies = join(candidateWorkspace, "node_modules")
  let dependencyLink: RetainedCheckContext["dependencyLink"] = null
  if (candidateManifest) {
    if (
      existsSync(candidateDependencies) ||
      (() => {
        try {
          lstatSync(candidateDependencies)
          return true
        } catch {
          return false
        }
      })()
    )
      throw new Error("Candidate checkout already contains an unowned node_modules resource")
    const declaredDependencies = candidateDependencySpecs(candidateManifest)
    let dependencySourcePath: string | undefined
    if (declaredDependencies.length) {
      if (!existsSync(dependencySource))
        throw new Error(
          `Candidate dependency environment cannot be isolated: ${declaredDependencies[0]![0]} is not installed`,
        )
      if (lstatSync(dependencySource).isSymbolicLink())
        throw new Error(
          "Candidate dependency environment cannot be isolated from a shared symbolic link",
        )
      assertCandidateDependencyEnvironment(
        projectDirectory,
        candidateWorkspace,
        dependencySource,
        candidateManifest,
      )
      dependencySourcePath = dependencySource
    }
    const dependencyResource = resources.find((resource) => resource.name === "dependencies")!
    if (dependencySourcePath) cloneDependencyTree(dependencySourcePath, dependencyResource.realPath)
    else {
      symlinkSync(".", join(dependencyResource.realPath, "node_modules"), "dir")
      assertOwnedDependencyTree(dependencyResource.realPath)
    }
    const link = relative(candidateWorkspace, dependencyResource.realPath)
    symlinkSync(link, candidateDependencies, "dir")
    if (realpathSync(candidateDependencies) !== dependencyResource.realPath)
      throw new Error("Candidate dependency link does not resolve to its owned resource")
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
  const temporaryDirectoryLink = temporaryDirectoryAlias({
    operationID: input.operationID,
    generation: input.generation,
    phase: input.phase,
    checkID: input.checkID,
    target: temporaryDirectoryResource.realPath,
  })
  const dependencyEnvironmentIdentity = candidateDependencyEnvironmentIdentity(
    resources.find((resource) => resource.name === "dependencies")!.realPath,
    candidateManifest,
  )

  const identity = fingerprint({
    schemaVersion: 1,
    operationID: input.operationID,
    generation: input.generation,
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
    generation: input.generation,
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
      operation_id TEXT NOT NULL, generation INTEGER NOT NULL, phase TEXT NOT NULL,
      check_id TEXT NOT NULL, identity TEXT NOT NULL
    );
    CREATE TABLE verification_witness (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
    db.query("INSERT INTO retained_verification_owner VALUES(?,?,?,?,?)").run(
      owner.operationID,
      owner.generation,
      owner.phase,
      owner.checkID,
      owner.identity,
    )
  } finally {
    db.close()
  }

  const byName = Object.fromEntries(resources.map((resource) => [resource.name, resource.realPath]))
  const npmCache = join(byName.cache!, "npm")
  mkdirSync(npmCache, { mode: 0o700 })
  const globalGitConfig = join(byName.config!, "gitconfig")
  writeFileSync(globalGitConfig, "", { flag: "wx", mode: 0o600 })
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: byName.home!,
    TMPDIR: temporaryDirectoryLink?.path ?? byName.tmp!,
    TMP: temporaryDirectoryLink?.path ?? byName.tmp!,
    TEMP: temporaryDirectoryLink?.path ?? byName.tmp!,
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
    LAZERS_VERIFICATION_SQLITE: database,
    LANG: process.env.LANG ?? "C.UTF-8",
    ...(process.env.LC_ALL === undefined ? {} : { LC_ALL: process.env.LC_ALL }),
    ...(process.env.TZ === undefined ? {} : { TZ: process.env.TZ }),
    ...(process.env.CI === undefined ? {} : { CI: process.env.CI }),
    GIT_TERMINAL_PROMPT: "0",
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
    generation: input.generation,
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
export function observeRetainedCheckContext(context: RetainedCheckContext): boolean {
  try {
    if (realpathSync(context.directory) !== context.directory) return false
    const owner = JSON.parse(
      readFileSync(join(context.directory, markerName), "utf8"),
    ) as OwnerMarker
    if (
      owner.schemaVersion !== 1 ||
      owner.operationID !== context.operationID ||
      owner.generation !== context.generation ||
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
    assertOwnedDependencyTree(dependencyRoot)
    if (
      candidateDependencyEnvironmentIdentity(
        dependencyRoot,
        candidatePackageManifest(context.candidateWorkspace),
      ) !== procedureBinding.dependencyEnvironmentIdentity
    )
      return false
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
            generation: number
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
        row.generation === context.generation &&
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
    generation: context.generation,
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

/** Non-forced, ownership-checked teardown. Unknown entries are never followed. */
export function removeRetainedCheckContext(context: RetainedCheckContext): void {
  if (!observeRetainedCheckContext(context))
    throw new Error("Verification resource ownership changed; preserve the context")
  if (context.dependencyLink) unlinkSync(context.dependencyLink.path)
  if (context.procedureBinding.temporaryDirectoryLink)
    unlinkSync(context.procedureBinding.temporaryDirectoryLink.path)
  assertNoSymlinks(
    context.directory,
    context.resources.find((resource) => resource.name === "dependencies")!.realPath,
  )
  rmSync(context.directory, { recursive: true, force: false })
}

export function observeRetainedCheckIsolationWitness(
  contextPath: string,
  witness: unknown,
  expected: {
    operationID: string
    generation: number
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
): boolean {
  try {
    if (typeof witness !== "object" || witness === null || Array.isArray(witness)) return false
    const record = witness as Record<string, unknown>
    if (
      record.schemaVersion !== 1 ||
      record.operationID !== expected.operationID ||
      record.generation !== expected.generation ||
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
      marker.generation !== expected.generation ||
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
    assertOwnedDependencyTree(join(root, "dependencies"))
    if (
      candidateDependencyEnvironmentIdentity(
        join(root, "dependencies"),
        candidatePackageManifest(expected.candidateWorkspace),
      ) !== procedureBinding.dependencyEnvironmentIdentity
    ) {
      return false
    }
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
            generation: number
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
        owner.generation === expected.generation &&
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

export function removeRetainedCheckContextFromWitness(
  contextPath: string,
  witness: unknown,
  expected: Parameters<typeof observeRetainedCheckIsolationWitness>[2],
): void {
  if (!observeRetainedCheckIsolationWitness(contextPath, witness, expected))
    throw new Error("Verification resource ownership changed; preserve the context")
  const binding = (witness as { procedureBinding: RetainedProcedureBinding }).procedureBinding
  if (binding.dependencyLink) unlinkSync(binding.dependencyLink.path)
  if (binding.temporaryDirectoryLink) unlinkSync(binding.temporaryDirectoryLink.path)
  assertNoSymlinks(contextPath, join(contextPath, "dependencies"))
  rmSync(contextPath, { recursive: true, force: false })
}

export function retainedResourcePaths(context: RetainedCheckContext): string[] {
  return context.resources.map((resource) => resource.realPath)
}
