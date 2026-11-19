import { execFile, spawnSync } from "node:child_process"
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  writeFile,
} from "node:fs/promises"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
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
import type { FallowReviewResult } from "../audit/review.ts"

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

const worktreeListInFlight = new Map<string, Promise<string>>()

/**
 * `git worktree list --porcelain`, single-flight per directory: callers that
 * overlap in time share one process, but a call that starts after another has
 * settled always observes fresh state (never a stale cache across a mutation).
 */
export function worktreeListPorcelain(directory: string): Promise<string> {
  const running = worktreeListInFlight.get(directory)
  if (running) return running
  const pending = gitAsync(directory, ["worktree", "list", "--porcelain"]).finally(() => {
    if (worktreeListInFlight.get(directory) === pending) worktreeListInFlight.delete(directory)
  })
  worktreeListInFlight.set(directory, pending)
  return pending
}

/** Absolute paths of every worktree git has registered for the repository. */
export async function registeredWorktreePaths(directory: string): Promise<string[]> {
  return (await worktreeListPorcelain(directory))
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length)))
}

/**
 * Blocking Git for CLI scripts, fixtures and tests only. The plugin service is
 * single-threaded: runtime code must use `gitAsync`.
 */
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
export async function commitIsAncestor(
  directory: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: directory,
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
    return true
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code === 1) return false
    const stderr = (error as { stderr?: unknown }).stderr
    const detail = typeof stderr === "string" && stderr ? stderr : "unknown"
    throw new Error(`git merge-base --is-ancestor failed: ${detail.slice(0, 2000)}`, {
      cause: error,
    })
  }
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

/**
 * `git commit-tree` ignores `commit.gpgsign`, so honor the configured signing
 * preference explicitly. Never disable signing and never choose a key here.
 */
async function signingArguments(directory: string): Promise<string[]> {
  try {
    return (await gitAsync(directory, ["config", "--type=bool", "--get", "commit.gpgsign"])) ===
      "true"
      ? ["-S"]
      : []
  } catch {
    return []
  }
}

/**
 * Create the merge commit for a combined artifact as the workspace identity,
 * signed as configured. Signatures make a recomputed commit SHA differ, but
 * callers compare combined SHAs across restarts. So the result is memoized
 * under a ref keyed by the resulting tree plus the ordered parents: the same
 * tree and parents always resolve to the first commit created for them.
 */
async function commitCombinedTree(
  directory: string,
  tree: string,
  left: string,
  right: string,
): Promise<string> {
  const key = createHash("sha256").update(`${tree}\n${left}\n${right}`).digest("hex")
  const ref = `refs/lazers/combined/${key}`
  const existing = async () => {
    try {
      return await gitAsync(directory, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
    } catch {
      return undefined
    }
  }
  const known = await existing()
  if (known) return known
  // Realistic, input-derived date: the newest parent committer time.
  const stamps = await gitAsync(directory, ["show", "-s", "--format=%cI", left, right])
  const date = stamps
    .split("\n")
    .map((line) => ({ line, time: Date.parse(line) }))
    .reduce((best, item) => (item.time > best.time ? item : best)).line
  const created = await gitAsync(
    directory,
    ["commit-tree", ...(await signingArguments(directory)), tree, "-p", left, "-p", right],
    "chore: integrate accepted artifacts\n",
    { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  )
  try {
    await gitAsync(directory, ["update-ref", ref, created, ""])
    return created
  } catch {
    // A concurrent computation won the race; converge on its commit.
    return (await existing()) ?? created
  }
}

/**
 * Signed commits are not reproducible, so a recomputed combined commit is
 * equal to a stored one when both resolve, have the same tree OID, and have the
 * same ordered parents (after `mapParent`, for rewritten history). An
 * unreadable commit never matches.
 */
export async function combinedArtifactsMatch(
  directory: string,
  current: string,
  stored: string,
  mapParent: (parent: string) => string = (parent) => parent,
): Promise<boolean> {
  if (current === stored) return true
  try {
    const read = async (commit: string) => {
      const [tree, line] = await Promise.all([
        gitAsync(directory, ["rev-parse", "--verify", `${commit}^{tree}`]),
        gitAsync(directory, ["rev-list", "--parents", "-n", "1", commit]),
      ])
      return { tree, parents: line.split(" ").slice(1) }
    }
    const [a, b] = await Promise.all([read(current), read(stored)])
    return (
      a.tree === b.tree &&
      a.parents.length === b.parents.length &&
      a.parents.every((parent, index) => mapParent(parent) === mapParent(b.parents[index]!))
    )
  } catch {
    return false
  }
}

/** Prefer an already-recorded equivalent so SHA-keyed receipts and effects keep matching. */
export async function canonicalCombinedArtifact(
  directory: string,
  computed: string,
  recorded: Array<string | null | undefined>,
): Promise<string> {
  for (const candidate of recorded)
    if (candidate && (await combinedArtifactsMatch(directory, computed, candidate)))
      return candidate
  return computed
}

/** Merge branch artifacts in caller-supplied deterministic order without moving a checkout. */
export async function combineArtifacts(
  directory: string,
  base: string,
  artifacts: string[],
): Promise<string> {
  const isAncestor = async (ancestor: string, descendant: string) => {
    try {
      await gitAsync(directory, ["merge-base", "--is-ancestor", ancestor, descendant])
      return true
    } catch {
      return false
    }
  }
  let combined = base
  for (const artifact of artifacts) {
    if (artifact === combined || (await isAncestor(artifact, combined))) continue
    if (await isAncestor(combined, artifact)) {
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
    combined = await commitCombinedTree(directory, tree, combined, artifact)
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

export async function changedPaths(directory: string, base = "HEAD"): Promise<string[]> {
  // The three observations are independent; run them concurrently.
  return collectChangedPaths(
    await Promise.all(changedPathCommands(base).map((args) => gitAsync(directory, args))),
  )
}

/** Bounded-concurrency map so large sets never monopolize the event loop. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await run(items[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Fingerprint the actual editable candidate bytes without staging or mutating them. */
export async function workingTreeIdentity(directory: string, base: string): Promise<string> {
  const hash = createHash("sha256")
  hash.update(base)
  const paths = await changedPaths(directory, base)
  const parts = await mapBounded(paths, 16, async (path) => {
    try {
      const info = await lstat(join(directory, path))
      let body: Buffer | string
      if (info.isSymbolicLink()) body = await readlink(join(directory, path))
      else if (info.isFile()) body = await readFile(join(directory, path))
      else body = "unsupported-file-kind"
      return { path, header: `\0${info.mode}\0`, body }
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return { path, header: "", body: "deleted" }
      throw error
    }
  })
  for (const part of parts) {
    hash.update("\0")
    hash.update(part.path)
    hash.update(part.header)
    hash.update(part.body)
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

type WorkspaceStatus = { head: string | undefined; changed: boolean; untracked: string[] }

/** One `git status` replaces `diff --quiet`, `diff --cached` and `ls-files --others`. */
async function workspaceStatus(directory: string): Promise<WorkspaceStatus> {
  const output = await gitAsync(directory, [
    "status",
    "--porcelain=v2",
    "--branch",
    "-z",
    "--untracked-files=all",
  ])
  let head: string | undefined
  let changed = false
  const untracked: string[] = []
  for (const token of output.split("\0")) {
    if (token.startsWith("# branch.oid ")) {
      const oid = token.slice("# branch.oid ".length)
      head = oid === "(initial)" ? undefined : oid
    } else if (token.startsWith("? ")) untracked.push(token.slice(2))
    else if (/^[12u] /.test(token)) changed = true
  }
  return { head, changed, untracked }
}

export async function artifactUnchanged(
  directory: string,
  commit: string,
  ownedUntrackedPaths: string[] = [],
): Promise<boolean> {
  const status = await workspaceStatus(directory)
  const allowed = new Set(ownedUntrackedPaths)
  if (status.untracked.some((path) => !allowed.has(path))) return false
  // Status compares with HEAD; any other commit needs an explicit tracked diff.
  if (status.head === commit) return !status.changed
  try {
    await gitAsync(directory, ["diff", "--quiet", commit, "--"])
    return true
  } catch {
    return false
  }
}

export class ArtifactScopeViolation extends Error {
  constructor(readonly paths: string[]) {
    super(`Out-of-scope changes: ${paths.slice(0, 20).join(", ")}`)
  }
}

async function singleMergeBase(directory: string, left: string, right: string): Promise<string> {
  const bases = (await gitAsync(directory, ["merge-base", "--all", left, right]))
    .split(/\s+/)
    .filter(Boolean)
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
  await singleMergeBase(directory, base, incorporated)
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
  if ((await gitAsync(directory, ["cat-file", "-t", tree])) !== "tree")
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
    const common = await singleMergeBase(directory, head, reviewedHead)
    const baseRelation = await singleMergeBase(directory, base, common)
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
  const head = await gitAsync(directory, ["rev-parse", "HEAD"])
  await gitAsync(directory, ["merge-base", "--is-ancestor", base, head])
  const scopeBase = await reviewedScopeBase(
    directory,
    base,
    head,
    snapshot ? reviewedHead : undefined,
  )
  const paths = await changedPaths(directory, scopeBase)
  const violations = scopeViolations(paths, scope)
  if (violations.length) throw new ArtifactScopeViolation(violations)
  if ((await changedPaths(directory)).length === 0)
    return { commit: head, paths, identity: head, scopeBase }
  if (!snapshot)
    throw new Error(
      "Commit task edits before verification; shared checkout was not staged by runtime",
    )
  await gitAsync(directory, ["add", "--all"])
  const tree = await gitAsync(directory, ["write-tree"])
  const commit = await gitAsync(
    directory,
    ["commit-tree", ...(await signingArguments(directory)), tree, "-p", head],
    "chore: snapshot verified candidate\n",
  )
  return { commit, paths, identity: commit, scopeBase }
}

export async function artifactExists(directory: string, reference: string): Promise<boolean> {
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
      if ((await lstat(current)).isSymbolicLink()) return false
    }
    const leaf = await lstat(path)
    if (leaf.isSymbolicLink()) return false
    if (leaf.isFile()) return await readableRegularFile(path)
    return leaf.isDirectory() && (await hasReadableRegularFile(path))
  } catch {
    return false
  }
}

async function readableRegularFile(path: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const candidate = await lstat(path)
    if (candidate.isSymbolicLink() || !candidate.isFile()) return false
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    return (await handle.stat()).isFile()
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function hasReadableRegularFile(directory: string): Promise<boolean> {
  const pending = [directory]
  while (pending.length) {
    const current = pending.pop()!
    let entries: string[]
    try {
      entries = await readdir(current)
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(current, entry)
      let candidate: Awaited<ReturnType<typeof lstat>>
      try {
        candidate = await lstat(path)
      } catch {
        continue
      }
      if (candidate.isSymbolicLink()) continue
      if (candidate.isDirectory()) pending.push(path)
      else if (candidate.isFile() && (await readableRegularFile(path))) return true
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
  /** Structured result of the Fallow review; present only on the `fallow-audit` receipt (`lazers-fallow` before the rename). */
  fallow?: FallowReviewResult
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
  const headLimit = Math.min(8192, limit)
  const tailLimit = limit - headLimit
  let bytes = 0
  let headBytes = 0
  let tailBytes = 0
  const head: Uint8Array[] = []
  const tail: Uint8Array[] = []
  while (true) {
    const part = await reader.read()
    if (part.done) break
    if (part.value.byteLength > 0) onProgress?.()
    bytes += part.value.byteLength
    let value = part.value
    const headRoom = headLimit - headBytes
    if (headRoom > 0) {
      head.push(value.slice(0, headRoom))
      headBytes += Math.min(headRoom, value.byteLength)
      value = value.slice(headRoom)
    }
    if (!value.byteLength || !tailLimit) continue
    tail.push(value.byteLength > tailLimit ? value.slice(-tailLimit) : value)
    tailBytes += tail.at(-1)!.byteLength
    while (tailBytes > tailLimit) {
      const excess = tailBytes - tailLimit
      const first = tail[0]!
      if (first.byteLength <= excess) {
        tail.shift()
        tailBytes -= first.byteLength
      } else {
        tail[0] = first.slice(excess)
        tailBytes -= excess
      }
    }
  }
  const omitted = bytes - headBytes - tailBytes
  return (
    Buffer.concat(head).toString("utf8") +
    (omitted > 0 ? `\n[... ${omitted} bytes omitted ...]\n` : "") +
    Buffer.concat(tail).toString("utf8")
  )
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
    await writeCheckReceipt(receiptPath, receipt)
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

export async function writeCheckReceipt(receiptPath: string, receipt: CheckReceipt): Promise<void> {
  await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 })
  await writeFile(`${receiptPath}.tmp`, JSON.stringify(receipt), { mode: 0o600 })
  await rename(`${receiptPath}.tmp`, receiptPath)
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
  await writeCheckReceipt(receiptPath, result)
  return result
}
