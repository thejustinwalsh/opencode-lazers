/**
 * Integration proof by change containment instead of commit ancestry.
 *
 * A commit SHA is an observation. "Is this integrated" is answered by whether
 * the target contains the change (note, patch-id, tree), with exact ancestry as
 * the cheap first check. Anything short of a proof is reported with a readable
 * reason and an Architect action; it is never a silent pass or a silent failure.
 */
import type { Database } from "bun:sqlite"
import {
  changeContained,
  commitResolves,
  gitRun,
  isAncestorAsync,
  patchIdOf,
  readChangeNote,
  treeOf,
  type ChangeEvidence,
  type Containment,
} from "./change-identity.ts"
import { readIdentity, type IdentityRow } from "./identity-store.ts"

/** Evidence computed from a live commit in the repository. */
export async function evidenceForCommit(
  directory: string,
  commit: string,
  base?: string | null,
): Promise<ChangeEvidence> {
  const note = await readChangeNote(directory, commit)
  const tree = await treeOf(directory, commit)
  let patch: Awaited<ReturnType<typeof patchIdOf>> | undefined
  if (base && (await commitResolves(directory, base)))
    patch = await patchIdOf(directory, base, commit)
  return {
    changeId: note?.changeId,
    patchId: patch?.combined,
    commitPatchIds: patch?.commits,
    tree,
    base,
    commit,
  }
}

/** First identity row recorded for a commit SHA, preferring one that carries a patch-id. */
export function identityBySha(db: Database, sha: string): IdentityRow | undefined {
  return (
    db
      .query<IdentityRow, [string]>(
        `SELECT * FROM runner_change_identity WHERE sha=?
         ORDER BY (patch_id IS NOT NULL) DESC,(change_id IS NOT NULL) DESC LIMIT 1`,
      )
      .get(sha) ?? undefined
  )
}

/**
 * Evidence from stored identity, for an artifact whose SHA may no longer
 * resolve after a history rewrite. `attemptID` adds the attempt's change id,
 * patch-ids and base tree.
 */
export function storedEvidence(
  db: Database,
  input: { artifact: string; attemptID?: string; base?: string | null },
): ChangeEvidence & { baseTree?: string | null } {
  const bySha = identityBySha(db, input.artifact)
  const attempt = input.attemptID ? readIdentity(db, "attempt", input.attemptID) : undefined
  const sameAttempt = attempt && attempt.sha === input.artifact ? attempt : undefined
  const row = sameAttempt ?? bySha
  return {
    changeId: row?.change_id ?? attempt?.change_id,
    patchId: row?.patch_id,
    commitPatchIds: row?.commit_patch_ids ? (JSON.parse(row.commit_patch_ids) as string[]) : [],
    tree: row?.tree,
    base: input.base,
    baseTree: row?.base_tree ?? attempt?.base_tree,
    commit: input.artifact,
  }
}

/** Locate the recorded base commit in the target's history by its tree when the SHA is gone. */
async function baseByTree(
  directory: string,
  target: string,
  tree: string,
): Promise<string | undefined> {
  const result = await gitRun(directory, ["log", "--format=%H %T", "-n", "2000", target])
  if (result.code !== 0) return undefined
  return result.stdout
    .split("\n")
    .map((line) => line.split(" "))
    .find((parts) => parts[1] === tree)?.[0]
}

/** Containment of stored or live evidence in `target`, resolving a vanished base by its tree. */
export async function evidenceContained(
  directory: string,
  evidence: ChangeEvidence & { baseTree?: string | null },
  target = "HEAD",
): Promise<Containment> {
  let base = evidence.base
  if ((!base || !(await commitResolves(directory, base))) && evidence.baseTree)
    base = await baseByTree(directory, target, evidence.baseTree)
  return changeContained(directory, { ...evidence, base }, target)
}

/**
 * A worktree head is safe to remove when its commit is an ancestor of the
 * target or its change is contained in the target. Anything else is
 * preserved ("unmerged"); `ambiguous` keeps its reason for the operator.
 */
export async function headContained(
  directory: string,
  head: string,
  target = "HEAD",
  base?: string | null,
): Promise<Containment> {
  try {
    if (await isAncestorAsync(directory, head, target))
      return { status: "contained", via: "ancestor", commit: head }
  } catch {
    // Fall through to content evidence.
  }
  return changeContained(directory, await evidenceForCommit(directory, head, base), target)
}

const ARCHITECT_ACTION =
  "Architect action: inspect the target branch, then record integration explicitly with the `integrated` command once the change is confirmed there, or `reconcile` to re-inspect."

/** Operator-facing explanation for a containment result that is not `contained`. */
export function containmentReason(
  result: Containment,
  subject: string,
  target = "the target",
): string {
  if (result.status === "contained") return `${subject} is contained in ${target} (${result.via}).`
  const why = result.reason ?? "No evidence found."
  return result.status === "ambiguous"
    ? `${subject} cannot be proven integrated into ${target}: ambiguous. ${why} ${ARCHITECT_ACTION}`
    : `${subject} is not integrated into ${target}. ${why} ${ARCHITECT_ACTION}`
}

/** A containment decision bound to the exact checkout HEAD it was computed against. */
export type IntegrationProof = { artifact: string; head: string; containment: Containment }

/** Prove, before any transaction, that `artifact`'s change is contained in the checkout's HEAD. */
export async function proveIntegration(
  directory: string,
  artifact: string,
  evidence: ChangeEvidence & { baseTree?: string | null },
): Promise<IntegrationProof> {
  const head = (await gitRun(directory, ["rev-parse", "HEAD"])).stdout.trim()
  const containment = await evidenceContained(directory, { ...evidence, commit: artifact }, "HEAD")
  return { artifact, head, containment }
}

/**
 * Containment proof for a stored artifact. Live commit evidence wins when the
 * SHA still resolves; stored identity covers an artifact whose SHA is gone.
 */
export async function proofForArtifact(
  read: <T>(run: (db: Database) => T) => T,
  directory: string,
  input: { artifact: string; attemptID?: string; base?: string | null },
): Promise<IntegrationProof> {
  const stored = read((db) => storedEvidence(db, input))
  const live = (await commitResolves(directory, input.artifact))
    ? await evidenceForCommit(directory, input.artifact, input.base)
    : undefined
  const evidence: ChangeEvidence & { baseTree?: string | null } = { ...stored }
  if (live?.changeId) evidence.changeId = live.changeId
  if (live?.patchId) evidence.patchId = live.patchId
  if (live?.commitPatchIds?.length) evidence.commitPatchIds = live.commitPatchIds
  if (live?.tree) evidence.tree = live.tree
  return proveIntegration(directory, input.artifact, evidence)
}

export type BaseReach = { ok: true; via: "ancestor" | "tree" } | { ok: false; reason: string }

/**
 * A plan or attempt base is an observation. It is acceptable when the commit is
 * an ancestor of the target, or when the commit no longer exists but its
 * recorded tree is reachable in the target's history.
 */
export async function baseReachable(
  directory: string,
  base: string,
  target = "HEAD",
  knownBaseTree?: string | null,
): Promise<BaseReach> {
  const resolves = await commitResolves(directory, base)
  if (resolves) {
    try {
      if (await isAncestorAsync(directory, base, target)) return { ok: true, via: "ancestor" }
    } catch {
      // Fall through to the tree check.
    }
  }
  // A live commit that is not an ancestor is a different lineage and is rejected.
  // Only a vanished commit (rewritten or pruned) falls back to its recorded tree.
  if (!resolves && knownBaseTree && (await baseByTree(directory, target, knownBaseTree)))
    return { ok: true, via: "tree" }
  return {
    ok: false,
    reason: `Base ${base.slice(0, 8)} is ${resolves ? "not an ancestor of" : "unavailable and its recorded tree is not reachable from"} ${target}. Architect action: choose a baseCommit on the current branch.`,
  }
}

/** Throws the operator-facing reason unless the proof shows containment of `artifact`. */
export function requireIntegration(
  proof: IntegrationProof | undefined,
  artifact: string,
  subject: string,
  target: string,
): string {
  if (!proof || proof.artifact !== artifact)
    throw new Error(`${subject} integration was not checked against ${target}.`)
  if (proof.containment.status !== "contained")
    throw new Error(containmentReason(proof.containment, subject, target))
  return proof.head
}
