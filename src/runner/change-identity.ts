/**
 * Stable change identity. Commit SHAs are observations; identity and proof use
 * a per-attempt change id (carried as a git note), `git patch-id --stable`, and
 * tree OIDs. See .agents/plans/stable-change-identity.md.
 *
 * Every Git call here is asynchronous: nothing in this module blocks the event loop.
 */
import { execFile } from "node:child_process"

const NOTES_REF = "refs/notes/lazers"
const NOTES_NAME = "lazers"
/** Bound the history window so a stale base cannot make containment checks unbounded. */
const MAX_RANGE_COMMITS = 2000
const MAX_RUN_COMMITS = 40
const MAX_RUN_START_COMMITS = 400

const objectID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
export const isObjectID = (value: unknown): value is string =>
  typeof value === "string" && objectID.test(value)

export type Run = { code: number; stdout: string; stderr: string }

/**
 * Run git without throwing on a non-zero exit; callers interpret exit codes.
 * Uses `execFile` (like `gitAsync`) so nothing blocks the event loop.
 */
export function gitRun(directory: string, args: string[], input?: string): Promise<Run> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        "git",
        args,
        {
          cwd: directory,
          encoding: "utf8",
          timeout: 60_000,
          maxBuffer: 128 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : 127) : 0
          resolve({
            code,
            stdout: stdout.trimEnd(),
            stderr: (stderr || (error ? error.message : "")).trimEnd(),
          })
        },
      )
      child.stdin?.on("error", () => {})
      child.stdin?.end(input)
    } catch (error) {
      // An unavailable directory or git binary is an observation failure, not a crash.
      resolve({
        code: 127,
        stdout: "",
        stderr: error instanceof Error ? error.message : "spawn failed",
      })
    }
  })
}

const run = gitRun

async function must(directory: string, args: string[], input?: string): Promise<string> {
  const result = await run(directory, args, input)
  if (result.code !== 0)
    throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).slice(0, 2000)}`)
  return result.stdout
}

/** Tree OID of a commit (or tree-ish); undefined when it does not resolve. */
export async function treeOf(directory: string, commit: string): Promise<string | undefined> {
  const result = await run(directory, ["rev-parse", "--verify", "--quiet", `${commit}^{tree}`])
  return result.code === 0 && isObjectID(result.stdout) ? result.stdout : undefined
}

export async function commitResolves(directory: string, commit: string): Promise<boolean> {
  const result = await run(directory, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`])
  return result.code === 0 && isObjectID(result.stdout)
}

/** Normal non-ancestor is `false`; an unreadable repository throws. */
export async function isAncestorAsync(
  directory: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await run(directory, ["merge-base", "--is-ancestor", ancestor, descendant])
  if (result.code === 0) return true
  if (result.code === 1) return false
  throw new Error(`git merge-base --is-ancestor failed: ${result.stderr.slice(0, 500)}`)
}

function parsePatchIDs(output: string): Array<{ patchId: string; commit: string }> {
  return output
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 2 && isObjectID(parts[1]))
    .map(([patchId, commit]) => ({ patchId: patchId!, commit: commit! }))
}

/** Stable patch-id of a diff, or undefined for an empty diff. */
async function combinedPatchID(directory: string, from: string, to: string) {
  const diff = await run(directory, ["diff", "--no-color", "--no-ext-diff", `${from}..${to}`])
  if (diff.code !== 0 || !diff.stdout) return undefined
  const result = await run(directory, ["patch-id", "--stable"], `${diff.stdout}\n`)
  return result.code === 0 ? result.stdout.split(/\s+/)[0] || undefined : undefined
}

export type PatchIdentity = {
  /** `git diff base..head | git patch-id --stable`; undefined for an empty diff. */
  combined: string | undefined
  /** Per-commit patch-ids, oldest first, for the non-merge commits in `base..head`. */
  commits: string[]
}

export async function patchIdOf(
  directory: string,
  base: string,
  head: string,
): Promise<PatchIdentity> {
  const combined = await combinedPatchID(directory, base, head)
  const log = await run(directory, [
    "log",
    "-p",
    "--no-merges",
    "--reverse",
    "--no-color",
    "--no-ext-diff",
    "-n",
    String(MAX_RANGE_COMMITS),
    `${base}..${head}`,
  ])
  const commits =
    log.code === 0 && log.stdout
      ? parsePatchIDs(
          (await run(directory, ["patch-id", "--stable"], `${log.stdout}\n`)).stdout,
        ).map((entry) => entry.patchId)
      : []
  return { combined, commits }
}

export type ChangeNote = { changeId: string; taskId?: string; attemptId?: string }

function formatChangeNote(note: ChangeNote): string {
  return [
    `change: ${note.changeId}`,
    ...(note.taskId ? [`task: ${note.taskId}`] : []),
    ...(note.attemptId ? [`attempt: ${note.attemptId}`] : []),
  ].join("\n")
}

function parseChangeNote(body: string): ChangeNote | undefined {
  const field = (name: string) => new RegExp(`^${name}:\\s*(\\S+)\\s*$`, "m").exec(body)?.[1]
  const changeId = field("change")
  return changeId ? { changeId, taskId: field("task"), attemptId: field("attempt") } : undefined
}

/** Write the note on a commit. Returns false when the note could not be recorded; fallbacks still apply. */
export async function writeChangeNote(
  directory: string,
  commit: string,
  note: ChangeNote,
): Promise<boolean> {
  // Parallel worktrees share one notes ref, so a lock collision is retried.
  for (let attempt = 0; attempt < 6; attempt++) {
    const result = await run(directory, [
      "notes",
      `--ref=${NOTES_NAME}`,
      "add",
      "-f",
      "-m",
      formatChangeNote(note),
      commit,
    ])
    if (result.code === 0) return true
    if (!/lock|exist/i.test(result.stderr)) return false
    await Bun.sleep(25 * (attempt + 1))
  }
  return false
}

export async function readChangeNote(
  directory: string,
  commit: string,
): Promise<ChangeNote | undefined> {
  const result = await run(directory, ["notes", `--ref=${NOTES_NAME}`, "show", commit])
  return result.code === 0 ? parseChangeNote(result.stdout) : undefined
}

async function configValues(directory: string, key: string): Promise<string[]> {
  const result = await run(directory, ["config", "--local", "--get-all", key])
  return result.code === 0 ? result.stdout.split("\n").filter(Boolean) : []
}

async function ensureConfigValue(directory: string, key: string, value: string) {
  if ((await configValues(directory, key)).includes(value)) return
  await must(directory, ["config", "--local", "--add", key, value])
}

/**
 * Idempotent repo-local notes plumbing: carry notes through amend and rebase,
 * and fetch them with the remote. Push behavior is never configured here: a bare
 * `git push` behaves as the user set it; use `pushChangeNotes` explicitly.
 */
export async function ensureNotesConfig(directory: string, remote = "origin"): Promise<void> {
  await ensureConfigValue(directory, "notes.rewriteRef", NOTES_REF)
  const remotes = (await run(directory, ["remote"])).stdout.split("\n").filter(Boolean)
  if (!remotes.includes(remote)) return
  await ensureConfigValue(directory, `remote.${remote}.fetch`, "+refs/notes/*:refs/notes/*")
}

/** Push the notes ref to `remote`. Never throws; false means the push did not happen. */
export async function pushChangeNotes(directory: string, remote = "origin"): Promise<boolean> {
  const result = await run(directory, ["push", remote, `${NOTES_REF}:${NOTES_REF}`])
  return result.code === 0
}

export type ChangeEvidence = {
  changeId?: string | null
  patchId?: string | null
  /** Per-commit patch-ids of the change, used when the whole change was replayed commit by commit. */
  commitPatchIds?: readonly string[]
  tree?: string | null
  base?: string | null
  /** The artifact commit, used only as an exact-ancestor fast path. */
  commit?: string | null
}

export type Containment = {
  status: "contained" | "absent" | "ambiguous"
  via?: "ancestor" | "note" | "patch-id" | "tree"
  commit?: string
  /** Human-readable explanation, always present unless `contained`. */
  reason?: string
}

type RangeCommit = { commit: string; tree: string; note?: string }

async function readRange(directory: string, range: string): Promise<RangeCommit[] | undefined> {
  const result = await run(directory, [
    "log",
    `--notes=${NOTES_NAME}`,
    "--format=%H%x1f%T%x1f%N%x1e",
    "-n",
    String(MAX_RANGE_COMMITS),
    range,
  ])
  if (result.code !== 0) return undefined
  return result.stdout
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [commit = "", tree = "", note = ""] = record.split("\x1f")
      return { commit, tree, note }
    })
    .filter((entry) => isObjectID(entry.commit))
}

/**
 * Decide whether a change is contained in `target`. Evidence order: exact
 * ancestry, change-id note, patch-id (single commit, whole replay, or a
 * contiguous squash run), then tree containment. Conservative: partial or
 * conflicting evidence is `ambiguous`, never `contained`.
 */
export async function changeContained(
  directory: string,
  evidence: ChangeEvidence,
  target = "main",
): Promise<Containment> {
  const targetCommit = await run(directory, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${target}^{commit}`,
  ])
  // Notes can arrive after the target commit, so the notes ref is part of what the proof saw.
  const notes = await run(directory, ["rev-parse", "--verify", "--quiet", NOTES_REF])
  const key = JSON.stringify([directory, evidence, targetCommit.stdout, notes.stdout, target])
  const known = containmentCache.get(key)
  if (known) return known
  const result = await computeContainment(directory, evidence, target)
  // An unresolved target is not a stable fact; everything else is a function of the key.
  if (targetCommit.code === 0) {
    if (containmentCache.size >= CONTAINMENT_CACHE_LIMIT)
      containmentCache.delete(containmentCache.keys().next().value!)
    containmentCache.set(key, result)
  }
  return result
}

const CONTAINMENT_CACHE_LIMIT = 128
/** Containment of one change identity in one exact target commit never changes while both exist. */
const containmentCache = new Map<string, Containment>()
let containmentComputations = 0
export const containmentComputationCount = () => containmentComputations

async function computeContainment(
  directory: string,
  evidence: ChangeEvidence,
  target: string,
): Promise<Containment> {
  containmentComputations++
  const targetCommit = await run(directory, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${target}^{commit}`,
  ])
  if (targetCommit.code !== 0 || !isObjectID(targetCommit.stdout))
    return { status: "absent", reason: `Integration target ${target} does not resolve.` }
  const targetSha = targetCommit.stdout

  if (evidence.commit && (await commitResolves(directory, evidence.commit))) {
    try {
      if (await isAncestorAsync(directory, evidence.commit, targetSha))
        return { status: "contained", via: "ancestor", commit: evidence.commit }
    } catch {
      // Fall through to content evidence.
    }
  }

  const baseKnown = Boolean(evidence.base) && (await commitResolves(directory, evidence.base!))
  const range =
    (await readRange(directory, baseKnown ? `${evidence.base}..${targetSha}` : targetSha)) ?? []

  // 1. Change-id note.
  if (evidence.changeId) {
    const match = range.find(
      (entry) => parseChangeNote(entry.note ?? "")?.changeId === evidence.changeId,
    )
    if (match) return { status: "contained", via: "note", commit: match.commit }
  }

  // 2. Patch-id.
  let partial = false
  const ids = range.length
    ? await rangePatchIDs(directory, baseKnown ? `${evidence.base}..${targetSha}` : targetSha)
    : []
  const byPatch = new Map<string, string[]>()
  for (const entry of ids)
    byPatch.set(entry.patchId, [...(byPatch.get(entry.patchId) ?? []), entry.commit])
  if (evidence.patchId) {
    const hits = byPatch.get(evidence.patchId) ?? []
    if (hits.length === 1) return { status: "contained", via: "patch-id", commit: hits[0] }
    if (hits.length > 1)
      return {
        status: "ambiguous",
        reason: `Several main commits share this change's patch-id (${hits.map((hit) => hit.slice(0, 8)).join(", ")}); cannot tell which integrated it.`,
      }
  }
  if (evidence.commitPatchIds?.length) {
    const matched = evidence.commitPatchIds.map((patchId) => byPatch.get(patchId)?.[0])
    if (matched.every(Boolean)) {
      // Replayed one commit at a time, in order.
      const order = ids.map((entry) => entry.commit)
      const positions = matched.map((commit) => order.indexOf(commit!))
      const ordered = positions.every(
        (position, index) => index === 0 || position > positions[index - 1]!,
      )
      if (ordered) return { status: "contained", via: "patch-id", commit: matched.at(-1) }
    }
    partial = matched.some(Boolean)
  }
  // Squash of several commits: a contiguous run whose combined patch-id matches.
  if (evidence.patchId && baseKnown && !byPatch.has(evidence.patchId)) {
    const run = await contiguousRun(
      directory,
      ids.map((entry) => entry.commit),
      evidence.patchId,
      await runFilter(directory, evidence, `${evidence.base}..${targetSha}`),
    )
    if (run) return { status: "contained", via: "patch-id", commit: run }
  }

  // 3. Tree containment.
  if (evidence.tree) {
    const same = range.find((entry) => entry.tree === evidence.tree)
    if (same) return { status: "contained", via: "tree", commit: same.commit }
    if ((await treeOf(directory, targetSha)) === evidence.tree)
      return { status: "contained", via: "tree", commit: targetSha }
  }
  if (
    baseKnown &&
    evidence.tree &&
    evidence.commit &&
    (await commitResolves(directory, evidence.commit))
  ) {
    // Already-present check without a checkout: merging the change into the
    // target with the recorded base is a no-op exactly when the target has it.
    const merged = await run(directory, [
      "merge-tree",
      "--write-tree",
      `--merge-base=${evidence.base}`,
      targetSha,
      evidence.commit,
    ])
    if (
      merged.code === 0 &&
      merged.stdout.split(/\s/, 1)[0] === (await treeOf(directory, targetSha))
    )
      return { status: "contained", via: "tree", commit: targetSha }
    if (merged.code === 1)
      return {
        status: "ambiguous",
        reason:
          "The change overlaps later modifications on the target; it was neither found nor provably absent.",
      }
  }

  if (partial)
    return {
      status: "ambiguous",
      reason: "Only some of the change's commits were found on the target.",
    }
  if (!evidence.changeId && !evidence.patchId && !evidence.tree && !evidence.commit)
    return { status: "absent", reason: "No change identity is recorded for this artifact." }
  return { status: "absent", reason: `No commit on ${target} carries this change.` }
}

async function runFilter(
  directory: string,
  evidence: ChangeEvidence,
  range: string,
): Promise<RunFilter | undefined> {
  if (!evidence.base || !evidence.commit || !(await commitResolves(directory, evidence.commit)))
    return undefined
  const changeFiles = await changedPaths(directory, evidence.base, evidence.commit)
  if (!changeFiles?.size) return undefined
  return { changeFiles, commitFiles: await pathsByCommit(directory, range) }
}

async function rangePatchIDs(directory: string, rangeSpec: string) {
  const log = await run(directory, [
    "log",
    "-p",
    "--no-merges",
    "--no-color",
    "--no-ext-diff",
    "-n",
    String(MAX_RANGE_COMMITS),
    rangeSpec,
  ])
  if (log.code !== 0 || !log.stdout) return []
  const patch = await run(directory, ["patch-id", "--stable"], `${log.stdout}\n`)
  // `git log` is newest first; keep that order, oldest-first callers reverse as needed.
  return parsePatchIDs(patch.stdout).reverse()
}

/** What a run must touch to be the change, and what each candidate commit touches. */
type RunFilter = { changeFiles: ReadonlySet<string>; commitFiles: ReadonlyMap<string, Set<string>> }

/** Combined patch-id computations one squash search may spend; each is two git processes. */
const MAX_RUN_DIFFS = 300

async function pathsByCommit(directory: string, range: string) {
  const log = await run(directory, [
    "log",
    "--name-only",
    "--no-merges",
    "--format=%x1e%H",
    "-n",
    String(MAX_RANGE_COMMITS),
    range,
  ])
  const files = new Map<string, Set<string>>()
  if (log.code !== 0) return files
  for (const record of log.stdout.split("\x1e")) {
    const [commit = "", ...paths] = record.split("\n").map((line) => line.trim())
    if (isObjectID(commit)) files.set(commit, new Set(paths.filter(Boolean)))
  }
  return files
}

/** The files the change touches, or undefined when they cannot be read. */
async function changedPaths(directory: string, base: string, commit: string) {
  const result = await run(directory, ["diff", "--name-only", `${base}..${commit}`])
  return result.code === 0 ? new Set(result.stdout.split("\n").filter(Boolean)) : undefined
}

function coversChange(union: ReadonlySet<string>, changeFiles: ReadonlySet<string>) {
  for (const file of changeFiles) if (!union.has(file)) return false
  return true
}

/**
 * Find a contiguous run of (oldest-first) commits whose combined diff has the wanted patch-id.
 * A run that does not touch every file of the change cannot equal it, so only covering runs are
 * diffed, and the search stops after a fixed number of diffs: it never scales with history length.
 */
async function contiguousRun(
  directory: string,
  oldestFirst: string[],
  patchId: string,
  filter?: RunFilter,
): Promise<string | undefined> {
  const starts = oldestFirst.slice(-MAX_RUN_START_COMMITS)
  let budget = MAX_RUN_DIFFS
  for (let from = 0; from < starts.length; from++) {
    const union = new Set(filter?.commitFiles.get(starts[from]!) ?? [])
    for (let to = from + 1; to < Math.min(starts.length, from + MAX_RUN_COMMITS); to++) {
      for (const file of filter?.commitFiles.get(starts[to]!) ?? []) union.add(file)
      if (filter && !coversChange(union, filter.changeFiles)) continue
      if (budget-- <= 0) return undefined
      const id = await combinedPatchID(directory, `${starts[from]}^`, starts[to]!)
      if (id === patchId) return starts[to]
    }
  }
  return undefined
}

/** Everything recorded for one artifact commit. */
export type ArtifactIdentity = {
  tree: string | undefined
  patchId: string | undefined
  commitPatchIds: string[]
}

export async function artifactIdentity(
  directory: string,
  base: string | undefined,
  commit: string,
): Promise<ArtifactIdentity> {
  const tree = await treeOf(directory, commit)
  if (!base || !(await commitResolves(directory, base)))
    return { tree, patchId: undefined, commitPatchIds: [] }
  const patch = await patchIdOf(directory, base, commit)
  return { tree, patchId: patch.combined, commitPatchIds: patch.commits }
}
