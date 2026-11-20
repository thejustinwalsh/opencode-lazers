import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import {
  FAST_SITE,
  drainStorageReport,
  drainStorageTiming,
  setStorageTiming,
} from "./storage-timing.ts"

let directory: string
let repository: TaskRepository
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "lazers-storage-timing-"))
  repository = new TaskRepository(join(directory, "tasks.sqlite"), join(directory, "project"))
  drainStorageTiming(1000)
})
afterEach(() => {
  setStorageTiming(false)
  repository.close()
  rmSync(directory, { recursive: true, force: true })
})

const spin = (ms: number) => {
  const end = performance.now() + ms
  while (performance.now() < end);
}

test("a slow read is reported under this file's site", () => {
  setStorageTiming(true)
  repository.read(() => spin(20))
  const [entry, ...rest] = drainStorageTiming(20)
  expect(rest).toEqual([])
  expect(entry?.kind).toBe("read")
  expect(entry?.count).toBe(1)
  expect(entry!.maxMs).toBeGreaterThanOrEqual(20)
  expect(entry?.site).toMatch(/^.*storage-timing\.test\.ts:\d+\)?$/)
})

test("a fast read adds to totals without resolving a site", () => {
  setStorageTiming(true)
  repository.read((db) => db.query("SELECT 1").get())
  const { storage, syncMs } = drainStorageReport(20)
  expect(storage).toHaveLength(1)
  expect(storage[0]).toMatchObject({ site: FAST_SITE, kind: "read", count: 1 })
  expect(syncMs).toBeGreaterThan(0)
  expect(syncMs).toBeLessThan(2)
})

test("flag absent: nothing is recorded", () => {
  repository.read(() => spin(5))
  repository.atomic(() => spin(5))
  expect(drainStorageTiming(20)).toEqual([])
})

test("nested calls count once, under the outermost kind", () => {
  setStorageTiming(true)
  repository.atomic(() => {
    repository.read(() => spin(10))
    spin(10)
  })
  const rows = drainStorageTiming(20)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ kind: "atomic", count: 1 })
  expect(rows[0]!.totalMs).toBeGreaterThanOrEqual(20)
})

test("retryBusy work is timed as one atomic call", async () => {
  setStorageTiming(true)
  await repository.retryBusy(() => spin(5))
  const rows = drainStorageTiming(20)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ kind: "atomic", count: 1 })
})

test("drain keeps the top sites by total and resets", () => {
  setStorageTiming(true)
  repository.read(() => spin(3))
  repository.atomic(() => spin(6))
  const rows = drainStorageTiming(1)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.kind).toBe("atomic")
  expect(drainStorageTiming(20)).toEqual([])
})

function slowReadCaller(repo: TaskRepository) {
  repo.read(() => spin(5))
  return 1
}

test("the site names the calling function", () => {
  setStorageTiming(true)
  slowReadCaller(repository)
  expect(drainStorageTiming(20)[0]?.site).toMatch(/^slowReadCaller \(.*storage-timing\.test\.ts:\d+\)$/)
})

test("the site names the caller when everything is one bundled file", async () => {
  const out = join(directory, "bundle")
  const entry = join(directory, "entry.ts")
  await Bun.write(
    entry,
    `import { TaskRepository } from ${JSON.stringify(join(import.meta.dir, "../storage.ts"))}
export function bundledCaller(repo: TaskRepository) {
  repo.read(() => { const end = performance.now() + 5; while (performance.now() < end); })
  return 1
}
export function bundledWriter(repo: TaskRepository) {
  repo.atomic(() => { const end = performance.now() + 5; while (performance.now() < end); })
  return 1
}
`,
  )
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: out,
    naming: "bundle.js",
    target: "bun",
    format: "esm",
    packages: "external",
    external: ["bun:sqlite"],
  })
  expect(result.success).toBe(true)
  const built = (await import(join(out, "bundle.js"))) as {
    bundledCaller(repo: TaskRepository): number
    bundledWriter(repo: TaskRepository): number
  }
  setStorageTiming(true)
  built.bundledCaller(repository)
  built.bundledWriter(repository)
  const sites = drainStorageTiming(20).map((row) => row.site)
  console.log("bundled sites:", sites)
  expect(sites.some((site) => /^bundledCaller \(.*bundle\.js:\d+\)$/.test(site))).toBe(true)
  expect(sites.some((site) => /^bundledWriter \(.*bundle\.js:\d+\)$/.test(site))).toBe(true)
})
