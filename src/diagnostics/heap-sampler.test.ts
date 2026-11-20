import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { activeHeapSampler, startHeapSampler, type HeapRecord } from "./heap-sampler.ts"

const dirs: string[] = []
const hostKey = Symbol("test.heap-sampler")
afterEach(async () => {
  activeHeapSampler(hostKey)?.stop()
  ;(globalThis as unknown as Record<symbol, unknown>)[hostKey] = undefined
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture(generation = "a") {
  const root = await mkdtemp(join(tmpdir(), "lazers-heap-"))
  dirs.push(root)
  const directory = join(root, "diagnostics")
  await mkdir(directory, { recursive: true })
  const sampler = startHeapSampler({
    directory,
    intervalMs: 3_600_000,
    generation,
    hostKey,
    context: () => ({ locations: 44, cores: 3 }),
  })
  return { directory, sampler }
}

const lines = async (path: string) =>
  (await readFile(path, "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HeapRecord)

test("no flag file, no lines", async () => {
  const { sampler } = await fixture()
  await sampler.sample()
  expect(await lines(sampler.outputPath)).toEqual([])
})

test("flag present writes a full record; removing it stops output", async () => {
  const { directory, sampler } = await fixture()
  await writeFile(join(directory, "heap.on"), "")
  await sampler.sample()
  const [record] = await lines(sampler.outputPath)
  expect(record?.event).toBe("lazers.heap")
  expect(record!.pid).toBe(process.pid)
  expect(Object.keys(record!.memory).sort()).toEqual(
    ["arrayBuffers", "external", "heapTotal", "heapUsed", "rss"].sort(),
  )
  expect(Object.keys(record!.heap).sort()).toEqual(
    [
      "extraMemorySize",
      "globalObjectCount",
      "heapCapacity",
      "heapSize",
      "objectCount",
      "protectedObjectCount",
    ].sort(),
  )
  expect(record!.objectTypeCounts.length).toBeGreaterThan(0)
  expect(record!.objectTypeCounts.length).toBeLessThanOrEqual(25)
  expect(record!.sampleMs).toBeGreaterThanOrEqual(0)
  expect(record!.locations).toBe(44)
  expect(record!.cores).toBe(3)
  await rm(join(directory, "heap.on"))
  await sampler.sample()
  expect(await lines(sampler.outputPath)).toHaveLength(1)
})

test("a new generation replaces the old sampler; the same generation reuses it", async () => {
  const { directory, sampler: first } = await fixture("a")
  expect(startHeapSampler({ directory, generation: "a", hostKey })).toBe(first)
  const second = startHeapSampler({ directory, generation: "b", hostKey })
  expect(second).not.toBe(first)
  expect(first.running).toBe(false)
  expect(second.running).toBe(true)
  expect(activeHeapSampler(hostKey)).toBe(second)
})

test("rotates past the size cap", async () => {
  const { directory, sampler } = await fixture()
  const capped = startHeapSampler({ directory, generation: "c", hostKey, maxBytes: 1 })
  await writeFile(join(directory, "heap.on"), "")
  await capped.sample()
  await capped.sample()
  expect(await lines(`${sampler.outputPath}.1`)).toHaveLength(1)
  expect(await lines(sampler.outputPath)).toHaveLength(1)
})
