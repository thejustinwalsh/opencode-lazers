import {
  runFallowModule,
  ThreadPool,
  isThreadedModule,
  type RunOptions,
  type WasiOutcome,
  type WasiRequest,
} from "../../fallow-wasi.ts"
import { currentDirectAnalysisTestLifetime } from "./direct-analysis-test-context.ts"
import { directAnalysisScopeFor } from "./direct-analysis-scope.ts"

/**
 * Direct test analyses bypass fallow-worker's post-request collection. Collect after each run:
 * whole-repository scans can grow a single-module heap enough to starve the next 4 GiB threaded
 * allocation. Helper workers are always terminated before the operation completes.
 */
export function runDirectFallowModule(
  module: WebAssembly.Module,
  request: WasiRequest,
  options: RunOptions = {},
): Promise<WasiOutcome> {
  const scope = directAnalysisScopeFor(request.root)
  const testLifetime = currentDirectAnalysisTestLifetime()
  let analysisStarted = false
  let collectAfterOperation = false
  const completion = scope.run(
    async () => {
      testLifetime?.assertActive()
      analysisStarted = true
      collectAfterOperation = true
      if (isThreadedModule(module)) {
        // Collect after the previous run's completion has unwound through its caller, not only
        // from its in-scope cleanup while those async frames may still reference the instance.
        await Bun.sleep(0)
        const gcStarted = performance.now()
        try {
          Bun.gc(true)
        } finally {
          scope.metrics.gcMs += performance.now() - gcStarted
        }
        await Bun.sleep(0)
        const settledGcStarted = performance.now()
        try {
          Bun.gc(true)
        } finally {
          scope.metrics.gcMs += performance.now() - settledGcStarted
        }
      }
      const pool = options.threadPool ?? new ThreadPool(undefined, false)
      try {
        const executionStarted = performance.now()
        try {
          return runFallowModule(module, request, { ...options, threadPool: pool })
        } finally {
          scope.metrics.executionMs += performance.now() - executionStarted
          scope.metrics.peakHelpers = Math.max(scope.metrics.peakHelpers, pool.peakLiveCount)
          scope.metrics.pendingHelpers = pool.liveCount
        }
      } finally {
        const terminationStarted = performance.now()
        try {
          await pool.terminateAll()
        } finally {
          scope.metrics.terminationMs += performance.now() - terminationStarted
          scope.metrics.pendingHelpers = pool.liveCount
        }
      }
    },
    async () => {
      if (!analysisStarted || !collectAfterOperation) return

      // Let the operation and its WASM instance frame unwind before collecting its memory.
      await Bun.sleep(0)
      const gcStarted = performance.now()
      try {
        Bun.gc(true)
      } finally {
        scope.metrics.gcMs += performance.now() - gcStarted
      }
    },
  )
  return testLifetime ? testLifetime.track(completion) : completion
}
