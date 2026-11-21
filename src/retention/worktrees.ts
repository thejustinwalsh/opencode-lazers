import type { Database } from "bun:sqlite"
import { existsSync, realpathSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { gitAsync } from "../runner/artifacts.ts"
import type { HostSession } from "../runner/host.ts"
import { headContained } from "../runner/integration-proof.ts"
import type { RetentionPlan } from "./retention.ts"

/** What retention needs from the host: the native inventory and non-forced native removal. */
export type WorktreeHost = {
  /** Live worker observation, read immediately before a removal. */
  session(id: string): Promise<HostSession | null>
  worktrees(): Promise<string[]>
  removeWorktree(directory: string): Promise<void>
}

export type WorktreeFinding = {
  path: string
  bytes: number | null
  /** `remove` is retirable now; `keep` names the reason it is listed instead. */
  action: "remove" | "keep"
  reason: string
}

/** Filesystem and git facts, injectable so tests need neither a host nor a real checkout. */
export type WorktreeProbe = {
  exists(path: string): boolean
  size(path: string): Promise<number | null>
  status(path: string): Promise<string>
  /** Containment of the worktree's HEAD in the project checkout: `contained` or a reason. */
  contained(project: string, path: string): Promise<{ contained: boolean; reason: string }>
}

const real = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

const defaultProbe: WorktreeProbe = {
  exists: existsSync,
  async size(path) {
    try {
      const process = Bun.spawn(["du", "-sk", path], { stdout: "pipe", stderr: "ignore" })
      const timer = setTimeout(() => process.kill(), 20_000)
      const text = await new Response(process.stdout).text()
      clearTimeout(timer)
      const kilobytes = Number(text.split(/\s+/)[0])
      return Number.isFinite(kilobytes) ? kilobytes * 1024 : null
    } catch {
      return null
    }
  },
  status: (path) => gitAsync(path, ["status", "--porcelain=v1", "--untracked-files=all"]),
  async contained(project, path) {
    const head = (await gitAsync(path, ["rev-parse", "HEAD"])).trim()
    const result = await headContained(project, head)
    return result.status === "contained"
      ? { contained: true, reason: "" }
      : { contained: false, reason: result.reason ?? result.status }
  },
}

/** Roots LAZERS creates worktrees under; anything elsewhere is never removed here. */
function worktreeRoots(project: string, dataDirectory: string) {
  const canonical = real(project)
  return [`${canonical}.worktrees`, join(dataDirectory, "runner", "worktrees")].map(real)
}

const inside = (root: string, path: string) =>
  path !== root && path.startsWith(root.endsWith(sep) ? root : root + sep)

/**
 * Every recorded workspace of this project's retired plans, with whether it can be removed. A
 * worktree is removed only when it is a registered native worktree under a LAZERS root, nothing
 * unfinished records it, its tree is clean and its HEAD is contained in the project checkout.
 */
export async function inspectWorktrees(
  db: Database,
  input: {
    project: string
    dataDirectory: string
    retired: RetentionPlan[]
    host: WorktreeHost
    probe?: WorktreeProbe
  },
): Promise<WorktreeFinding[]> {
  const probe = input.probe ?? defaultProbe
  const project = real(input.project)
  const roots = worktreeRoots(input.project, input.dataDirectory)
  const retired = input.retired.filter((plan) => real(plan.project) === project).map((p) => p.id)
  if (!retired.length) return []
  const recorded = db
    .query<{ workspace: string }, [string]>(
      `SELECT DISTINCT workspace FROM runner_attempts WHERE plan_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(retired))
    .map((row) => real(row.workspace))
  const live = new Set(
    db
      .query<{ workspace: string }, [string]>(
        `SELECT DISTINCT workspace FROM runner_attempts WHERE plan_id NOT IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(retired))
      .map((row) => real(row.workspace)),
  )
  const inventory = new Set((await input.host.worktrees().catch(() => [])).map(real))
  const findings: WorktreeFinding[] = []
  for (const path of [...new Set(recorded)].sort()) {
    if (path === project || !probe.exists(path)) continue
    const keep = async (reason: string): Promise<WorktreeFinding> => ({
      path,
      bytes: await probe.size(path),
      action: "keep",
      reason,
    })
    if (!roots.some((root) => inside(root, path))) {
      findings.push(await keep("outside the LAZERS worktree folders"))
      continue
    }
    if (live.has(path)) {
      findings.push(await keep("also recorded by work that is not finished"))
      continue
    }
    if (!inventory.has(path)) {
      findings.push(await keep("not in OpenCode's worktree list, so OpenCode cannot remove it"))
      continue
    }
    try {
      if ((await probe.status(path)).trim()) {
        findings.push(await keep("uncommitted changes"))
        continue
      }
      const containment = await probe.contained(input.project, path)
      if (!containment.contained) {
        findings.push(await keep(`unmerged commits: ${containment.reason}`))
        continue
      }
    } catch (error) {
      findings.push(await keep(`could not inspect it: ${String(error).slice(0, 120)}`))
      continue
    }
    findings.push({
      path,
      bytes: await probe.size(path),
      action: "remove",
      reason: "clean and merged",
    })
  }
  return findings
}

/** A worktree retention left in place at removal time, and why; the next purge looks again. */
export type WorktreeSkip = { path: string; reason: string }

/**
 * The last look before native removal, taken after every slow probe: the workspace must still
 * belong only to finished plans with no attempt in flight, its worker sessions must be idle (no
 * work, pending input, shell or child session, as ordinary workspace cleanup requires), and the
 * tree must still be clean. Returns why it must stay, or null when removal may proceed.
 */
export async function removalBlocker(
  db: Database,
  finding: WorktreeFinding,
  input: { retired: ReadonlySet<string>; host: WorktreeHost; probe?: WorktreeProbe },
): Promise<string | null> {
  const probe = input.probe ?? defaultProbe
  const path = real(finding.path)
  // Distinct workspaces first (attempts of shared serial execution all name one checkout), then
  // only the attempts that name the finding's path, instead of every attempt ever recorded.
  const workspaces = db
    .query<{ workspace: string }, []>("SELECT DISTINCT workspace FROM runner_attempts")
    .all()
    .map((row) => row.workspace)
    .filter((workspace) => real(workspace) === path)
  const attempts = workspaces.length
    ? db
        .query<{ plan_id: string; session_id: string; state: string; workspace: string }, [string]>(
          `SELECT plan_id, session_id, state, workspace FROM runner_attempts
            WHERE workspace IN (SELECT value FROM json_each(?)) ORDER BY rowid`,
        )
        .all(JSON.stringify(workspaces))
    : []
  for (const attempt of attempts) {
    if (!input.retired.has(attempt.plan_id)) return "also recorded by work that is not finished"
    if (["preparing", "running", "verifying"].includes(attempt.state))
      return "an attempt is still in flight there"
  }
  for (const attempt of attempts) {
    let session: HostSession | null
    try {
      session = await input.host.session(attempt.session_id)
    } catch (error) {
      return `could not observe its worker: ${String(error).slice(0, 120)}`
    }
    if (!session) continue
    const busy = [
      session.busy !== false && "worker session is busy",
      session.pendingInput === true && "worker has pending input",
      session.observationUnstable && "worker observation is unstable",
      (session.pendingPermissions ?? 0) !== 0 && "worker has pending permission requests",
      (session.pendingForms ?? 0) !== 0 && "worker has pending forms",
      ((session.runningShells ?? 0) !== 0 || (session.activeChildren ?? 0) !== 0) &&
        `worker has ${session.runningShells ?? 0} running shell(s) and ${session.activeChildren ?? 0} active child session(s)`,
    ].find(Boolean)
    if (busy) return String(busy)
  }
  try {
    if ((await probe.status(finding.path)).trim()) return "uncommitted changes"
  } catch (error) {
    return `could not inspect it: ${String(error).slice(0, 120)}`
  }
  return null
}

/** Remove one finding through the native API, never forced; the directory must be gone after. */
export async function removeWorktree(
  finding: WorktreeFinding,
  host: WorktreeHost,
  probe: WorktreeProbe = defaultProbe,
) {
  await host.removeWorktree(finding.path)
  return !probe.exists(finding.path)
}
