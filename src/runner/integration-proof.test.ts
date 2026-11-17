import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { git, gitAsync } from "./artifacts.ts"
import { artifactIdentity, ensureNotesConfig, writeChangeNote } from "./change-identity.ts"
import { cleanupFixtureRepos, commitFile, fixtureRepo } from "./change-identity-fixture.ts"
import {
  equivalentShas,
  installChangeIdentity,
  knownTree,
  recordIdentity,
  sameArtifact,
} from "./identity-store.ts"
import {
  baseReachable,
  containmentReason,
  evidenceContained,
  headContained,
  requireIntegration,
  proveIntegration,
  storedEvidence,
} from "./integration-proof.ts"
import {
  evaluatePrerequisiteIntegration,
  evaluateTaskPrerequisiteIntegration,
  type PrerequisiteIntegrationRow,
  type TaskPrerequisiteIntegrationRow,
} from "./prerequisite-proof.ts"

afterEach(cleanupFixtureRepos)

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}\n`).join("")

/** main: base. worker branch: two commits on top of base, with notes and identity recorded. */
async function workerFixture() {
  const root = fixtureRepo()
  commitFile(root, "shared.txt", lines(20), "base")
  const base = git(root, ["rev-parse", "HEAD"])
  await ensureNotesConfig(root)
  git(root, ["checkout", "-b", "worker"])
  commitFile(root, "feature.txt", "feature\n", "feat: feature")
  const artifact = commitFile(root, "feature2.txt", "feature two\n", "feat: more")
  const identity = await artifactIdentity(root, base, artifact)
  const changeId = "22222222-2222-4222-8222-222222222222"
  git(root, ["checkout", "main"])
  const db = new Database(":memory:")
  installChangeIdentity(db)
  recordIdentity(db, "attempt", "attempt-1", {
    sha: artifact,
    tree: identity.tree,
    patchId: identity.patchId,
    commitPatchIds: identity.commitPatchIds,
    baseTree: git(root, ["rev-parse", `${base}^{tree}`]),
    changeId,
  })
  return { root, base, artifact, identity, changeId, db }
}

test("an artifact SHA rewritten by rebase or re-sign keeps its recorded tree and evidence equivalence", async () => {
  const { root, artifact, identity, db } = await workerFixture()
  const rewritten = git(root, ["commit-tree", `${artifact}^{tree}`, "-p", "main"], "re-signed\n", {
    GIT_AUTHOR_NAME: "rewritten",
    GIT_COMMITTER_NAME: "rewritten",
  })
  recordIdentity(db, "evidence", "receipt-1", { sha: rewritten, tree: identity.tree })
  expect(rewritten).not.toBe(artifact)
  expect(knownTree(db, artifact)).toBe(identity.tree!)
  expect(sameArtifact(db, artifact, rewritten)).toBe(true)
  expect(equivalentShas(db, artifact).toSorted()).toEqual([artifact, rewritten].toSorted())
  expect(sameArtifact(db, artifact, "0".repeat(40))).toBe(false)
  expect(sameArtifact(db, null, null)).toBe(false)
})

test("stored identity proves containment after the artifact SHA vanished (squash, no notes)", async () => {
  const { root, base, artifact, db } = await workerFixture()
  git(root, ["merge", "--squash", "worker"])
  git(root, ["commit", "-m", "squash"])
  // Simulate a rewritten history that no longer has the worker commits.
  git(root, ["branch", "-D", "worker"])
  git(root, ["reflog", "expire", "--expire=now", "--all"])
  git(root, ["gc", "--prune=now", "--quiet"])
  const gone = await Bun.spawn(["git", "cat-file", "-e", artifact], { cwd: root }).exited
  expect(gone).not.toBe(0)
  const evidence = storedEvidence(db, { artifact, attemptID: "attempt-1", base })
  const result = await evidenceContained(root, evidence, "main")
  expect(result).toMatchObject({ status: "contained", via: "patch-id" })
  const proof = await proveIntegration(root, artifact, evidence)
  expect(requireIntegration(proof, artifact, "The accepted artifact", "main")).toBe(proof.head)
})

test("a vanished base is located by its tree and a missing proof is a readable error", async () => {
  const { root, base, artifact, db } = await workerFixture()
  git(root, ["merge", "--squash", "worker"])
  git(root, ["commit", "-m", "squash"])
  const evidence = storedEvidence(db, { artifact, attemptID: "attempt-1", base: "9".repeat(40) })
  expect(evidence.baseTree).toBe(git(root, ["rev-parse", `${base}^{tree}`]))
  expect(await evidenceContained(root, evidence, "main")).toMatchObject({
    status: "contained",
    via: "patch-id",
  })
  expect(() => requireIntegration(undefined, artifact, "The accepted artifact", "main")).toThrow(
    "was not checked",
  )
  const absent = { status: "absent" as const, reason: "No commit on main carries this change." }
  expect(containmentReason(absent, "Plan abcd1234 source", "main")).toContain("Architect action")
  expect(containmentReason({ status: "ambiguous", reason: "x" }, "S", "main")).toContain(
    "ambiguous",
  )
})

test("worktree cleanup decision: rewritten history is safe to remove, unmerged work is preserved", async () => {
  const { root, base } = await workerFixture()
  // A worker worktree head rebased onto a moved main, then landed by squash.
  commitFile(root, "other.txt", "other\n", "main moves")
  git(root, ["checkout", "worker"])
  git(root, ["rebase", "main"])
  const head = git(root, ["rev-parse", "HEAD"])
  git(root, ["checkout", "main"])
  git(root, ["merge", "--squash", "worker"])
  git(root, ["commit", "-m", "squash worker"])
  expect(await headContained(root, head, "HEAD", base)).toMatchObject({ status: "contained" })

  // Unmerged commits on another branch are preserved.
  git(root, ["checkout", "-b", "unmerged"])
  const unmerged = commitFile(root, "unmerged.txt", "work\n", "wip")
  git(root, ["checkout", "main"])
  const verdict = await headContained(root, unmerged, "HEAD", base)
  expect(verdict.status).not.toBe("contained")

  // A plain ancestor head (fast-forward) is still safe.
  expect(await headContained(root, base, "HEAD")).toMatchObject({ via: "ancestor" })
})

test("a hand-resolved conflicting rewrite is ambiguous and surfaces an Architect action", async () => {
  const root = fixtureRepo()
  commitFile(root, "a.txt", lines(10), "base")
  const base = git(root, ["rev-parse", "HEAD"])
  git(root, ["checkout", "-b", "worker"])
  const artifact = commitFile(root, "a.txt", lines(10).replace("line 3", "worker 3"), "worker")
  const identity = await artifactIdentity(root, base, artifact)
  git(root, ["checkout", "main"])
  commitFile(root, "a.txt", lines(10).replace("line 3", "resolved 3"), "resolved by hand")
  const result = await evidenceContained(
    root,
    { patchId: identity.patchId, tree: identity.tree, base, commit: artifact },
    "main",
  )
  expect(result.status).toBe("ambiguous")
  expect(containmentReason(result, "The task source", "main")).toContain("Architect action")
})

test("baseline reachability accepts an ancestor, or a vanished commit by its recorded tree", async () => {
  const root = fixtureRepo()
  const first = commitFile(root, "a.txt", "one\n", "one")
  commitFile(root, "b.txt", "two\n", "two")
  const firstTree = git(root, ["rev-parse", `${first}^{tree}`])
  expect(await baseReachable(root, first)).toEqual({ ok: true, via: "ancestor" })
  // A live commit of the same tree that is not an ancestor is a different lineage.
  const twin = git(root, ["commit-tree", `${first}^{tree}`], "twin\n")
  expect(await baseReachable(root, twin, "HEAD", firstTree)).toMatchObject({ ok: false })
  // A vanished commit is judged by its recorded tree.
  const vanished = "9".repeat(40)
  expect(await baseReachable(root, vanished, "HEAD", firstTree)).toEqual({ ok: true, via: "tree" })
  const gone = await baseReachable(root, vanished)
  expect(gone.ok).toBe(false)
  if (!gone.ok) expect(gone.reason).toContain("Architect action")
})

test("a dependent's prerequisite proof holds for an integrated plan after history is rewritten", async () => {
  const { root, base, artifact, identity, changeId, db } = await workerFixture()
  await writeChangeNote(root, artifact, { changeId, taskId: "t", attemptId: "attempt-1" })
  // main integrates the work by squash: ancestry of the recorded artifact is gone.
  git(root, ["merge", "--squash", "worker"])
  git(root, ["commit", "-m", "squash integrate"])
  const baseline = git(root, ["rev-parse", "HEAD"])
  const directory = root
  const head = "e".repeat(40)
  const planRow: PrerequisiteIntegrationRow = {
    plan_id: "parent",
    project_directory: directory,
    state: "integrated",
    artifact,
    accepted_id: 2,
    accepted_version: 3,
    accepted_payload: JSON.stringify({ artifact }),
    integration_id: 4,
    integration_version: 3,
    integration_payload: JSON.stringify({ artifact, head, branch: "main", reason: "reviewed" }),
    invalidation_id: 1,
  }
  const lookup = (sha: string) =>
    storedEvidence(db, { artifact: sha, attemptID: "attempt-1", base })
  const reasons: string[] = []
  // The worker commits are not ancestors of main (squash), yet the plan proves integrated.
  expect(
    await evaluatePrerequisiteIntegration(
      directory,
      ["parent"],
      [planRow],
      gitAsync,
      baseline,
      lookup,
      (reason) => reasons.push(reason),
    ),
  ).toBe(baseline)
  expect(reasons).toEqual([])

  const taskRow: TaskPrerequisiteIntegrationRow = {
    plan_id: "plan",
    task_id: "task-a",
    project_directory: directory,
    node_state: "accepted",
    artifact,
    integration_id: 12,
    integration_payload: JSON.stringify({ artifact, branch: "main", head }),
  }
  expect(
    await evaluateTaskPrerequisiteIntegration(
      directory,
      "main",
      ["task-a"],
      [taskRow],
      gitAsync,
      baseline,
      lookup,
    ),
  ).toEqual({ status: "ready", baseline })

  // Without recorded identity and without ancestry the proof fails closed with a reason.
  const unproven = await evaluatePrerequisiteIntegration(
    directory,
    ["parent"],
    [planRow],
    gitAsync,
    baseline,
    undefined,
    (reason) => reasons.push(reason),
  )
  expect(unproven).toBeUndefined()
  expect(reasons[0]).toContain("Architect action")
  expect(identity.patchId).toBeTruthy()
})
