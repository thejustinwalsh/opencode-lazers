import { afterEach, expect, test } from "bun:test"
import { cleanupFixtureRepos, commitFile, fixtureRepo } from "./change-identity-fixture.ts"
import { git } from "./artifacts.ts"
import { changeContained, containmentComputationCount } from "./integration/containment.ts"
import {
  artifactIdentity,
  ensureNotesConfig,
  pushChangeNotes,
  readChangeNote,
  treeOf,
  writeChangeNote,
} from "./change-identity.ts"

afterEach(cleanupFixtureRepos)

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}\n`).join("")

/** main has a base; a worker branch adds two commits; returns the artifact and its identity. */
async function workerBranch() {
  const root = fixtureRepo()
  commitFile(root, "shared.txt", lines(20), "base")
  const base = git(root, ["rev-parse", "HEAD"])
  git(root, ["checkout", "-b", "worker"])
  commitFile(root, "feature.txt", "feature\n", "feat: feature")
  const artifact = commitFile(root, "feature2.txt", "feature two\n", "feat: more")
  const identity = await artifactIdentity(root, base, artifact)
  git(root, ["checkout", "main"])
  const evidence = {
    changeId: "11111111-1111-4111-8111-111111111111",
    patchId: identity.patchId,
    commitPatchIds: identity.commitPatchIds,
    tree: identity.tree,
    base,
    commit: artifact as string | undefined,
  }
  return { root, base, artifact, evidence }
}

test("records tree, combined patch-id and per-commit patch-ids", async () => {
  const { root, artifact, evidence } = await workerBranch()
  expect(evidence.tree).toBe(await treeOf(root, artifact))
  expect(evidence.patchId).toMatch(/^[a-f0-9]{40}/)
  expect(evidence.commitPatchIds).toHaveLength(2)
})

test("absent when main lacks the change", async () => {
  const { root, evidence } = await workerBranch()
  const result = await changeContained(root, evidence, "main")
  expect(result.status).toBe("absent")
  expect(result.reason).toBeTruthy()
})

test("a clean rebase keeps containment via the carried note", async () => {
  const { root, artifact, evidence } = await workerBranch()
  await ensureNotesConfig(root)
  expect(
    await writeChangeNote(root, artifact, {
      changeId: evidence.changeId,
      taskId: "t",
      attemptId: "a",
    }),
  ).toBe(true)
  expect((await readChangeNote(root, artifact))?.changeId).toBe(evidence.changeId)
  commitFile(root, "other.txt", "other\n", "main moves")
  git(root, ["checkout", "worker"])
  git(root, ["rebase", "main"])
  const rebased = git(root, ["rev-parse", "HEAD"])
  expect(rebased).not.toBe(artifact)
  expect((await readChangeNote(root, rebased))?.changeId).toBe(evidence.changeId)
  git(root, ["checkout", "main"])
  git(root, ["merge", "--ff-only", "worker"])
  const result = await changeContained(root, { ...evidence, commit: undefined }, "main")
  expect(result).toMatchObject({ status: "contained", via: "note" })
})

test("an identity rewrite is contained via patch-id when notes are lost", async () => {
  const { root, base, artifact, evidence } = await workerBranch()
  git(root, ["checkout", "worker"])
  git(root, ["rebase", base, "--exec", "git commit --amend --no-edit --reset-author"], undefined, {
    GIT_AUTHOR_NAME: "rewritten",
    GIT_COMMITTER_NAME: "rewritten",
    GIT_AUTHOR_DATE: "2030-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2030-01-01T00:00:00Z",
  })
  expect(git(root, ["rev-parse", "HEAD"])).not.toBe(artifact)
  git(root, ["checkout", "main"])
  git(root, ["merge", "--ff-only", "worker"])
  const result = await changeContained(
    root,
    { ...evidence, changeId: "unknown", commit: undefined },
    "main",
  )
  expect(result.status).toBe("contained")
  expect(["patch-id", "tree"]).toContain(result.via!)
})

test("a squash merge without notes matches the combined patch-id", async () => {
  const { root, evidence } = await workerBranch()
  git(root, ["merge", "--squash", "worker"])
  git(root, ["commit", "-m", "squash: feature"])
  const result = await changeContained(root, { ...evidence, commit: undefined }, "main")
  expect(result).toMatchObject({ status: "contained", via: "patch-id" })
})

test("a squash landing after unrelated commits still matches by patch-id", async () => {
  const { root, evidence } = await workerBranch()
  commitFile(root, "unrelated.txt", "x\n", "unrelated")
  git(root, ["merge", "--squash", "worker"])
  git(root, ["commit", "-m", "squash: feature"])
  const result = await changeContained(root, { ...evidence, commit: undefined }, "main")
  expect(result).toMatchObject({ status: "contained", via: "patch-id" })
})

test("a hand-resolved conflicting rebase without notes is ambiguous with a reason", async () => {
  const root = fixtureRepo()
  commitFile(root, "a.txt", lines(10), "base")
  const base = git(root, ["rev-parse", "HEAD"])
  git(root, ["checkout", "-b", "worker"])
  const artifact = commitFile(root, "a.txt", lines(10).replace("line 3", "worker 3"), "worker")
  const identity = await artifactIdentity(root, base, artifact)
  git(root, ["checkout", "main"])
  commitFile(root, "a.txt", lines(10).replace("line 3", "resolved 3"), "main resolved")
  const result = await changeContained(
    root,
    { changeId: "x", patchId: identity.patchId, tree: identity.tree, base, commit: artifact },
    "main",
  )
  expect(result.status).toBe("ambiguous")
  expect(result.reason).toMatch(/overlaps/)
})

test("tree containment: main has a commit with the artifact tree", async () => {
  const { root, evidence } = await workerBranch()
  const tree = git(root, ["rev-parse", "worker^{tree}"])
  const rewritten = git(root, ["commit-tree", tree, "-p", "HEAD"], "rewrite")
  git(root, ["merge", "--ff-only", rewritten])
  const result = await changeContained(
    root,
    { ...evidence, changeId: undefined, patchId: undefined, commitPatchIds: [], commit: undefined },
    "main",
  )
  expect(result).toMatchObject({ status: "contained", via: "tree" })
})

test("ensureNotesConfig is idempotent, adds only the fetch refspec, and never edits push config", async () => {
  const root = fixtureRepo()
  await ensureNotesConfig(root)
  await ensureNotesConfig(root)
  expect(git(root, ["config", "--local", "--get-all", "notes.rewriteRef"])).toBe(
    "refs/notes/lazers",
  )
  expect(() => git(root, ["config", "--local", "--get-all", "remote.origin.fetch"])).toThrow()
  git(root, ["remote", "add", "origin", "https://example.invalid/r.git"])
  await ensureNotesConfig(root)
  await ensureNotesConfig(root)
  const fetch = git(root, ["config", "--local", "--get-all", "remote.origin.fetch"]).split("\n")
  expect(fetch.filter((line) => line === "+refs/notes/*:refs/notes/*")).toHaveLength(1)
  expect(() => git(root, ["config", "--local", "--get-all", "remote.origin.push"])).toThrow()
})

test("pushChangeNotes pushes the notes ref and returns false instead of throwing", async () => {
  const { root, artifact } = await workerBranch()
  await writeChangeNote(root, artifact, { changeId: "c" })
  const bare = fixtureRepo()
  git(bare, ["config", "receive.denyCurrentBranch", "ignore"])
  git(root, ["remote", "add", "origin", bare])
  expect(await pushChangeNotes(root, "origin")).toBe(true)
  expect(git(bare, ["rev-parse", "--verify", "refs/notes/lazers"])).toBe(
    git(root, ["rev-parse", "refs/notes/lazers"]),
  )
  expect(await pushChangeNotes(root, "missing-remote")).toBe(false)
})

test("an unchanged change and target are proven once, and a new target commit is proven again", async () => {
  const { root, evidence } = await workerBranch()
  const before = containmentComputationCount()
  const first = await changeContained(root, evidence, "main")
  const again = await changeContained(root, evidence, "main")
  expect(again).toEqual(first)
  expect(containmentComputationCount() - before).toBe(1)
  commitFile(root, "later.txt", "later\n", "later")
  await changeContained(root, evidence, "main")
  expect(containmentComputationCount() - before).toBe(2)
})

test("a squash split across target commits is found among many unrelated commits", async () => {
  const { root, evidence } = await workerBranch()
  for (let n = 0; n < 60; n++) commitFile(root, `noise-${n}.txt`, `${n}\n`, `noise ${n}`)
  commitFile(root, "feature.txt", "feature\n", "port: feature")
  commitFile(root, "feature2.txt", "feature two\n", "port: more")
  const result = await changeContained(
    root,
    { ...evidence, changeId: undefined, commitPatchIds: undefined, tree: undefined },
    "main",
  )
  expect(result).toMatchObject({ status: "contained", via: "patch-id" })
})
