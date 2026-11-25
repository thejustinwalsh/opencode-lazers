import { afterAll, beforeAll, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { makeFixture, threadedWasmModule } from "./test-support.ts"
import { runFallowModule, ThreadPool } from "../fallow-wasi.ts"
import { createSharedMemoryTracker } from "./resource-lifetime/shared-memory-tracker.ts"
const testThreadPool = new ThreadPool()

/**
 * Each threaded run declares a 4 GiB shared WebAssembly.Memory. Nothing frees it but the
 * collector, so runs that only drop their reference pile up reservations until the process
 * fails with "RangeError: Out of memory" (the whole-suite `bun test` did). A run now releases
 * its memory before it returns, helper threads included. This counts, as each run creates its
 * memory, how many earlier ones are still alive, with no collection from the test.
 */
let dir: string
beforeAll(() => {
  dir = makeFixture()
})
afterAll(async () => {
  await testThreadPool.terminateAll()
  rmSync(dir, { recursive: true, force: true })
})

test("repeated threaded runs in one process do not accumulate shared memories", async () => {
  const reusedBefore = testThreadPool.reused
  const trackMemory = createSharedMemoryTracker()
  const aliveAtCreation: number[] = []
  const runs = 8
  {
    for (let i = 0; i < runs; i++) {
      runFallowModule(
        threadedWasmModule,
        { op: "health", root: dir, options: { threads: 2 } },
        {
          maxThreads: 2,
          threadPool: testThreadPool,
          onMemory: (memory) => {
            aliveAtCreation.push(trackMemory(memory))
          },
        },
      )
      // Let the engine drop objects kept alive for the current turn, and the helpers rejoin.
      await testThreadPool.settled()
      await Bun.sleep(0)
    }
    expect(aliveAtCreation).toHaveLength(runs)
    // At most the previous run's memory may linger; without release this grows by one per run.
    expect(Math.max(...aliveAtCreation)).toBeLessThanOrEqual(1)
    // The suite's one shared pool serves the helpers: later runs take idle helpers, not new workers.
    expect(testThreadPool.reused).toBeGreaterThan(reusedBefore)
  }
}, 120_000)
