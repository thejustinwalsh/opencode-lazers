import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validProposal } from "../../test/proposal.ts"
import { TaskRepository } from "../storage.ts"
import { git } from "../runner/artifacts.ts"
import { ProjectIndex } from "./index.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lazers-index-"))
  git(root, ["init", "--initial-branch=main"])
  mkdirSync(join(root, "src"))
  writeFileSync(
    join(root, "src", "feature.ts"),
    "/** Current policy. */\nexport function feature(input: string): string {\n const value = input.trim();\n return value.toUpperCase();\n}\n",
  )
  writeFileSync(join(root, ".gitignore"), "ignored/\ncache/\ndata/\n")
  mkdirSync(join(root, "ignored"))
  writeFileSync(join(root, "ignored", "never.txt"), "never collect")
  writeFileSync(join(root, ".repomixignore"), "custom.txt\n")
  writeFileSync(join(root, "custom.txt"), "custom ignored")
  writeFileSync(join(root, ".env"), "SECRET=never")
  writeFileSync(join(root, "denied.txt"), "private")
  writeFileSync(join(root, "untracked.txt"), "dirty source")
  symlinkSync("/etc/passwd", join(root, "escape.txt"))
  const repository = new TaskRepository(join(root, "data", "tasks.sqlite"), root)
  const denied = new Set(["denied.txt"]),
    reads: string[] = []
  const index = new ProjectIndex(root, join(root, "cache"), repository, async (path) => {
    reads.push(path)
    return !denied.has(path)
  })
  cleanups.push(() => {
    index.close()
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, repository, index, denied, reads }
}
const principal = { sessionID: "architect", agent: "architect" }

test("real pinned Repomix indexing compresses source and filters ignores, secrets, denied and symlink paths", async () => {
  const f = fixture()
  const manifest = await f.index.manifest(principal)
  const paths = manifest.files.map((file) => file.path)
  expect(paths).toContain("src/feature.ts")
  expect(paths).toContain("untracked.txt")
  for (const name of ["ignored/never.txt", ".env", "custom.txt", "denied.txt", "escape.txt"])
    expect(paths).not.toContain(name)
  expect(f.reads).not.toContain(".env")
  expect(manifest.repomix).toBe("1.18.1")
  const full = await f.index.evidence(principal, {
    paths: ["src/feature.ts"],
    level: "full",
    startLine: 2,
    endLine: 5,
  })
  const outline = await f.index.evidence(principal, { paths: ["src/feature.ts"], level: "outline" })
  expect(full.sources[0]!.text).toContain("toUpperCase")
  expect(outline.sources[0]!.text).toContain("feature")
  expect(outline.sources[0]!.text).not.toContain("toUpperCase")
  const proposal = validProposal()
  proposal.context = [{ reference: full.receipt!, revision: full.snapshotID }]
  await f.index.validateReceipt(principal, proposal)
  await expect(
    f.index.validateReceipt({ ...principal, sessionID: "other" }, proposal),
  ).rejects.toThrow("foreign")
  const cached = await f.index.manifest(principal)
  expect(cached.snapshotID).toBe(manifest.snapshotID)
  writeFileSync(join(f.root, "src", "feature.ts"), "export const changed = true\n")
  await expect(f.index.validateReceipt(principal, proposal)).rejects.toThrow("stale")
  expect((await f.index.manifest(principal)).snapshotID).not.toBe(manifest.snapshotID)
})

test("cached content is reauthorized; manifest and empty results cannot authorize task submission", async () => {
  const f = fixture()
  const evidence = await f.index.evidence(principal, { paths: ["src/feature.ts"] })
  f.denied.add("src/feature.ts")
  expect((await f.index.manifest(principal)).files.map((file) => file.path)).not.toContain(
    "src/feature.ts",
  )
  const proposal = validProposal()
  proposal.context = [{ reference: evidence.receipt!, revision: evidence.snapshotID }]
  await expect(f.index.validateReceipt(principal, proposal)).rejects.toThrow("stale")
  expect((await f.index.evidence(principal, { search: "no-such-content" })).receipt).toBeNull()
  proposal.context = []
  await expect(f.index.validateReceipt(principal, proposal)).rejects.toThrow("focused")
})

test("response bounds count the complete wrapper and require narrower evidence", async () => {
  const f = fixture()
  writeFileSync(join(f.root, "large.txt"), "word ".repeat(5000))
  await expect(f.index.evidence(principal, { paths: ["large.txt"] })).rejects.toThrow(
    "Response exceeds",
  )
})
