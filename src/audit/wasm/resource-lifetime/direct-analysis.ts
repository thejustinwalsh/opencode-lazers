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

// The single module starts at 18 MiB; batch a small bounded number of runs between full GCs.
const SINGLE_MODULE_GC_INTERVAL = 8
let singleModuleRunsSinceGc = 0

/**
 * Direct test analyses bypass fallow-worker's post-request collection. Bound retained instances
 * with periodic collection for single-thread modules and per-run collection for 4 GiB threaded
 * memories; helper workers are always terminated before the operation completes.
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
      if (isThreadedModule(module)) {
        singleModuleRunsSinceGc = 0
        collectAfterOperation = true
      } else {
        singleModuleRunsSinceGc++
        collectAfterOperation = singleModuleRunsSinceGc >= SINGLE_MODULE_GC_INTERVAL
        if (collectAfterOperation) singleModuleRunsSinceGc = 0
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
