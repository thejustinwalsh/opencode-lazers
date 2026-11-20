import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

/**
 * One analysis worker runs many analyses; each leaves its WebAssembly memory behind. Without a
 * collection between runs they pile up (measured on this repository, five runs in one process:
 * 627 MB without a collection after each, 466 MB with one). The child process runs five whole-project analyses of this
 * repository and reports its resident memory after each.
 */
test("resident memory does not pile up over successive whole-project analyses", async () => {
  const script = fileURLToPath(new URL("./memory-probe.ts", import.meta.url))
  const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" })
  const lines = (await new Response(child.stdout).text()).trim().split("\n").map(Number)
  expect(await child.exited).toBe(0)
  expect(lines).toHaveLength(5)
  // Growth across the successive analyses, not the absolute size: the footprint of one analysis
  // scales with the tree being analyzed (the child analyzes the checkout it runs from), so an
  // absolute ceiling fails when the gate runs from a larger checkout (it saw 1366 MB against a
  // 700 MB ceiling). Alone on this repository the five readings stayed flat: first to last was
  // -35, +33 and +30 MB over three runs (595-657 MB, first reading about 620-630 MB). A pile-up
  // adds a share of every analysis's footprint per run, so the allowed growth is 25% of the first
  // reading, five times the largest measured drift (33 MB is about 5%).
  const first = lines[0]!
  const last = lines[lines.length - 1]!
  expect(last - first).toBeLessThan(first * 0.25)
}, 180_000)
