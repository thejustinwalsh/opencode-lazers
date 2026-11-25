import { afterEach, expect, test as bunTest } from "bun:test"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createSnapshotFixture, withRepositorySnapshot } from "./repository-snapshot.ts"
import {
  closeOutstandingDirectAnalysisTestLifetimes,
  createDirectAnalysisTestRegistrar,
} from "./resource-lifetime/direct-analysis-test-lifetime.ts"
import { runOp } from "./test-support.ts"

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

      const report = (await runOp("deadCode", snapshot)).report
      const unusedFiles = report.unused_files.map((file: { path: string }) => file.path)
      expect(unusedFiles).toContain("src/unused.ts")
      expect(unusedFiles).not.toContain("src/added.ts")
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
})
