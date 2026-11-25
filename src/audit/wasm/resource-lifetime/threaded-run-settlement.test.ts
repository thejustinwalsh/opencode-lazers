import { expect, test } from "bun:test"
import { disposeFixture, makeFixture, threadedWasmModule } from "../test-support.ts"
import { runFallowModule, ThreadPool, WasiTrap } from "../../fallow-wasi.ts"
import { createSharedMemoryTracker } from "./shared-memory-tracker.ts"

test("success and helper-start failure settle memory and workers before the next run", async () => {
  const root = makeFixture()
  const pool = new ThreadPool()
  const trackMemory = createSharedMemoryTracker()
  const aliveAfterRun: number[] = []
  const snapshots: ReturnType<typeof trackMemory.snapshot>[] = []

  try {
    for (const failAfterSpawn of [false, true, false, true]) {
      const run = () =>
        runFallowModule(
          threadedWasmModule,
          { op: "health", root, options: { threads: 2 } },
          {
            maxThreads: 2,
            threadPool: pool,
            onMemory: (memory) => trackMemory.track(memory),
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
      // Let weak-reachability and any delayed finalizer callbacks settle after the run returns.
      await new Promise<void>((resolve) => setImmediate(resolve))
      const snapshot = trackMemory.snapshot()
      aliveAfterRun.push(snapshot.live)
      snapshots.push(snapshot)
      expect(pool.liveCount).toBeLessThanOrEqual(2)
      // End WeakRef.deref's temporary keep-alive window before starting another run.
      await new Promise<void>((resolve) => setImmediate(resolve))
    }

    expect(Math.max(...aliveAfterRun), JSON.stringify(snapshots)).toBeLessThanOrEqual(1)
    expect(pool.reused).toBeGreaterThan(0)
  } finally {
    await pool.terminateAll()
    await disposeFixture(root)
  }

  expect(pool.liveCount).toBe(0)
}, 120_000)
