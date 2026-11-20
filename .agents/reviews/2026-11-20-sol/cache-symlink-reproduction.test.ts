import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { publishCache } from "../../../src/audit/fallow-cache.ts"

test("reproduces 3bb090ac-1: publication overwrites a symlink target outside .fallow", async () => {
  // All artifacts, including the symlink target, stay inside the authorized review directory.
  const root = await mkdtemp(join(import.meta.dir, "cache-reproduction-"))
  const from = join(root, "source")
  const to = join(root, "destination")
  await mkdir(join(from, ".fallow"), { recursive: true })
  await mkdir(join(to, ".fallow"), { recursive: true })
  const sentinel = join(root, "owner-config.txt")
  await writeFile(sentinel, "owner configuration must survive\n")
  await writeFile(join(from, ".fallow", "cache.bin"), "fixture")
  await symlink(sentinel, join(to, ".fallow", ".gitignore"))
  expect(await readFile(sentinel, "utf8")).toBe("owner configuration must survive\n")
  expect(await publishCache(from, to)).toBe(1)
  // This asserts the observed defect, not the desired production contract.
  expect(await readFile(sentinel, "utf8")).toBe("*\n")
  console.log(`3bb090ac-1 reproduced; artifacts: ${root}`)
})
