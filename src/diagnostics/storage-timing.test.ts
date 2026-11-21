import { afterEach, beforeEach, expect, onTestFinished, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import {
  FAST_SITE,
  SAMPLE_RATE,
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
  expect(drainStorageTiming(20)[0]?.site).toMatch(
    /^slowReadCaller \(.*storage-timing\.test\.ts:\d+\)$/,
  )
})

test("the site names the caller when everything is one bundled file", async () => {
  // Inside the repository so the bundle resolves its external packages from node_modules.
  const out = join(import.meta.dir, "../../dist", `storage-timing-${process.pid}`)
  const entry = join(directory, "entry.ts")
  onTestFinished(() => rmSync(out, { recursive: true, force: true }))
  await Bun.write(
    entry,
    `import { TaskRepository } from ${JSON.stringify(join(import.meta.dir, "../storage.ts"))}
export function openRepository(path: string, project: string) {
  return new TaskRepository(path, project)
}
export function bundledCaller(repo: TaskRepository) {
  repo.read(() => { const end = performance.now() + 5; while (performance.now() < end); })
  return 1
}
function sample() {
  return performance.now()
}
export function bundledSample() {
  return sample()
}
export function bundledFast(repo: TaskRepository) {
  for (let i = 0; i < 3200; i++) repo.read((db) => db.query("SELECT 1").get())
  return 1
}
function section(name: string, run: () => unknown) {
  // Not a tail call, like the stall probe's own wrapper, so its frame stays on the stack.
  const result = run()
  return name ? result : undefined
}
export function bundledSection(repo: TaskRepository) {
  section("tick:x", repo.atomic.bind(repo, () => { const end = performance.now() + 5; while (performance.now() < end); }))
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
    openRepository(path: string, project: string): TaskRepository
    bundledCaller(repo: TaskRepository): number
    bundledWriter(repo: TaskRepository): number
    bundledSection(repo: TaskRepository): number
    bundledFast(repo: TaskRepository): number
    bundledSample(): number
  }
  built.bundledSample()
  const bundled = built.openRepository(
    join(directory, "bundled.sqlite"),
    join(directory, "project"),
  )
  try {
    setStorageTiming(true)
    built.bundledCaller(bundled)
    built.bundledWriter(bundled)
    built.bundledSection(bundled)
    built.bundledFast(bundled)
  } finally {
    bundled.close()
  }
  const report = drainStorageReport(20)
  const sites = report.storage.map((row) => row.site)
  const sampledSites = report.sampled.map((row) => row.site)
  expect(sampledSites.some((site) => /^bundledFast \(.*bundle\.js:\d+\)$/.test(site))).toBe(true)
  const text = await Bun.file(join(out, "bundle.js")).text()
  // The bundle really contains the storage layer, and its `sample` collided and was renamed.
  expect(text).toMatch(/function timeStorage\w*\(/)
  expect(text).toMatch(/function sample\d+\(/)
  for (const site of [...sites, ...sampledSites])
    expect(site).not.toMatch(/^(callSite|sample|timeStorage|record)\d* /)
  expect(sites.some((site) => /^bundledCaller \(.*bundle\.js:\d+\)$/.test(site))).toBe(true)
  expect(sites.some((site) => /^bundledWriter \(.*bundle\.js:\d+\)$/.test(site))).toBe(true)
  // A stall-probe section wrapper is not a call site: the caller one frame up is.
  expect(sites.some((site) => /^bundledSection \(.*bundle\.js:\d+\)$/.test(site))).toBe(true)
  for (const site of sites)
    expect(site).not.toMatch(/^(section|sectionAsync|sectionEffect|timed)\d* /)
})

function fastCaller(repo: TaskRepository, n: number) {
  for (let i = 0; i < n; i++) repo.read((db) => db.query("SELECT 1").get())
  return 1
}

test("fast calls are sampled by caller, one in SAMPLE_RATE, and totals stay exact", () => {
  setStorageTiming(true)
  fastCaller(repository, 3200)
  const report = drainStorageReport(20)
  expect(report.sampleRate).toBe(SAMPLE_RATE)
  const mine = report.sampled.find((row) => row.site.startsWith("fastCaller ("))
  expect(mine?.kind).toBe("read")
  expect(mine!.samples).toBeGreaterThanOrEqual(80)
  expect(mine!.samples).toBeLessThanOrEqual(120)
  expect(mine!.sampledMs).toBeGreaterThan(0)
  const fast = report.storage.find((row) => row.site === FAST_SITE)
  expect(fast?.count).toBeGreaterThanOrEqual(3200 - 5)
})

test("slow calls are not sampled", () => {
  setStorageTiming(true)
  repository.read(() => spin(3))
  const report = drainStorageReport(20)
  expect(report.sampled).toEqual([])
  expect(report.storage[0]?.site).toMatch(/\.test\.ts:\d+/)
})
