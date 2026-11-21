import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { dryRunFallowConfig } from "./fallow-config-tools.ts"
import { wasmFallowAnalyzer } from "./wasm-analyzer.ts"

const root = fileURLToPath(new URL("../..", import.meta.url))

test("the dry run is one engine call and reports what the three separate analyses reported", async () => {
  const candidate = Bun.JSONC.parse(readFileSync(join(root, ".fallowrc.json"), "utf8")) as object
  let combinedCalls = 0
  const one = {
    ...wasmFallowAnalyzer,
    combined: (scope: Parameters<NonNullable<typeof wasmFallowAnalyzer.combined>>[0]) => (
      combinedCalls++,
      wasmFallowAnalyzer.combined!(scope)
    ),
  }
  const separate = { ...wasmFallowAnalyzer, combined: undefined }
  const combined = await dryRunFallowConfig(root, "project", candidate, one)
  expect(combinedCalls).toBe(1)
  expect(await dryRunFallowConfig(root, "project", candidate, separate)).toEqual(combined)
  expect(combined.classes.length).toBeGreaterThan(0)
}, 120_000)
