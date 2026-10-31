import { spawnSync } from "node:child_process"
import {
  constants,
  lstatSync,
  openSync,
  closeSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import type { TaskProposal } from "../task.ts"

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
export function combineArtifacts(directory: string, base: string, artifacts: string[]): string {
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
    const result = spawnSync("git", ["merge-tree", "--write-tree", combined, artifact], {
      cwd: directory,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
    if (result.status !== 0) {
      const detail = (result.stdout || result.stderr || result.error?.message || "unknown").trim()
      throw new Error(
        `Conflicting accepted artifacts ${combined} and ${artifact}: ${detail.slice(0, 1500)}`,
      )
    }
    const tree = result.stdout.trim().split(/\s/, 1)[0]
    if (!tree || !/^[a-f0-9]{40,64}$/.test(tree))
      throw new Error("Git did not return a tree for combined artifacts")
    const fixedDate = "2000-01-01T00:00:00+00:00"
    combined = git(
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

export function changedPaths(directory: string, base = "HEAD"): string[] {
  return [
    ...new Set(
      [
        ...git(directory, ["diff", "--name-only", "--no-renames", "-z", base]).split("\0"),
        ...git(directory, ["diff", "--cached", "--name-only", "--no-renames", "-z", base]).split(
          "\0",
        ),
        ...git(directory, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
      ].filter(Boolean),
    ),
  ].sort()
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

export function artifactUnchanged(directory: string, commit: string): boolean {
  const result = spawnSync("git", ["diff", "--quiet", commit, "--"], {
    cwd: directory,
    timeout: 30000,
  })
  return (
    result.status === 0 &&
    git(directory, ["ls-files", "--others", "--exclude-standard"]).length === 0
  )
}

export class ArtifactScopeViolation extends Error {
  constructor(readonly paths: string[]) {
    super(`Out-of-scope changes: ${paths.slice(0, 20).join(", ")}`)
  }
}

/** Only a private runtime-created worktree may be snapshotted. Never stages origin. */
export function commitArtifact(
  directory: string,
  base: string,
  scope: string[],
  snapshot = true,
): { commit: string; paths: string[]; identity: string } {
  const paths = changedPaths(directory, base)
  const violations = scopeViolations(paths, scope)
  if (violations.length) throw new ArtifactScopeViolation(violations)
  const head = git(directory, ["rev-parse", "HEAD"])
  git(directory, ["merge-base", "--is-ancestor", base, head])
  if (changedPaths(directory).length === 0) return { commit: head, paths, identity: head }
  if (!snapshot)
    throw new Error(
      "Commit task edits before verification; shared checkout was not staged by runtime",
    )
  git(directory, ["add", "--all"])
  const tree = git(directory, ["write-tree"])
  const commit = git(
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
  return { commit, paths, identity: commit }
}

export function artifactExists(directory: string, reference: string): boolean {
  if (isAbsolute(reference) || reference.includes("://")) return false
  const path = resolve(directory, reference)
  const within = relative(directory, path)
  if (within.startsWith("..") || isAbsolute(within)) return false
  let current = directory
  try {
    for (const part of within.split("/")) {
      current = join(current, part)
      if (lstatSync(current).isSymbolicLink()) return false
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    closeSync(fd)
    return lstatSync(path).isFile()
  } catch {
    return false
  }
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
  stdout: string
  stderr: string
  unchanged: boolean
}
async function bounded(stream: ReadableStream<Uint8Array>, limit = 32768) {
  const reader = stream.getReader()
  let bytes = 0
  const chunks: Uint8Array[] = []
  while (true) {
    const part = await reader.read()
    if (part.done) break
    const remaining = Math.max(0, limit - bytes)
    if (remaining) chunks.push(part.value.slice(0, remaining))
    bytes += part.value.byteLength
  }
  return Buffer.concat(chunks).toString("utf8") + (bytes > limit ? "\n[output truncated]" : "")
}
export async function runCheck(
  directory: string,
  artifact: string,
  check: TaskProposal["verification"][number],
  receiptPath: string,
): Promise<CheckReceipt> {
  const inputIdentity = artifact
  // Record runtime metadata without persisting environment credentials.
  const environmentIdentity = JSON.stringify({
    bun: Bun.revision,
    platform: process.platform,
  })
  const startedAt = Date.now()
  let timedOut = false
  const child = Bun.spawn(["/bin/sh", "-c", check.command], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    detached: true,
    env: { ...process.env },
  })
  const terminate = () => {
    timedOut = true
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      child.kill("SIGKILL")
    }
  }
  const timer = setTimeout(terminate, Math.min(check.timeoutMs, 2147483647))
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      bounded(child.stdout),
      bounded(child.stderr),
      child.exited,
    ])
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
      timedOut,
      stdout,
      stderr,
      unchanged: artifactUnchanged(directory, artifact),
    }
    mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 })
    writeFileSync(`${receiptPath}.tmp`, JSON.stringify(receipt), { mode: 0o600 })
    renameSync(`${receiptPath}.tmp`, receiptPath)
    return receipt
  } finally {
    clearTimeout(timer)
  }
}
