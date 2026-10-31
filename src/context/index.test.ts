import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { git } from "../runner/artifacts.ts"
import { ProjectIndex } from "./index.ts"
import { validProposal } from "../../test/proposal.ts"

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
  expect(full).not.toHaveProperty("receipt")
  expect(full.sources[0]!.revision).toBeNull()
  writeFileSync(join(f.root, "unrelated.txt"), "Other work proceeds")
  expect(
    (await f.index.evidence(principal, { paths: ["src/feature.ts"] })).sources[0]!.text,
  ).toContain("toUpperCase")
  writeFileSync(join(f.root, "src", "feature.ts"), "export const changed = true\n")
  expect(
    (await f.index.evidence(principal, { paths: ["src/feature.ts"] })).sources[0]!.text,
  ).toContain("changed")
})

test("cached reads respect current permissions without submission receipts", async () => {
  const f = fixture()
  await f.index.evidence(principal, { paths: ["src/feature.ts"] })
  f.denied.add("src/feature.ts")
  expect((await f.index.evidence(principal, { paths: ["src/feature.ts"] })).sources).toEqual([])
  expect((await f.index.evidence(principal, { search: "no-such-content" })).sources).toEqual([])
})

test("focused multi-file reads return complete source beyond the former response cap", async () => {
  const f = fixture()
  const first = `${"first ".repeat(5000)}\nFIRST_FILE_END`,
    second = `${"second ".repeat(5000)}\nSECOND_FILE_END`
  writeFileSync(join(f.root, "first.txt"), first)
  writeFileSync(join(f.root, "second.txt"), second)
  const result = await f.index.evidence(principal, { paths: ["first.txt", "second.txt"] })
  expect(result.sources.map((source) => [source.path, source.text])).toEqual([
    ["first.txt", first],
    ["second.txt", second],
  ])
  expect(result.sources.map((source) => [source.startLine, source.endLine])).toEqual([
    [1, 2],
    [1, 2],
  ])
  expect(result.truncated).toBe(false)
})

test("worker packets honor cited line ranges and defer large source without blocking dispatch", async () => {
  const f = fixture()
  writeFileSync(join(f.root, "AGENTS.md"), "Use strict TypeScript. No worker delegation.")
  writeFileSync(join(f.root, "README.md"), "Implement the scoped feature and run its tests.")
  writeFileSync(
    join(f.root, "guide.md"),
    "outside-range\nRelevant contract.\nRelevant procedure.\n" +
      "unrelated guide prose ".repeat(5000),
  )
  writeFileSync(join(f.root, "oversized.md"), "large context source ".repeat(20000))
  const proposal = validProposal()
  proposal.context = [
    { reference: "guide.md:2-3: relevant integration", revision: null },
    { reference: "oversized.md", revision: null },
  ]
  proposal.limits.maxTokens = 4000
  const packet = await f.index.packet(principal, proposal, [], "fixture-base")
  const delivered = JSON.parse(packet.text)
  expect(delivered.entries.find((entry: { path: string }) => entry.path === "guide.md").text).toBe(
    "[Lines 2-3]\nRelevant contract.\nRelevant procedure.",
  )
  expect(packet.text).not.toContain("outside-range")
  expect(packet.text).not.toContain("unrelated guide prose")
  expect(delivered.deferred).toContain("oversized.md")
  expect(packet.metadata.tokens).toBeLessThanOrEqual(24000)
  expect(delivered.entries.some((entry: { path: string }) => entry.path === "AGENTS.md")).toBe(true)
})
