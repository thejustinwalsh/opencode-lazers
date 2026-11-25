import { runFallowModule, ThreadPool } from "../../fallow-wasi.ts"
import { repoRoot, threadedWasmModule } from "../test-support.ts"

const RUNS = 5
const THREADS = 2
const pool = new ThreadPool()
const reports: string[] = []
const instanceRefs: WeakRef<WebAssembly.Instance>[] = []
const memoryRefs: WeakRef<WebAssembly.Memory>[] = []
let createdWhileRetained = 0
let reusedWhileRetained = 0
let liveWhileRetained = 0
let idleWhileRetained = 0
let peakLiveCount = 0
let peakRssMb = 0

try {
  for (let run = 0; run < RUNS; run++) {
    const outcome = runFallowModule(
      threadedWasmModule,
      {
        op: "deadCode",
        root: repoRoot,
        options: { threads: THREADS, explain: true, css: true, cache: false },
      },
      {
        maxThreads: THREADS,
        threadPool: pool,
        onInstance: (instance) => {
          const memory = instance.exports.memory
          if (!(memory instanceof WebAssembly.Memory))
            throw new Error("analysis instance did not export its linear memory")
          instanceRefs.push(new WeakRef(instance))
          memoryRefs.push(new WeakRef(memory))
        },
      },
    )
    const parsed = JSON.parse(outcome.stdout) as { report?: unknown; error?: unknown }
    if (parsed.error || parsed.report === undefined)
      throw new Error(`reusable helper run ${run + 1} failed: ${JSON.stringify(parsed.error)}`)
    reports.push(outcome.stdout.replace(/"elapsed_ms":[0-9.]+/g, ""))

    if (run === 0 && pool.created !== THREADS)
      throw new Error(`expected ${THREADS} helper workers, got ${pool.created}`)
    if (pool.reused !== run * THREADS)
      throw new Error(`run ${run + 1} reused ${pool.reused} helpers, expected ${run * THREADS}`)
    if (pool.idleCount !== THREADS || pool.liveCount !== THREADS)
      throw new Error(
        `run ${run + 1} left ${pool.idleCount} idle and ${pool.liveCount} live helpers`,
      )
    createdWhileRetained = pool.created
    reusedWhileRetained = pool.reused
    liveWhileRetained = pool.liveCount
    idleWhileRetained = pool.idleCount
    peakLiveCount = pool.peakLiveCount
    await Bun.sleep(0)
    Bun.gc(true)
    peakRssMb = Math.max(peakRssMb, Math.round(process.memoryUsage().rss / 1048576))
  }

  if (new Set(reports).size !== 1) throw new Error("reused helper runs produced different reports")

  await Bun.sleep(0)
  Bun.gc(true)
  const retainedInstances = instanceRefs.filter((ref) => ref.deref() !== undefined).length
  const retainedMemories = memoryRefs.filter((ref) => ref.deref() !== undefined).length
  console.log(
    JSON.stringify({
      runs: RUNS,
      createdWhileRetained,
      reusedWhileRetained,
      liveWhileRetained,
      idleWhileRetained,
      peakLiveCount,
      peakRssMb,
      retainedInstances,
      retainedMemories,
      distinctReports: new Set(reports).size,
    }),
  )
} finally {
  await pool.terminateAll()
}
