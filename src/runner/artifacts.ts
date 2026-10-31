import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  constants,
  existsSync,
  lstatSync,
  openSync,
  closeSync,
  readFileSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import type { TaskProposal } from "../task.ts"
import { fingerprint } from "../identity.ts"

export function git(directory: string, args: string[], input?: string): string {
  const result = spawnSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    input,
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })
  if (result.status !== 0)
    throw new Error(
      `git ${args[0]} failed: ${(result.stderr || result.error?.message || "unknown").slice(0, 2000)}`,
    )
  return result.stdout.trimEnd()
}

export function changedPaths(directory: string): string[] {
  return [
    ...new Set(
      [
        ...git(directory, ["diff", "--name-only", "--no-renames", "-z", "HEAD"]).split("\0"),
        ...git(directory, ["diff", "--cached", "--name-only", "--no-renames", "-z", "HEAD"]).split(
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

export function contentIdentity(directory: string): string {
  const hash = createHash("sha256")
  const paths = [
    ...new Set(
      [...git(directory, ["ls-files", "-z"]).split("\0"), ...changedPaths(directory)].filter(
        Boolean,
      ),
    ),
  ].sort()
  for (const path of paths) {
    hash.update(path).update("\0")
    const absolute = join(directory, path)
    if (!existsSync(absolute)) {
      hash.update("deleted\0")
      continue
    }
    const stat = lstatSync(absolute)
    if (!stat.isFile()) throw new Error(`Unsupported artifact entry ${path}`)
    hash.update(String(stat.mode)).update("\0").update(readFileSync(absolute)).update("\0")
  }
  return hash.digest("hex")
}

/** Only a private runtime-created worktree may be snapshotted. Never stages origin. */
export function commitArtifact(
  directory: string,
  base: string,
  scope: string[],
): { commit: string; paths: string[]; identity: string } {
  const paths = changedPaths(directory)
  const violations = scopeViolations(paths, scope)
  if (violations.length)
    throw new Error(`Out-of-scope changes: ${violations.slice(0, 20).join(", ")}`)
  const identity = contentIdentity(directory)
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
      base,
    ],
    "LAZERS verified candidate\n",
  )
  return { commit, paths, identity }
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
  const inputIdentity = contentIdentity(directory)
  // Hash environment values; never persist credentials in verification evidence.
  const environmentIdentity = fingerprint({
    env: process.env,
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
      unchanged: contentIdentity(directory) === inputIdentity,
    }
    mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 })
    writeFileSync(`${receiptPath}.tmp`, JSON.stringify(receipt), { mode: 0o600 })
    renameSync(`${receiptPath}.tmp`, receiptPath)
    return receipt
  } finally {
    clearTimeout(timer)
  }
}
