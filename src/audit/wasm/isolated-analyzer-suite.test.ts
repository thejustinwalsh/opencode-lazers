import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
const suiteFiles = [
  "src/audit/wasm/fallow-analysis.test.ts",
  "src/audit/wasm/fallow-cache.test.ts",
  "src/audit/wasm/fallow-wasm.test.ts",
]

test("shipped-module analysis, cache, and WASM tests run in an isolated process", async () => {
  await Bun.sleep(0)
  Bun.gc(true)

  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--timeout",
      "120000",
      "--path-ignore-patterns=src/audit/wasm/isolated-analyzer-suite.test.ts",
      ...suiteFiles,
    ],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  expect(exitCode).toBe(0)
}, 600_000)
