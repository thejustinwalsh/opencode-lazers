import { execFile, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  constants,
  fstatSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  openSync,
  closeSync,
  mkdirSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { canonical } from "../identity.ts"
import { checkEnvironment, checkSucceeded } from "./checks.ts"
import { recognizedVerificationPhases } from "./quality-failure.ts"
import {
  DEFAULT_VERIFICATION_HARD_TIMEOUT_MS,
  DEFAULT_VERIFICATION_INACTIVITY_TIMEOUT_MS,
} from "./verification-timeout.ts"
import type { VerificationDeadlineReceipt } from "./verification-timeout.ts"
import type { TaskProposal } from "../task.ts"

const execFileAsync = promisify(execFile)

type ExecutableVerificationCheck = Omit<TaskProposal["verification"][number], "timeoutMs"> & {
  timeoutMs?: number
}

/** Repository-size observations must not block the scheduler and RPC event loop. */
export async function gitAsync(
  directory: string,
  args: string[],
  input?: string,
  environment: Record<string, string> = {},
): Promise<string> {
  try {
    const running = execFileAsync("git", args, {
      cwd: directory,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...environment },
    })
    running.child.stdin?.end(input)
    const result = await running
    return result.stdout.trimEnd()
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr
        : ""
    const stdout =
      error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string"
        ? error.stdout
        : ""
    throw new Error(
      `git ${args[0]} failed: ${(stderr || stdout || (error instanceof Error ? error.message : "unknown")).slice(0, 2000)}`,
      { cause: error },
    )
  }
}

export function git(
  directory: string,
  args: string[],
  input?: string,
  environment: Record<string, string> = {},
): string {
  const result = spawnSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    input,
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...environment },
  })
  if (result.status !== 0)
    throw new Error(
      `git ${args[0]} failed: ${(result.stderr || result.error?.message || "unknown").slice(0, 2000)}`,
    )
  return result.stdout.trimEnd()
}

/** Distinguish a normal non-ancestor result from an unavailable Git observation. */
export function commitIsAncestor(directory: string, ancestor: string, descendant: string): boolean {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: directory,
    timeout: 30000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })
  if (result.status === 0) return true
  if (result.status === 1) return false
  const stderr = result.stderr?.toString("utf8") ?? ""
  throw new Error(
    `git merge-base --is-ancestor failed: ${(stderr || result.error?.message || "unknown").slice(0, 2000)}`,
  )
}

/** Conservatively detects equal, wildcard-overlapping, and ancestor path scopes. */
export function scopePatternsConflict(left: string[], right: string[]): boolean {
  const prefix = (pattern: string) => {
    const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "")
    const wildcard = normalized.search(/[*?{}[\]!]/)
    return wildcard < 0 ? normalized : normalized.slice(0, wildcard)
  }
  return left.some((a) =>
    right.some((b) => {
      const aPrefix = prefix(a)
      const bPrefix = prefix(b)
      return !aPrefix || !bPrefix || aPrefix.startsWith(bPrefix) || bPrefix.startsWith(aPrefix)
    }),
  )
}

/** Merge branch artifacts in caller-supplied deterministic order without moving a checkout. */
export async function combineArtifacts(
  directory: string,
  base: string,
  artifacts: string[],
): Promise<string> {
  const isAncestor = (ancestor: string, descendant: string) => {
    try {
      git(directory, ["merge-base", "--is-ancestor", ancestor, descendant])
      return true
    } catch {
      return false
    }
  }
  let combined = base
  for (const artifact of artifacts) {
    if (artifact === combined || isAncestor(artifact, combined)) continue
    if (isAncestor(combined, artifact)) {
      combined = artifact
      continue
    }
    let merged: string
    try {
      merged = await gitAsync(directory, ["merge-tree", "--write-tree", combined, artifact])
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown"
      throw new Error(
        `Conflicting accepted artifacts ${combined} and ${artifact}: ${detail.slice(0, 1500)}`,
        { cause: error },
      )
    }
    const tree = merged.trim().split(/\s/, 1)[0]
    if (!tree || !/^[a-f0-9]{40,64}$/.test(tree))
      throw new Error("Git did not return a tree for combined artifacts")
    const fixedDate = "2000-01-01T00:00:00+00:00"
    combined = await gitAsync(
      directory,
      [
        "-c",
        "user.name=LAZERS",
        "-c",
        "user.email=runner@lazers.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit-tree",
        tree,
        "-p",
        combined,
        "-p",
        artifact,
      ],
      "LAZERS deterministic artifact integration\n",
      { GIT_AUTHOR_DATE: fixedDate, GIT_COMMITTER_DATE: fixedDate },
    )
  }
  return combined
}

function changedPathCommands(base: string) {
  return [
    ["diff", "--name-only", "--no-renames", "-z", base],
    ["diff", "--cached", "--name-only", "--no-renames", "-z", base],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ]
}

function collectChangedPaths(results: string[]): string[] {
  return [...new Set(results.flatMap((result) => result.split("\0")).filter(Boolean))].sort()
}

export function changedPaths(directory: string, base = "HEAD"): string[] {
  return collectChangedPaths(changedPathCommands(base).map((args) => git(directory, args)))
}

async function changedPathsAsync(directory: string, base = "HEAD"): Promise<string[]> {
  const results: string[] = []
  for (const args of changedPathCommands(base)) results.push(await gitAsync(directory, args))
  return collectChangedPaths(results)
}

/** Fingerprint the actual editable candidate bytes without staging or mutating them. */
export function workingTreeIdentity(directory: string, base: string): string {
  const hash = createHash("sha256")
  hash.update(base)
  for (const path of changedPaths(directory, base)) {
    hash.update("\0")
    hash.update(path)
    try {
      const info = lstatSync(join(directory, path))
      hash.update(`\0${info.mode}\0`)
      if (info.isSymbolicLink()) hash.update(readlinkSync(join(directory, path)))
      else if (info.isFile()) hash.update(readFileSync(join(directory, path)))
      else hash.update("unsupported-file-kind")
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        hash.update("deleted")
      else throw error
    }
  }
  return hash.digest("hex")
}

export function scopeViolations(paths: string[], scope: string[]): string[] {
  const patterns = scope.map((pattern) => new Bun.Glob(pattern))
  return paths.filter(
    (path) =>
      isAbsolute(path) ||
      path.split("/").includes("..") ||
      !patterns.some((pattern) => pattern.match(path)),
  )
}

export function artifactUnchanged(
  directory: string,
  commit: string,
  ownedUntrackedPaths: string[] = [],
): boolean {
  const result = spawnSync("git", ["diff", "--quiet", commit, "--"], {
    cwd: directory,
    timeout: 30000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })
  const allowed = new Set(ownedUntrackedPaths)
  const untracked = git(directory, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .filter((path) => !allowed.has(path))
  return result.status === 0 && untracked.length === 0
}

export class ArtifactScopeViolation extends Error {
  constructor(readonly paths: string[]) {
    super(`Out-of-scope changes: ${paths.slice(0, 20).join(", ")}`)
  }
}

function singleMergeBase(directory: string, left: string, right: string): string {
  const bases = git(directory, ["merge-base", "--all", left, right]).split(/\s+/).filter(Boolean)
  if (bases.length !== 1 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(bases[0] ?? ""))
    throw new Error(`Cannot safely determine a unique merge base for ${left} and ${right}`)
  return bases[0]!
}

async function mergedScopeTree(
  directory: string,
  base: string,
  incorporated: string,
): Promise<string> {
  // Check the merge base first: Git can synthesize one when the history is
  // criss-crossed, but that would make the scope exemption ambiguous.
  singleMergeBase(directory, base, incorporated)
  let merged: string
  try {
    merged = await gitAsync(directory, ["merge-tree", "--write-tree", base, incorporated])
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown"
    throw new Error(
      `Cannot safely construct a conflict-free reviewed artifact baseline: ${detail.slice(0, 1500)}`,
      { cause: error },
    )
  }
  const tree = merged.trim()
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree))
    throw new Error("Git did not return a tree for the reviewed artifact baseline")
  if (git(directory, ["cat-file", "-t", tree]) !== "tree")
    throw new Error("Git did not return a tree for the reviewed artifact baseline")
  return tree
}

/** Select the same reviewed comparison baseline used when an isolated artifact is verified. */
export async function reviewedScopeBase(
  directory: string,
  base: string,
  head: string,
  reviewedHead?: string,
): Promise<string> {
  let scopeBase = base
  if (reviewedHead) {
    const common = singleMergeBase(directory, head, reviewedHead)
    const baseRelation = singleMergeBase(directory, base, common)
    if (baseRelation === base) scopeBase = common
    else if (baseRelation !== common) scopeBase = await mergedScopeTree(directory, base, common)
  }
  return scopeBase
}

/** Only a private runtime-created worktree may be snapshotted. Never stages origin. */
export async function commitArtifact(
  directory: string,
  base: string,
  scope: string[],
  snapshot = true,
  reviewedHead?: string,
): Promise<{ commit: string; paths: string[]; identity: string; scopeBase: string }> {
  const head = git(directory, ["rev-parse", "HEAD"])
  git(directory, ["merge-base", "--is-ancestor", base, head])
  const scopeBase = await reviewedScopeBase(
    directory,
    base,
    head,
    snapshot ? reviewedHead : undefined,
  )
  const paths = await changedPathsAsync(directory, scopeBase)
  const violations = scopeViolations(paths, scope)
  if (violations.length) throw new ArtifactScopeViolation(violations)
  if ((await changedPathsAsync(directory)).length === 0)
    return { commit: head, paths, identity: head, scopeBase }
  if (!snapshot)
    throw new Error(
      "Commit task edits before verification; shared checkout was not staged by runtime",
    )
  await gitAsync(directory, ["add", "--all"])
  const tree = await gitAsync(directory, ["write-tree"])
  const commit = await gitAsync(
    directory,
    [
      "-c",
      "user.name=LAZERS",
      "-c",
      "user.email=runtime@lazers.invalid",
      "commit-tree",
      tree,
      "-p",
      head,
    ],
    "LAZERS verified candidate\n",
  )
  return { commit, paths, identity: commit, scopeBase }
}

export function artifactExists(directory: string, reference: string): boolean {
  if (
    !reference ||
    isAbsolute(reference) ||
    reference.startsWith("\\\\") ||
    reference.includes("://") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(reference)
  )
    return false
  const path = resolve(directory, reference)
  const within = relative(directory, path)
  if (within.startsWith("..") || isAbsolute(within)) return false
  try {
    let current = directory
    for (const part of within ? within.split(sep) : []) {
      current = join(current, part)
      if (lstatSync(current).isSymbolicLink()) return false
    }
    const leaf = lstatSync(path)
    if (leaf.isSymbolicLink()) return false
    if (leaf.isFile()) return readableRegularFile(path)
    return leaf.isDirectory() && hasReadableRegularFile(path)
  } catch {
    return false
  }
}

function readableRegularFile(path: string): boolean {
  let fd: number | undefined
  try {
    const candidate = lstatSync(path)
    if (candidate.isSymbolicLink() || !candidate.isFile()) return false
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    return fstatSync(fd).isFile()
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function hasReadableRegularFile(directory: string): boolean {
  const pending = [directory]
  while (pending.length) {
    const current = pending.pop()!
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(current, entry)
      let candidate: ReturnType<typeof lstatSync>
      try {
        candidate = lstatSync(path)
      } catch {
        continue
      }
      if (candidate.isSymbolicLink()) continue
      if (candidate.isDirectory()) pending.push(path)
      else if (candidate.isFile() && readableRegularFile(path)) return true
    }
  }
  return false
}

export type CheckReceipt = {
  id: string
  command: string
  cwd: string
  artifact: string
  inputIdentity: string
  environmentIdentity: string
  startedAt: number
  endedAt: number
  exitCode: number | null
  timedOut: boolean
  stopCause?: "inactivity" | "hard-backstop" | "cancelled" | null
  inactivityTimeoutMs?: number
  hardTimeoutMs?: number
  verificationDeadline?: VerificationDeadlineReceipt
  aborted?: boolean
  stdout: string
  stderr: string
  processCleanup?: {
    state: "settled" | "terminated" | "uncertain"
    capability: "process-group" | "windows-process-tree" | "direct-child"
    rootPID?: number
    detail?: string
  }
  /** Independently executed steps from a recognized `&&` quality chain. */
  phases?: CheckPhaseReceipt[]
  /** False when cleanup uncertainty prevented execution of every declared phase. */
  phasesComplete?: boolean
  preparation?: {
    inputFingerprint: string
    resultingFingerprint: string
    paths: string[]
    scope: string[]
  }
  /** Legacy diagnostic only; never establishes or invalidates a check. */
  unchanged?: boolean
  isolation?: unknown
}

export type CheckPhaseReceipt = {
  command: string
  exitCode: number | null
  timedOut: boolean
  stopCause?: "inactivity" | "hard-backstop" | "cancelled" | null
  aborted?: boolean
  stdout: string
  stderr: string
  environmentIdentity: string
  processCleanup?: CheckReceipt["processCleanup"]
}

export type CheckRunOptions = {
  /** When set, do not inherit the host environment. */
  environment?: Record<string, string>
  environmentIdentity?: string
  /** Bind preparation and comparison commands to a complete input snapshot. */
  inputIdentity?: string
  /** Exact untracked paths positively owned by this retained procedure binding. */
  ownedUntrackedPaths?: string[]
  isolation?: unknown
  signal?: AbortSignal
  /** Injectable native process-tree adapter, also used to exercise Windows semantics off-host. */
  processTreeAdapter?: WindowsProcessTreeAdapter
  /** Shared monotonic hard deadline for recognized multi-phase declarations. */
  hardDeadline?: number
  /** Shared inactivity deadline, reset only by real stdout/stderr progress. */
  inactivityDeadline?: { value: number }
}

export type WindowsProcessTreeAdapter = {
  hasDescendants(pid: number): Promise<boolean>
  terminate(pid: number): Promise<void>
}

const identityEnvironmentKeys = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "CI"] as const
const verificationEnvironment = () =>
  Object.fromEntries(
    identityEnvironmentKeys.flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  )

/** Stable, readable check-runtime metadata; module replacement is not an environment change. */
export function verificationEnvironmentIdentity(): string {
  return canonical({
    bunRevision: Bun.revision,
    bunVersion: Bun.version,
    executable: process.execPath,
    platform: process.platform,
    architecture: process.arch,
    environment: verificationEnvironment(),
  })
}
async function bounded(stream: ReadableStream<Uint8Array>, limit = 32768, onProgress?: () => void) {
  const reader = stream.getReader()
  let bytes = 0
  const chunks: Uint8Array[] = []
  while (true) {
    const part = await reader.read()
    if (part.done) break
    if (part.value.byteLength > 0) onProgress?.()
    const remaining = Math.max(0, limit - bytes)
    if (remaining) chunks.push(part.value.slice(0, remaining))
    bytes += part.value.byteLength
  }
  return Buffer.concat(chunks).toString("utf8") + (bytes > limit ? "\n[output truncated]" : "")
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

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false
    await Bun.sleep(20)
  }
  return true
}

async function terminateAndObserveProcessGroup(pid: number): Promise<void> {
  try {
    try {
      process.kill(-pid, "SIGKILL")
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ))
        throw error
    }
    if (!(await waitForProcessGroupExit(pid, 5_000)))
      throw new Error("Verification subprocess tree did not terminate after SIGKILL")
  } catch (error) {
    throw new Error(
      `Verification subprocess-tree termination is uncertain: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

async function terminateWindowsProcessTree(pid: number): Promise<void> {
  const taskkill = Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    bounded(taskkill.stdout),
    bounded(taskkill.stderr),
    taskkill.exited,
  ])
  if (exitCode !== 0)
    throw new Error(
      `taskkill could not confirm process-tree termination (exit ${exitCode}): ${(stderr || stdout).trim().slice(0, 1000)}`,
    )
}

async function hasWindowsProcessTreeDescendants(pid: number): Promise<boolean> {
  const script = [
    "$rootProcessID = [uint32]" + pid,
    "$processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)",
    "$known = New-Object 'System.Collections.Generic.HashSet[uint32]'",
    "[void]$known.Add($rootProcessID)",
    "do {",
    "  $priorCount = $known.Count",
    "  foreach ($process in $processes) {",
    "    if ($known.Contains([uint32]$process.ParentProcessId)) { [void]$known.Add([uint32]$process.ProcessId) }",
    "  }",
    "} while ($known.Count -gt $priorCount)",
    "if ($known.Count -gt 1) { 'remaining' } else { 'empty' }",
  ].join("\n")
  const child = Bun.spawn(
    ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    bounded(child.stdout),
    bounded(child.stderr),
    child.exited,
  ])
  if (exitCode !== 0)
    throw new Error(
      `Win32 process-tree observation failed (exit ${exitCode}): ${(stderr || stdout).trim().slice(0, 1000)}`,
    )
  const observation = stdout.trim().split(/\r?\n/).at(-1)
  if (observation === "remaining") return true
  if (observation === "empty") return false
  throw new Error(`Win32 process-tree observation returned an invalid result: ${stdout.trim()}`)
}

const nativeWindowsProcessTreeAdapter: WindowsProcessTreeAdapter = {
  hasDescendants: hasWindowsProcessTreeDescendants,
  terminate: terminateWindowsProcessTree,
}

async function terminateAndObserveWindowsProcessTree(
  pid: number,
  adapter: WindowsProcessTreeAdapter,
): Promise<void> {
  try {
    await adapter.terminate(pid)
    const deadline = Date.now() + 5_000
    while (await adapter.hasDescendants(pid)) {
      if (Date.now() >= deadline)
        throw new Error("Verification subprocess descendants remain after taskkill /T")
      await Bun.sleep(50)
    }
  } catch (error) {
    throw new Error(
      `Verification subprocess-tree termination is uncertain: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

export async function runCheck(
  directory: string,
  artifact: string,
  check: ExecutableVerificationCheck,
  receiptPath: string,
  options: CheckRunOptions = {},
): Promise<CheckReceipt> {
  if (options.signal?.aborted) throw new Error("Verification was cancelled before check launch")
  const inputIdentity = options.inputIdentity ?? artifact
  // Record runtime metadata without persisting environment credentials.
  const environmentIdentity = options.environmentIdentity ?? verificationEnvironmentIdentity()
  const startedAt = Date.now()
  const inactivityTimeoutMs =
    check.inactivityTimeoutMs ?? DEFAULT_VERIFICATION_INACTIVITY_TIMEOUT_MS
  const hardTimeoutMs = check.hardTimeoutMs ?? DEFAULT_VERIFICATION_HARD_TIMEOUT_MS
  if (inactivityTimeoutMs > hardTimeoutMs)
    throw new Error("Verification inactivity allowance cannot exceed its hard backstop")
  let stopCause: CheckReceipt["stopCause"] = null
  const child = Bun.spawn(["/bin/sh", "-c", check.command], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    detached: true,
    env: checkEnvironment(options.environment ?? process.env),
  })
  const windowsTreeAdapter =
    options.processTreeAdapter ??
    (process.platform === "win32" ? nativeWindowsProcessTreeAdapter : undefined)
  let termination: Promise<void> | undefined
  let terminationRequested = false
  const terminate = () => {
    if (terminationRequested) return
    terminationRequested = true
    if (windowsTreeAdapter) {
      termination ??= windowsTreeAdapter.terminate(child.pid).catch((error: unknown) => {
        child.kill("SIGKILL")
        throw error
      })
      void termination.catch(() => undefined)
      return
    }
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ))
        child.kill("SIGKILL")
    }
  }
  const terminateFor = (cause: NonNullable<CheckReceipt["stopCause"]>) => {
    if (stopCause !== null || terminationRequested) return
    stopCause = cause
    terminate()
  }
  const onAbort = () => terminateFor("cancelled")
  const hardDeadline = options.hardDeadline ?? performance.now() + hardTimeoutMs
  const inactivityDeadline = options.inactivityDeadline ?? {
    value: performance.now() + inactivityTimeoutMs,
  }
  let hardTimer: ReturnType<typeof setTimeout> | undefined
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined
  const armDeadline = (
    cause: "inactivity" | "hard-backstop",
    deadline: number,
    setTimer: (timer: ReturnType<typeof setTimeout>) => void,
  ) => {
    const remaining = deadline - performance.now()
    if (remaining <= 0) {
      terminateFor(cause)
      return
    }
    setTimer(
      setTimeout(() => armDeadline(cause, deadline, setTimer), Math.min(remaining, 2147483647)),
    )
  }
  const armInactivity = () =>
    armDeadline("inactivity", inactivityDeadline.value, (timer) => {
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer)
      inactivityTimer = timer
    })
  const onProgress = () => {
    if (stopCause !== null) return
    inactivityDeadline.value = performance.now() + inactivityTimeoutMs
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer)
    armInactivity()
  }
  options.signal?.addEventListener("abort", onAbort, { once: true })
  if (options.signal?.aborted) onAbort()
  armDeadline("hard-backstop", hardDeadline, (timer) => {
    clearTimeout(hardTimer)
    hardTimer = timer
  })
  armInactivity()
  try {
    const [stdout, initialStderr, initialExitCode] = await Promise.all([
      bounded(child.stdout, 32768, onProgress),
      bounded(child.stderr, 32768, onProgress),
      child.exited,
    ])
    if (hardTimer !== undefined) clearTimeout(hardTimer)
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer)
    const stderr = initialStderr
    const exitCode = initialExitCode
    let processCleanup: CheckReceipt["processCleanup"]
    if (windowsTreeAdapter) {
      try {
        if (termination) await termination.catch(() => undefined)
        if (await windowsTreeAdapter.hasDescendants(child.pid)) {
          await terminateAndObserveWindowsProcessTree(child.pid, windowsTreeAdapter)
          processCleanup = {
            state: "terminated",
            capability: "windows-process-tree",
            rootPID: child.pid,
          }
        } else
          processCleanup = {
            state: terminationRequested ? "terminated" : "settled",
            capability: "windows-process-tree",
            rootPID: child.pid,
          }
      } catch (error) {
        processCleanup = {
          state: "uncertain",
          capability: "windows-process-tree",
          rootPID: child.pid,
          detail: error instanceof Error ? error.message : String(error),
        }
      }
    } else {
      try {
        if (await waitForProcessGroupExit(child.pid, 100))
          processCleanup = {
            state: terminationRequested ? "terminated" : "settled",
            capability: "process-group",
            rootPID: child.pid,
          }
        else {
          await terminateAndObserveProcessGroup(child.pid)
          processCleanup = {
            state: "terminated",
            capability: "process-group",
            rootPID: child.pid,
          }
        }
      } catch (error) {
        processCleanup = {
          state: "uncertain",
          capability: "process-group",
          rootPID: child.pid,
          detail: error instanceof Error ? error.message : String(error),
        }
      }
    }
    const receipt = {
      id: check.id,
      command: check.command,
      cwd: directory,
      artifact,
      inputIdentity,
      environmentIdentity,
      startedAt,
      endedAt: Date.now(),
      exitCode,
      timedOut: stopCause === "inactivity" || stopCause === "hard-backstop",
      stopCause,
      inactivityTimeoutMs,
      hardTimeoutMs,
      aborted:
        stopCause === "cancelled" || (options.signal?.aborted === true && stopCause === null),
      stdout,
      stderr,
      processCleanup,
      ...(options.isolation === undefined ? {} : { isolation: options.isolation }),
    }
    mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 })
    writeFileSync(`${receiptPath}.tmp`, JSON.stringify(receipt), { mode: 0o600 })
    renameSync(`${receiptPath}.tmp`, receiptPath)
    return receipt
  } catch (error) {
    terminate()
    await child.exited.catch(() => -1)
    try {
      if (windowsTreeAdapter) {
        if (termination) await termination
        if (await windowsTreeAdapter.hasDescendants(child.pid))
          await terminateAndObserveWindowsProcessTree(child.pid, windowsTreeAdapter)
      } else await terminateAndObserveProcessGroup(child.pid)
    } catch (terminationError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; ${terminationError instanceof Error ? terminationError.message : String(terminationError)}`,
        { cause: terminationError },
      )
    }
    throw error
  } finally {
    if (hardTimer !== undefined) clearTimeout(hardTimer)
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer)
    options.signal?.removeEventListener("abort", onAbort)
  }
}

export function checkResourcesSettled(receipt: CheckReceipt): boolean {
  const settled = (cleanup: CheckReceipt["processCleanup"]) =>
    cleanup?.state !== "uncertain" &&
    cleanup?.capability !== "direct-child" &&
    !(cleanup?.capability === "windows-process-tree" && !Number.isSafeInteger(cleanup.rootPID))
  return (
    settled(receipt.processCleanup) &&
    !receipt.phases?.some((phase) => !settled(phase.processCleanup))
  )
}

export function writeCheckReceipt(receiptPath: string, receipt: CheckReceipt): void {
  mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 })
  writeFileSync(`${receiptPath}.tmp`, JSON.stringify(receipt), { mode: 0o600 })
  renameSync(`${receiptPath}.tmp`, receiptPath)
}

export async function runDeclaredCheck(
  directory: string,
  artifact: string,
  check: ExecutableVerificationCheck,
  receiptPath: string,
  options: CheckRunOptions = {},
): Promise<CheckReceipt> {
  const commands = recognizedVerificationPhases(check.command)
  if (!commands) return runCheck(directory, artifact, check, receiptPath, options)
  const phases: CheckPhaseReceipt[] = []
  const startedAt = Date.now()
  const inactivityTimeoutMs =
    check.inactivityTimeoutMs ?? DEFAULT_VERIFICATION_INACTIVITY_TIMEOUT_MS
  const hardTimeoutMs = check.hardTimeoutMs ?? DEFAULT_VERIFICATION_HARD_TIMEOUT_MS
  if (inactivityTimeoutMs > hardTimeoutMs)
    throw new Error("Verification inactivity allowance cannot exceed its hard backstop")
  const deadline = options.hardDeadline ?? performance.now() + hardTimeoutMs
  const inactivityDeadline = options.inactivityDeadline ?? {
    value: performance.now() + inactivityTimeoutMs,
  }
  let latest: CheckReceipt | undefined
  for (let index = 0; index < commands.length; index++) {
    const command = commands[index]!
    if (options.signal?.aborted || deadline <= performance.now()) {
      const cancelled = options.signal?.aborted === true
      latest = {
        id: check.id,
        command,
        cwd: directory,
        artifact,
        inputIdentity: options.inputIdentity ?? artifact,
        environmentIdentity: options.environmentIdentity ?? verificationEnvironmentIdentity(),
        startedAt: Date.now(),
        endedAt: Date.now(),
        exitCode: null,
        timedOut: !cancelled,
        stopCause: cancelled ? "cancelled" : "hard-backstop",
        inactivityTimeoutMs,
        hardTimeoutMs,
        aborted: cancelled,
        stdout: "",
        stderr: "",
      }
      phases.push({
        command,
        exitCode: latest.exitCode,
        timedOut: latest.timedOut,
        stopCause: latest.stopCause,
        aborted: latest.aborted,
        stdout: latest.stdout,
        stderr: latest.stderr,
        environmentIdentity: latest.environmentIdentity,
      })
      break
    }
    latest = await runCheck(
      directory,
      artifact,
      {
        ...check,
        command,
        inactivityTimeoutMs,
        hardTimeoutMs,
      },
      `${receiptPath}.phase-${index}.json`,
      { ...options, hardDeadline: deadline, inactivityDeadline },
    )
    phases.push({
      command,
      exitCode: latest.exitCode,
      timedOut: latest.timedOut,
      stopCause: latest.stopCause,
      aborted: latest.aborted,
      stdout: latest.stdout,
      stderr: latest.stderr,
      environmentIdentity: latest.environmentIdentity,
      ...(latest.processCleanup ? { processCleanup: latest.processCleanup } : {}),
    })
    if (!checkSucceeded(latest) || !checkResourcesSettled(latest)) break
  }
  if (!latest) throw new Error("Recognized verification command has no executable phases")
  const result: CheckReceipt = {
    ...latest,
    id: check.id,
    command: check.command,
    cwd: directory,
    artifact,
    inputIdentity: options.inputIdentity ?? artifact,
    startedAt,
    inactivityTimeoutMs,
    hardTimeoutMs,
    stopCause: latest.stopCause,
    stdout: phases.map((phase) => phase.stdout).join(""),
    stderr: phases.map((phase) => phase.stderr).join(""),
    processCleanup:
      phases.find((phase) => phase.processCleanup?.state === "uncertain")?.processCleanup ??
      phases.find((phase) => phase.processCleanup?.state === "terminated")?.processCleanup ??
      latest.processCleanup,
    phases,
    phasesComplete:
      phases.length === commands.length && !latest.timedOut && latest.aborted !== true,
  }
  writeCheckReceipt(receiptPath, result)
  return result
}
