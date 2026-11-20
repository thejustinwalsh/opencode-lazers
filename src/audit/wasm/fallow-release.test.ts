import { afterAll, beforeAll, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { ThreadPool } from "../fallow-wasi.ts"
import { makeFixture, runOp } from "./test-support.ts"

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
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test("repeated threaded runs in one process do not accumulate shared memories", async () => {
  const pool = new ThreadPool()
  const memories: WeakRef<WebAssembly.Memory>[] = []
  const aliveAtCreation: number[] = []
  const runs = 8
  try {
    for (let i = 0; i < runs; i++) {
      runOp(
        "health",
        dir,
        {},
        {
          threadPool: pool,
          onMemory: (memory) => {
            aliveAtCreation.push(memories.filter((ref) => ref.deref() !== undefined).length)
            memories.push(new WeakRef(memory))
          },
        },
        "threads",
      )
      // Let the engine drop objects kept alive for the current turn.
      await Bun.sleep(0)
    }
    expect(aliveAtCreation).toHaveLength(runs)
    // At most the previous run's memory may linger; without release this grows by one per run.
    expect(Math.max(...aliveAtCreation)).toBeLessThanOrEqual(1)
  } finally {
    pool.terminateAll()
  }
}, 120_000)
