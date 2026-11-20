import { mkdirSync } from "node:fs"
import { delimiter, join } from "node:path"
import { buildRepoMap, deriveSourceDefinition, sourceFiles } from "../context/repo-map.ts"
import { currentRepoMap } from "../context/repo-map-store.ts"
import { fingerprint } from "../identity.ts"
import { runCheck } from "../runner/artifacts.ts"
import type { CheckReceipt } from "../runner/artifacts.ts"
import { checkEnvironment, checkSucceeded } from "../runner/checks.ts"
import {
  verificationCheckWithDefaults,
  verificationTimeoutDefaults,
} from "../runner/verification-timeout.ts"
import type { TaskRepository } from "../storage.ts"
import type { ProjectProfile } from "./profile.ts"
import type { MapPreview, ProofRecord } from "./profile-store.ts"
import { effectiveInstall, toolchainFacts } from "./toolchains.ts"

/**
 * Proves a profile: every declared command runs once in a native worktree at HEAD, and the
 * result is returned, never stored here (the caller stores proof and revision in one
 * transaction, so an abandoned proof stores nothing). The owner's checkout is only read.
 */
export type ProofWorkspace = {
  /** Native worktree at `base` under `<root>.worktrees/<name>`; returns the recorded directory. */
  create(input: { base: string; name: string }): Promise<string>
  /** Non-forced removal. */
  remove(directory: string): Promise<void>
}

const TAIL_BYTES = 4096
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const tail = (text: string) => {
  const bytes = Buffer.from(text)
  return bytes.length <= TAIL_BYTES ? text : bytes.subarray(bytes.length - TAIL_BYTES).toString()
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function git(directory: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const child = Bun.spawn(["git", ...args], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })
  const [out] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { ok: (await child.exited) === 0, out: out.trimEnd() }
}

const matches = (globs: readonly string[] | undefined, path: string) =>
  globs === undefined || globs.some((glob) => new Bun.Glob(glob).match(path))

/** Paths in `git status --porcelain`, new name for a rename. */
async function dirtyPaths(directory: string): Promise<Set<string>> {
  const { out } = await git(directory, ["status", "--porcelain", "--untracked-files=all"])
  return new Set(
    out
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).split(" -> ").pop()!),
  )
}

export async function proveProfile(input: {
  projectDirectory: string
  dataDirectory: string
  profile: ProjectProfile
  /** Paths appended to a verify command for its proof only (a test command proved on named files). */
  proofTargets?: Readonly<Record<string, readonly string[]>>
  workspace: ProofWorkspace
  environment?: Readonly<Record<string, string | undefined>>
  /** Compared against in the map preview; without it the derived default stands in. */
  repository?: Pick<TaskRepository, "read">
  signal?: AbortSignal
}): Promise<{
  proofs: ProofRecord[]
  mapPreview: MapPreview
  workspaceRemoved: boolean
  workspaceReason?: string
}> {
  const { profile } = input
  const head = await git(input.projectDirectory, ["rev-parse", "HEAD"])
  if (!head.ok) throw new Error("The project has no commit to prove the profile at")
  const identity = fingerprint(profile).slice(0, 8)
  const receipts = join(input.dataDirectory, "profile-proofs", identity)
  mkdirSync(receipts, { recursive: true, mode: 0o700 })
  const proofs: ProofRecord[] = []
  const defaults = verificationTimeoutDefaults()

  // Search PATH, then each declared toolchain's known homes; a find in a home extends PATH.
  const base = checkEnvironment(input.environment ? { ...input.environment } : process.env)
  const homeDirectories: string[] = []
  const located = new Map<string, string>()
  const toolProofs: ProofRecord[] = []
  for (const name of profile.toolchains) {
    const facts = toolchainFacts(name)
    const homes = facts.homes(base, process.execPath)
    const searched = [...(base.PATH ?? "").split(delimiter).filter(Boolean), ...homes]
    const started = Date.now()
    const found =
      Bun.which(facts.executable, { PATH: base.PATH ?? "" }) ??
      homes.map((home) => Bun.which(facts.executable, { PATH: home })).find(Boolean) ??
      undefined
    if (!found) {
      toolProofs.push({
        key: `tool:${name}`,
        command: facts.executable,
        outcome: "failed",
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - started,
        reason: `${facts.executable} not found on the service PATH (searched: ${searched.join(", ")})`,
        stdoutTail: "",
        stderrTail: "",
        ranAt: started,
      })
      continue
    }
    located.set(name, found)
    const directory = found.slice(0, found.lastIndexOf("/"))
    if (!(base.PATH ?? "").split(delimiter).includes(directory)) homeDirectories.push(directory)
    const version = Bun.spawnSync([found, "--version"], {
      env: base,
      stdout: "pipe",
      stderr: "pipe",
    })
    toolProofs.push({
      key: `tool:${name}`,
      command: `${facts.executable} --version`,
      outcome: "proven",
      exitCode: version.exitCode,
      timedOut: false,
      durationMs: Date.now() - started,
      stdoutTail: tail(version.stdout.toString()),
      stderrTail: tail(version.stderr.toString()),
      ...(version.exitCode === 0
        ? { toolVersion: version.stdout.toString().split("\n")[0]!.trim() }
        : {}),
      ranAt: started,
    })
  }
  proofs.push(...toolProofs)
  const environment = {
    ...base,
    ...(homeDirectories.length
      ? { PATH: [...homeDirectories, base.PATH].filter(Boolean).join(delimiter) }
      : {}),
  }

  const name = `profile-proof-${identity}-${Date.now().toString(36)}`
  const worktree = await input.workspace.create({ base: head.out, name })
  let workspaceRemoved = false
  let workspaceReason: string | undefined
  try {
    const run = async (key: string, command: string, effective?: string): Promise<ProofRecord> => {
      const started = Date.now()
      const id = key.replace(/[^a-z0-9-]/g, "-")
      const check = verificationCheckWithDefaults({ id, command: effective ?? command }, defaults)
      let receipt: CheckReceipt
      try {
        receipt = await runCheck(worktree, head.out, check, join(receipts, `${id}.json`), {
          environment: environment as Record<string, string>,
          ...(input.signal ? { signal: input.signal } : {}),
        })
      } catch (error) {
        return {
          key,
          command,
          ...(effective ? { effectiveCommand: effective } : {}),
          outcome: "failed",
          exitCode: null,
          timedOut: false,
          durationMs: Date.now() - started,
          reason: message(error),
          stdoutTail: "",
          stderrTail: "",
          ranAt: started,
        }
      }
      const ok = checkSucceeded(receipt)
      const reason = ok
        ? undefined
        : receipt.timedOut
          ? `timed out (${receipt.stopCause ?? "limit"})`
          : receipt.aborted
            ? "cancelled"
            : receipt.exitCode === 127
              ? "could not start: command not found"
              : undefined
      return {
        key,
        command,
        ...(effective ? { effectiveCommand: effective } : {}),
        outcome: ok ? "proven" : "failed",
        exitCode: receipt.exitCode,
        timedOut: receipt.timedOut,
        durationMs: Date.now() - started,
        ...(reason ? { reason } : {}),
        stdoutTail: tail(receipt.stdout),
        stderrTail: tail(receipt.stderr),
        ranAt: started,
      }
    }
    const notRun = (key: string, command: string, reason: string): ProofRecord => ({
      key,
      command,
      outcome: "not-run",
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      reason,
      stdoutTail: "",
      stderrTail: "",
      ranAt: Date.now(),
    })

    // install
    let installFailed = false
    const installs = effectiveInstall(profile, worktree)
    for (const [index, entry] of installs.entries()) {
      if (entry.source === "none") continue
      const command = entry.source === "profile" ? entry.command : entry.argv.map(quote).join(" ")
      const key = `install:${index}`
      if (installFailed) {
        proofs.push(notRun(key, command, "an earlier install failed"))
        continue
      }
      const proof = await run(key, command)
      proofs.push(proof)
      if (proof.outcome === "failed") installFailed = true
    }

    // verify: every entry, whatever failed before
    for (const entry of profile.verify) {
      const targets = input.proofTargets?.[entry.id]
      const effective = targets?.length
        ? `${entry.command} ${targets.map(quote).join(" ")}`
        : undefined
      proofs.push(await run(`verify:${entry.id}`, entry.command, effective))
    }

    // fix: in order, on proof files, stopping at the first failure
    const changed = (await git(worktree, ["diff", "--name-only", "HEAD^", "HEAD"])).out
      .split("\n")
      .filter(Boolean)
    const tracked = (await git(worktree, ["ls-files"])).out.split("\n").filter(Boolean).sort()
    let fixFailed = false
    for (const [index, entry] of profile.fix.entries()) {
      const key = `fix:${index}`
      if (fixFailed) {
        proofs.push(notRun(key, entry.command, "an earlier fix failed"))
        continue
      }
      let files = changed.filter((path) => matches(entry.files, path))
      if (files.length === 0) {
        const first = tracked.find((path) => matches(entry.files, path))
        files = first === undefined ? [] : [first]
      }
      if (files.length === 0) {
        proofs.push(notRun(key, entry.command, "no tracked file matches its files globs"))
        continue
      }
      const before = await dirtyPaths(worktree)
      const proof = await run(key, entry.command, `${entry.command} ${files.map(quote).join(" ")}`)
      const extra = [...(await dirtyPaths(worktree))].filter(
        (path) => !before.has(path) && !files.includes(path),
      )
      if (extra.length > 0) {
        proof.outcome = "failed"
        proof.reason = `changed files it was not given: ${extra.join(", ")}`
      }
      proofs.push(proof)
      if (proof.outcome === "failed") fixFailed = true
    }

    // map preview: the profile's source in the worktree against what the map is today
    const selected = await sourceFiles(worktree, profile.source)
    const map = await buildRepoMap(worktree, profile.source)
    const current = input.repository
      ? await currentRepoMap(input.repository, input.projectDirectory)
      : await buildRepoMap(
          input.projectDirectory,
          await deriveSourceDefinition(input.projectDirectory),
        )
    const folders = new Map<string, number>()
    for (const path of selected) {
      const at = path.lastIndexOf("/")
      const folder = at < 0 ? "." : path.slice(0, at)
      folders.set(folder, (folders.get(folder) ?? 0) + 1)
    }
    const mapPreview: MapPreview = {
      files: map.files,
      names: map.names,
      tokens: map.tokens,
      largestFolders: [...folders]
        .map(([folder, files]) => ({ folder, files }))
        .sort((a, b) => b.files - a.files || a.folder.localeCompare(b.folder))
        .slice(0, 10),
      currentFiles: current.files,
      currentTokens: current.tokens,
    }
    return await finish(mapPreview)
  } catch (error) {
    await cleanup()
    throw error
  }

  async function cleanup() {
    await git(worktree, ["checkout", "--", "."])
    await git(worktree, ["clean", "-fd"])
    try {
      await input.workspace.remove(worktree)
      workspaceRemoved = true
    } catch (error) {
      workspaceReason = message(error)
    }
  }
  async function finish(mapPreview: MapPreview) {
    await cleanup()
    return {
      proofs,
      mapPreview,
      workspaceRemoved,
      ...(workspaceReason === undefined ? {} : { workspaceReason }),
    }
  }
}
