import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join, relative, sep } from "node:path"
import { fingerprint } from "../../identity.ts"
import type { RetainedProcedureBinding } from "./procedure.ts"

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

const resourceNames = ["home", "tmp", "config", "data", "cache", "state", "database"] as const
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

function assertNoSymlinks(directory: string) {
  const pending = [directory]
  while (pending.length) {
    const current = pending.pop()!
    for (const entry of readdirSync(current)) {
      const child = join(current, entry)
      const info = lstatSync(child)
      if (info.isSymbolicLink()) throw new Error("Verification resource contains a symbolic link")
      if (info.isDirectory()) pending.push(child)
      else if (!info.isFile()) throw new Error("Verification resource contains a non-regular entry")
    }
  }
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
  priorResourcePaths: string[]
  procedureBinding: RetainedProcedureBinding
}): RetainedCheckContext {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(input.checkID))
    throw new Error("Verification check ID is not a safe resource identity")
  const root = realpathSync(input.rootDirectory)
  const originalWorkspace = realpathSync(input.originalWorkspace)
  const candidateWorkspace = realpathSync(input.candidateWorkspace)
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

  const external = [
    originalWorkspace,
    candidateWorkspace,
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
    procedureBinding: input.procedureBinding,
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
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: byName.home!,
    TMPDIR: byName.tmp!,
    TMP: byName.tmp!,
    TEMP: byName.tmp!,
    XDG_CONFIG_HOME: byName.config!,
    XDG_DATA_HOME: byName.data!,
    XDG_CACHE_HOME: byName.cache!,
    XDG_STATE_HOME: byName.state!,
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
    identity,
    environmentIdentity,
    procedureBinding: input.procedureBinding,
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
    for (const resource of context.resources) {
      const info = statSync(resource.realPath)
      if (
        realpathSync(resource.path) !== resource.realPath ||
        !info.isDirectory() ||
        info.dev !== resource.device ||
        info.ino !== resource.inode
      )
        return false
    }
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
  assertNoSymlinks(context.directory)
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
    procedureBinding: RetainedProcedureBinding
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
      fingerprint(record.procedureBinding) !== fingerprint(expected.procedureBinding) ||
      record.originalWorkspace !== realpathSync(expected.originalWorkspace) ||
      record.candidateWorkspace !== realpathSync(expected.candidateWorkspace) ||
      record.taskDatabase !== realpathSync(expected.taskDatabase) ||
      typeof record.contextIdentity !== "string" ||
      !Array.isArray(record.resources) ||
      record.resources.length !== resourceNames.length ||
      pathContains(record.originalWorkspace as string, record.candidateWorkspace as string) ||
      pathContains(record.candidateWorkspace as string, record.originalWorkspace as string)
    )
      return false
    const procedureBinding = record.procedureBinding
    if (
      typeof procedureBinding !== "object" ||
      procedureBinding === null ||
      (procedureBinding as RetainedProcedureBinding).schemaVersion !== 1 ||
      !["read-only", "owned-shell-resources", "private-sqlite-smoke"].includes(
        (procedureBinding as RetainedProcedureBinding).kind,
      ) ||
      typeof (procedureBinding as RetainedProcedureBinding).commandFingerprint !== "string" ||
      !Array.isArray((procedureBinding as RetainedProcedureBinding).resources)
    )
      return false
    const root = realpathSync(contextPath)
    if (root !== contextPath) return false
    const marker = JSON.parse(readFileSync(join(root, markerName), "utf8")) as OwnerMarker
    if (
      marker.operationID !== expected.operationID ||
      marker.generation !== expected.generation ||
      marker.phase !== expected.phase ||
      marker.checkID !== expected.checkID ||
      marker.identity !== record.contextIdentity
    )
      return false
    const external = [
      record.originalWorkspace,
      record.candidateWorkspace,
      record.taskDatabase,
    ].filter((value): value is string => typeof value === "string")
    const identities = new Set<string>()
    const names = new Set<string>()
    for (const value of record.resources) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false
      const resource = value as Record<string, unknown>
      if (
        typeof resource.name !== "string" ||
        typeof resource.realPath !== "string" ||
        typeof resource.device !== "number" ||
        typeof resource.inode !== "number" ||
        typeof resource.identity !== "string"
      )
        return false
      if (
        !resourceNames.includes(resource.name as (typeof resourceNames)[number]) ||
        names.has(resource.name)
      )
        return false
      names.add(resource.name)
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
      )
        return false
      identities.add(`${info.dev}:${info.ino}`)
    }
    const databasePath = record.sqlitePath
    const expectedDatabase = join(root, "database", "verification.sqlite")
    if (
      typeof databasePath !== "string" ||
      databasePath !== expectedDatabase ||
      realpathSync(join(root, "database")) !== join(root, "database") ||
      pathContains(expected.originalWorkspace, databasePath) ||
      pathContains(expected.candidateWorkspace, databasePath)
    )
      return false
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
  assertNoSymlinks(contextPath)
  rmSync(contextPath, { recursive: true, force: false })
}

export function retainedResourcePaths(context: RetainedCheckContext): string[] {
  return context.resources.map((resource) => resource.realPath)
}
