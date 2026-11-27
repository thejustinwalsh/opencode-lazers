import { afterEach, expect, test as bunTest } from "bun:test"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createSnapshotFixture, withRepositorySnapshot } from "./repository-snapshot.ts"
import { directAnalysisScopeFor } from "./resource-lifetime/direct-analysis-scope.ts"
import {
  closeOutstandingDirectAnalysisTestLifetimes,
  createDirectAnalysisTestRegistrar,
} from "./resource-lifetime/direct-analysis-test-lifetime.ts"
import {
  createDirectAnalysisTestLifetime,
  runWithDirectAnalysisTestLifetime,
} from "./resource-lifetime/direct-analysis-test-context.ts"
import { moduleKinds, runOp } from "./test-support.ts"

afterEach(closeOutstandingDirectAnalysisTestLifetimes)
const test = createDirectAnalysisTestRegistrar(bunTest)

test("repository analysis keeps snapshot contents after the live checkout changes", async () => {
  const live = createSnapshotFixture({
    "package.json": JSON.stringify({ name: "snapshot-fixture", type: "module" }),
    ".fallowrc.json": JSON.stringify({ entry: ["src/index.ts"] }),
    "src/index.ts": `import "./used.ts"\n`,
    "src/used.ts": `export const used = 1\n`,
    "src/unused.ts": `export const original = 1\n`,
  })
  let snapshotRoot = ""

  try {
    await withRepositorySnapshot(live, async (snapshot) => {
      snapshotRoot = snapshot
      writeFileSync(join(live, "src/unused.ts"), `export const edited = 2\n`)
      writeFileSync(join(live, "src/added.ts"), `export const added = 3\n`)

      const reports: string[][] = []
      for (const kind of moduleKinds) {
        const report = (await runOp("deadCode", snapshot, {}, {}, kind)).report
        const repeated = (await runOp("deadCode", snapshot, {}, {}, kind)).report
        const unusedFiles = report.unused_files.map((file: { path: string }) => file.path)
        expect(unusedFiles).toContain("src/unused.ts")
        expect(unusedFiles).not.toContain("src/added.ts")
        expect(repeated.unused_files).toEqual(report.unused_files)
        reports.push(unusedFiles)
      }
      expect(reports[1]).toEqual(reports[0])
      expect(readFileSync(join(snapshot, "src/unused.ts"), "utf8")).toBe(
        `export const original = 1\n`,
      )
      expect(existsSync(join(snapshot, "src/added.ts"))).toBe(false)
    })

    expect(snapshotRoot).not.toBe("")
    expect(existsSync(snapshotRoot)).toBe(false)
  } finally {
    rmSync(live, { recursive: true, force: true })
  }
}, 30_000)

test("repository snapshot cleanup completes after its callback fails", async () => {
  const live = createSnapshotFixture({
    "package.json": JSON.stringify({ name: "snapshot-failure", type: "module" }),
    "src/index.ts": `export const source = 1\n`,
  })
  let snapshotRoot = ""

  try {
    await expect(
      withRepositorySnapshot(live, async (snapshot) => {
        snapshotRoot = snapshot
        await directAnalysisScopeFor(snapshot).run(() => {})
        throw new Error("intentional snapshot callback failure")
      }),
    ).rejects.toThrow("intentional snapshot callback failure")

    expect(snapshotRoot).not.toBe("")
    expect(existsSync(snapshotRoot)).toBe(false)
  } finally {
    rmSync(live, { recursive: true, force: true })
  }
}, 30_000)

test("repository snapshot cleanup drains analysis after test-lifetime expiry", async () => {
  const live = createSnapshotFixture({
    "package.json": JSON.stringify({ name: "snapshot-timeout", type: "module" }),
    "src/index.ts": `export const source = 1\n`,
  })
  let snapshotRoot = ""
  let releaseAnalysis!: () => void
  let markStarted!: () => void
  let markExpired!: () => void
  let analysisFinished = false
  const analysisGate = new Promise<void>((resolve) => {
    releaseAnalysis = resolve
  })
  const analysisStarted = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const lifetimeExpired = new Promise<void>((resolve) => {
    markExpired = resolve
  })
  const simulatedLifetime = createDirectAnalysisTestLifetime()
  let snapshotRun: Promise<void> | undefined

  try {
    snapshotRun = runWithDirectAnalysisTestLifetime(simulatedLifetime, () =>
      withRepositorySnapshot(live, async (snapshot) => {
        snapshotRoot = snapshot
        const analysis = directAnalysisScopeFor(snapshot).run(async () => {
          markStarted()
          await analysisGate
          analysisFinished = true
        })
        try {
          await simulatedLifetime.waitFor(analysis)
        } catch (error) {
          expect(error).toBeInstanceOf(Error)
          markExpired()
        }
      }),
    )
    await analysisStarted
    simulatedLifetime.close()
    await lifetimeExpired

    expect(existsSync(snapshotRoot)).toBe(true)
    expect(analysisFinished).toBe(false)

    releaseAnalysis()
    await snapshotRun
    expect(analysisFinished).toBe(true)
    expect(existsSync(snapshotRoot)).toBe(false)
  } finally {
    simulatedLifetime.close()
    releaseAnalysis()
    await snapshotRun?.catch(() => {})
    rmSync(live, { recursive: true, force: true })
  }
}, 30_000)
