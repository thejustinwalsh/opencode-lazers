import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { runOwnedTestProcess } from "./owned-test-process.ts"

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
const suiteFiles = [
  "src/audit/wasm/fallow-analysis.test.ts",
  "src/audit/wasm/fallow-cache.test.ts",
  "src/audit/wasm/fallow-wasm.test.ts",
]

test("shipped-module analysis, cache, and WASM tests run in an isolated process", async () => {
  await Bun.sleep(0)
  Bun.gc(true)

  const result = await runOwnedTestProcess(
    [
      process.execPath,
      "test",
      "--timeout",
      "120000",
      "--path-ignore-patterns=src/audit/wasm/isolated-analyzer-suite.test.ts",
      ...suiteFiles,
    ],
    { cwd: repoRoot, timeoutMs: 540_000 },
  )
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0)
}, 600_000)
