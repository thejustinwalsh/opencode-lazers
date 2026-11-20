import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { publishCache, seedCache } from "./fallow-cache.ts"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fallow-cache-"))
  roots.push(root)
  const from = join(root, "source")
  const to = join(root, "destination")
  await mkdir(join(from, ".fallow"), { recursive: true })
  await mkdir(join(to, ".fallow"), { recursive: true })
  await writeFile(join(from, ".fallow", "cache.bin"), "fixture")
  const sentinel = join(root, "owner-config.txt")
  await writeFile(sentinel, "owner configuration must survive\n")
  await symlink(sentinel, join(to, ".fallow", ".gitignore"))
  return { from, to, sentinel }
}

test("3bb090ac-1: publishing never writes through a symlinked .gitignore", async () => {
  const { from, to, sentinel } = await fixture()
  expect(await publishCache(from, to)).toBe(1)
  expect(await readFile(sentinel, "utf8")).toBe("owner configuration must survive\n")
})

test("3bb090ac-1: seeding never writes through a symlinked .gitignore", async () => {
  const { from, to, sentinel } = await fixture()
  expect(await seedCache(to, from)).toBe(1)
  expect(await readFile(sentinel, "utf8")).toBe("owner configuration must survive\n")
})

test("a fresh cache directory still gets its ignore-everything file", async () => {
  const { from, to } = await fixture()
  await rm(join(to, ".fallow"), { recursive: true })
  expect(await publishCache(from, to)).toBe(1)
  expect(await readFile(join(to, ".fallow", ".gitignore"), "utf8")).toBe("*\n")
})
