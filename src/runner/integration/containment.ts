import {
  CHANGE_NOTES_REF,
  changeIDFromNote,
  commitResolves,
  combinedPatchID,
  gitRun,
  isAncestorAsync,
  isObjectID,
  MAX_CHANGE_RANGE_COMMITS,
  parsePatchIDs,
  treeOf,
} from "./git.ts"

/** Evidence recorded for one candidate change. */
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

const MAX_RUN_COMMITS = 40
const MAX_RUN_START_COMMITS = 400
const MAX_RUN_DIFFS = 300
const run = gitRun

type RangeCommit = { commit: string; tree: string; note?: string }

async function readRange(directory: string, range: string): Promise<RangeCommit[] | undefined> {
  const result = await run(directory, [
    "log",
    `--notes=${CHANGE_NOTES_REF}`,
    "--format=%H%x1f%T%x1f%N%x1e",
    "-n",
    String(MAX_CHANGE_RANGE_COMMITS),
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
  const notes = await run(directory, ["rev-parse", "--verify", "--quiet", CHANGE_NOTES_REF])
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

  if (await ancestorMatch(directory, evidence.commit, targetSha))
    return { status: "contained", via: "ancestor", commit: evidence.commit! }

  const baseKnown = Boolean(evidence.base) && (await commitResolves(directory, evidence.base!))
  const range =
    (await readRange(directory, baseKnown ? `${evidence.base}..${targetSha}` : targetSha)) ?? []
  return contentContainment(directory, evidence, target, targetSha, baseKnown, range)
}

async function contentContainment(
  directory: string,
  evidence: ChangeEvidence,
  target: string,
  targetSha: string,
  baseKnown: boolean,
  range: readonly RangeCommit[],
): Promise<Containment> {
  const note = noteContainment(evidence, range)
  if (note) return note

  const patch = await patchContainment(directory, evidence, targetSha, baseKnown, range)
  if (patch.containment) return patch.containment

  const tree = await treeContainment(directory, evidence, targetSha, baseKnown, range)
  if (tree) return tree
  if (patch.partial)
    return {
      status: "ambiguous",
      reason: "Only some of the change's commits were found on the target.",
    }
  return missingContainment(evidence, target)
}

async function ancestorMatch(
  directory: string,
  commit: string | null | undefined,
  target: string,
): Promise<boolean> {
  if (!commit || !(await commitResolves(directory, commit))) return false
  try {
    return await isAncestorAsync(directory, commit, target)
  } catch {
    // Fall through to content evidence.
    return false
  }
}

function noteContainment(
  evidence: ChangeEvidence,
  range: readonly RangeCommit[],
): Containment | undefined {
  if (!evidence.changeId) return undefined
  const match = range.find((entry) => changeIDFromNote(entry.note ?? "") === evidence.changeId)
  return match ? { status: "contained", via: "note", commit: match.commit } : undefined
}

async function patchContainment(
  directory: string,
  evidence: ChangeEvidence,
  target: string,
  baseKnown: boolean,
  range: readonly RangeCommit[],
): Promise<{ containment?: Containment; partial: boolean }> {
  const ids = range.length
    ? await rangePatchIDs(directory, baseKnown ? `${evidence.base}..${target}` : target)
    : []
  const byPatch = patchIDsByCommit(ids)
  const direct = directPatchMatch(evidence.patchId, byPatch)
  if (direct) return { containment: direct, partial: false }

  const replay = replayedPatchMatch(evidence.commitPatchIds, ids, byPatch)
  if (replay.containment) return replay
  if (evidence.patchId && baseKnown && !byPatch.has(evidence.patchId)) {
    const run = await contiguousRun(
      directory,
      ids.map((entry) => entry.commit),
      evidence.patchId,
      await runFilter(directory, evidence, `${evidence.base}..${target}`),
    )
    if (run)
      return {
        containment: { status: "contained", via: "patch-id", commit: run },
        partial: replay.partial,
      }
  }
  return replay
}

function patchIDsByCommit(ids: readonly { patchId: string; commit: string }[]) {
  const byPatch = new Map<string, string[]>()
  for (const entry of ids)
    byPatch.set(entry.patchId, [...(byPatch.get(entry.patchId) ?? []), entry.commit])
  return byPatch
}

function directPatchMatch(
  patchId: string | null | undefined,
  byPatch: ReadonlyMap<string, readonly string[]>,
): Containment | undefined {
  if (!patchId) return undefined
  const hits = byPatch.get(patchId) ?? []
  if (hits.length === 1) return { status: "contained", via: "patch-id", commit: hits[0] }
  if (hits.length > 1)
    return {
      status: "ambiguous",
      reason: `Several main commits share this change's patch-id (${hits.map((hit) => hit.slice(0, 8)).join(", ")}); cannot tell which integrated it.`,
    }
  return undefined
}

function replayedPatchMatch(
  commitPatchIds: readonly string[] | undefined,
  ids: readonly { patchId: string; commit: string }[],
  byPatch: ReadonlyMap<string, readonly string[]>,
): { containment?: Containment; partial: boolean } {
  if (!commitPatchIds?.length) return { partial: false }
  const matched = commitPatchIds.map((patchId) => byPatch.get(patchId)?.[0])
  if (matched.every(Boolean)) {
    // Replayed one commit at a time, in order.
    const order = ids.map((entry) => entry.commit)
    const positions = matched.map((commit) => order.indexOf(commit!))
    const ordered = positions.every(
      (position, index) => index === 0 || position > positions[index - 1]!,
    )
    if (ordered)
      return {
        containment: { status: "contained", via: "patch-id", commit: matched.at(-1) },
        partial: false,
      }
  }
  return { partial: matched.some(Boolean) }
}

async function treeContainment(
  directory: string,
  evidence: ChangeEvidence,
  target: string,
  baseKnown: boolean,
  range: readonly RangeCommit[],
): Promise<Containment | undefined> {
  if (!evidence.tree) return undefined
  const same = range.find((entry) => entry.tree === evidence.tree)
  if (same) return { status: "contained", via: "tree", commit: same.commit }
  if ((await treeOf(directory, target)) === evidence.tree)
    return { status: "contained", via: "tree", commit: target }
  return mergeTreeContainment(directory, evidence, target, baseKnown)
}

async function mergeTreeContainment(
  directory: string,
  evidence: ChangeEvidence,
  target: string,
  baseKnown: boolean,
): Promise<Containment | undefined> {
  if (!baseKnown || !evidence.commit || !(await commitResolves(directory, evidence.commit)))
    return undefined

  // Already-present check without a checkout: merging the change into the
  // target with the recorded base is a no-op exactly when the target has it.
  const merged = await run(directory, [
    "merge-tree",
    "--write-tree",
    `--merge-base=${evidence.base}`,
    target,
    evidence.commit,
  ])
  if (merged.code === 0 && merged.stdout.split(/\s/, 1)[0] === (await treeOf(directory, target)))
    return { status: "contained", via: "tree", commit: target }
  if (merged.code === 1)
    return {
      status: "ambiguous",
      reason:
        "The change overlaps later modifications on the target; it was neither found nor provably absent.",
    }
  return undefined
}

function missingContainment(evidence: ChangeEvidence, target: string): Containment {
  if (!evidence.changeId && !evidence.patchId && !evidence.tree && !evidence.commit)
    return { status: "absent", reason: "No change identity is recorded for this artifact." }
  return { status: "absent", reason: `No commit on ${target} carries this change.` }
}

async function rangePatchIDs(directory: string, rangeSpec: string) {
  const log = await run(directory, [
    "log",
    "-p",
    "--no-merges",
    "--no-color",
    "--no-ext-diff",
    "-n",
    String(MAX_CHANGE_RANGE_COMMITS),
    rangeSpec,
  ])
  if (log.code !== 0 || !log.stdout) return []
  const patch = await run(directory, ["patch-id", "--stable"], `${log.stdout}\n`)
  // `git log` is newest first; keep that order, oldest-first callers reverse as needed.
  return parsePatchIDs(patch.stdout).reverse()
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

/** What a run must touch to be the change, and what each candidate commit touches. */
type RunFilter = { changeFiles: ReadonlySet<string>; commitFiles: ReadonlyMap<string, Set<string>> }

async function pathsByCommit(directory: string, range: string) {
  const log = await run(directory, [
    "log",
    "--name-only",
    "--no-merges",
    "--format=%x1e%H",
    "-n",
    String(MAX_CHANGE_RANGE_COMMITS),
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
    if (budget === 0) return undefined
    const result = await findRunFromStart(directory, starts, from, patchId, filter, budget)
    if (result.commit) return result.commit
    budget = result.budget
  }
  return undefined
}

type RunStartResult = { commit?: string; budget: number }

async function findRunFromStart(
  directory: string,
  commits: readonly string[],
  from: number,
  patchId: string,
  filter: RunFilter | undefined,
  budget: number,
): Promise<RunStartResult> {
  const first = commits[from]!
  const union = new Set(filter?.commitFiles.get(first) ?? [])
  const last = Math.min(commits.length, from + MAX_RUN_COMMITS)
  for (let to = from + 1; to < last; to++) {
    const commit = commits[to]!
    for (const file of filter?.commitFiles.get(commit) ?? []) union.add(file)
    if (filter && !coversChange(union, filter.changeFiles)) continue
    if (budget === 0) return { budget }
    budget--
    if ((await combinedPatchID(directory, `${first}^`, commit)) === patchId)
      return { commit, budget }
  }
  return { budget }
}
