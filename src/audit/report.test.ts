import { expect, test } from "bun:test"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fallowReport } from "./report.ts"

test("bundled native Fallow saves all static reports and leaves source untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "lz-fallow-"))
  try {
    const source = "export const used = 1; export const unused = 2;\n"
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "fixture", main: "index.ts" }),
    )
    await writeFile(join(root, "index.ts"), "import {used} from './values'; console.log(used);\n")
    await writeFile(join(root, "values.ts"), source)
    const result = await fallowReport(root)
    const report = JSON.parse(await readFile(result.reportPath, "utf8"))
    expect(result.analyses).toHaveLength(5)
    expect(result.analyses.every((a) => a.error === undefined)).toBe(true)
    expect(
      report.reports.deadCode.unused_exports.some(
        (f: { export_name: string }) => f.export_name === "unused",
      ),
    ).toBe(true)
    expect(report.finishedAt).toBeGreaterThanOrEqual(report.startedAt)
    expect(await readFile(join(root, "values.ts"), "utf8")).toBe(source)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
