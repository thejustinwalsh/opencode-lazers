import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { runOwnedTestProcess } from "./owned-test-process.ts"

/**
 * One analysis worker runs many analyses; each leaves its WebAssembly memory behind. Without a
 * collection between runs they pile up (measured on this repository, five runs in one process:
 * 627 MB without a collection after each, 466 MB with one). The child process runs five whole-project analyses of this
 * repository and reports its resident memory after each.
 */
test("resident memory does not pile up over successive whole-project analyses", async () => {
  const script = fileURLToPath(new URL("./memory-probe.ts", import.meta.url))
  const { stdout, stderr, exitCode } = await runOwnedTestProcess([process.execPath, script], {
    timeoutMs: 150_000,
    forwardOutput: false,
  })
  const lines = stdout.trim().split("\n").map(Number)
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
  expect(lines).toHaveLength(5)
  // A loose ceiling, because the collector's timing varies: the same five runs peaked at 520 MB
  // without the collection and at 450 MB with it (single-threaded module, this repository). The
  // test catches a regression of the memory footprint; the plan records the measured saving.
  expect(Math.max(...lines)).toBeLessThan(700)
}, 180_000)
