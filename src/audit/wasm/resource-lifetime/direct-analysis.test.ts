import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

test("repeated direct analyses reclaim memory and bound helper lifetimes", async () => {
  const script = fileURLToPath(new URL("./direct-analysis-probe.ts", import.meta.url))
  const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  expect(code, stderr).toBe(0)
  const result = JSON.parse(stdout.trim()) as {
    completed: number
    expectedFailures: number
    retainedInstances: number
    retainedMemories: number
    peakRssMb: number
    helperTerminations: { pending: number; peakPending: number }
  }
  expect(result.completed).toBe(12)
  expect(result.expectedFailures).toBe(8)
  expect(result.retainedInstances).toBe(0)
  expect(result.retainedMemories).toBe(0)
  expect(result.peakRssMb).toBeLessThan(700)
  expect(result.helperTerminations.pending).toBe(0)
  expect(result.helperTerminations.peakPending).toBeGreaterThan(0)
  expect(result.helperTerminations.peakPending).toBeLessThanOrEqual(2)
}, 180_000)
