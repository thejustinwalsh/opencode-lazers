import { afterEach, expect, test } from "bun:test"
import { cleanupFixtureRepos, commitFile, fixtureRepo } from "../change-identity-fixture.ts"
import { git } from "../artifacts.ts"
import { artifactIdentity } from "../change-identity.ts"
import { changeContained } from "./containment.ts"

afterEach(cleanupFixtureRepos)

test("returns readable absence for an unresolved target or missing change identity", async () => {
  const root = fixtureRepo()
  commitFile(root, "base.txt", "base\n")

  await expect(changeContained(root, {}, "missing")).resolves.toMatchObject({
    status: "absent",
    reason: "Integration target missing does not resolve.",
  })
  await expect(changeContained(root, {}, "main")).resolves.toMatchObject({
    status: "absent",
    reason: "No change identity is recorded for this artifact.",
  })
})

test("tree containment finds a landed artifact beneath later target changes", async () => {
  const root = fixtureRepo()
  commitFile(root, "base.txt", "base\n")
  const base = git(root, ["rev-parse", "HEAD"])
  git(root, ["checkout", "-b", "worker"])
  const artifact = commitFile(root, "feature.txt", "feature\n")
  const identity = await artifactIdentity(root, base, artifact)

  git(root, ["checkout", "main"])
  git(root, ["merge", "--squash", "worker"])
  commitFile(root, "later.txt", "later\n", "land feature with unrelated change")

  const result = await changeContained(
    root,
    { tree: identity.tree, base, commit: artifact },
    "main",
  )

  expect(result).toMatchObject({ status: "contained", via: "tree" })
})
