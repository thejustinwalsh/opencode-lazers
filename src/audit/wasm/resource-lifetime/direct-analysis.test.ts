import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { runOwnedTestProcess } from "../owned-test-process.ts"

test("repeated direct analyses reclaim memory and bound helper lifetimes", async () => {
  const script = fileURLToPath(new URL("./direct-analysis-probe.ts", import.meta.url))
  const { stdout, stderr, exitCode } = await runOwnedTestProcess([process.execPath, script], {
    timeoutMs: 240_000,
    forwardOutput: false,
  })

  expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
  const result = JSON.parse(stdout.trim()) as {
    completed: number
    expectedFailures: number
    instancesByKind: { single: number; threads: number }
    observedInstances: number
    scheduledCollectionRuns: number
    scheduledCollectionGcMs: number
    distinctMemorySizes: number[]
    retainedInstances: number
    retainedMemories: number
    peakRssMb: number
    helperTerminations: { pending: number; peakPending: number }
  }
  expect(result.completed).toBe(12)
  expect(result.expectedFailures).toBe(8)
  expect(result.instancesByKind).toEqual({ single: 8, threads: 12 })
  expect(result.observedInstances).toBe(20)
  expect(result.scheduledCollectionRuns).toBe(8)
  expect(result.scheduledCollectionGcMs).toBeGreaterThan(0)
  expect(result.distinctMemorySizes).toHaveLength(2)
  expect(result.retainedInstances).toBe(0)
  expect(result.retainedMemories).toBe(0)
  expect(result.peakRssMb).toBeLessThan(700)
  expect(result.helperTerminations.pending).toBe(0)
  expect(result.helperTerminations.peakPending).toBeGreaterThan(0)
  expect(result.helperTerminations.peakPending).toBeLessThanOrEqual(2)
}, 180_000)
