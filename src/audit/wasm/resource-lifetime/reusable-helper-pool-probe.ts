import { runFallowModule, ThreadPool } from "../../fallow-wasi.ts"
import { disposeFixture, makeFixture, threadedWasmModule } from "../test-support.ts"

const RUNS = 8
const THREADS = 2
const fixture = makeFixture()
const pool = new ThreadPool()
const reports: string[] = []
let createdWhileRetained = 0
let reusedWhileRetained = 0
let liveWhileRetained = 0
let idleWhileRetained = 0
let peakLiveCount = 0

try {
  for (let run = 0; run < RUNS; run++) {
    const outcome = runFallowModule(
      threadedWasmModule,
      {
        op: "health",
        root: fixture,
        options: { threads: THREADS, explain: true, css: true },
      },
      { maxThreads: THREADS, threadPool: pool },
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
  }

  if (new Set(reports).size !== 1) throw new Error("reused helper runs produced different reports")

  console.log(
    JSON.stringify({
      runs: RUNS,
      createdWhileRetained,
      reusedWhileRetained,
      liveWhileRetained,
      idleWhileRetained,
      peakLiveCount,
      distinctReports: new Set(reports).size,
    }),
  )
} finally {
  await pool.terminateAll()
  await disposeFixture(fixture)
}
