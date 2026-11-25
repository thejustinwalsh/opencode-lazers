import { expect, test } from "bun:test"
import { disposeFixture, makeFixture, threadedWasmModule } from "../test-support.ts"
import { runFallowModule, ThreadPool, WasiTrap } from "../../fallow-wasi.ts"

test("success and helper-start failure settle memory and workers before the next run", async () => {
  const root = makeFixture()
  const pool = new ThreadPool()
  const memories: WeakRef<WebAssembly.Memory>[] = []
  const aliveAtCreation: number[] = []

  try {
    for (const failAfterSpawn of [false, true, false, true]) {
      const aliveBeforeAllocation = memories.filter((ref) => ref.deref() !== undefined).length
      await Bun.sleep(0)

      const run = () =>
        runFallowModule(
          threadedWasmModule,
          { op: "health", root, options: { threads: 2 } },
          {
            maxThreads: 2,
            threadPool: pool,
            onMemory: (memory) => {
              aliveAtCreation.push(aliveBeforeAllocation)
              memories.push(new WeakRef(memory))
            },
            onSpawn: (granted) => {
              if (failAfterSpawn && granted) throw new Error("injected helper-start failure")
            },
          },
        )

      if (failAfterSpawn) expect(run).toThrow(WasiTrap)
      else {
        const result = JSON.parse(run().stdout) as { report?: unknown }
        expect(result.report).toBeDefined()
      }

      await pool.settled()
      await Bun.sleep(0)
      expect(pool.liveCount).toBeLessThanOrEqual(2)
    }

    expect(Math.max(...aliveAtCreation)).toBeLessThanOrEqual(1)
    expect(pool.reused).toBeGreaterThan(0)
  } finally {
    await pool.terminateAll()
    await disposeFixture(root)
  }

  expect(pool.liveCount).toBe(0)
}, 120_000)
