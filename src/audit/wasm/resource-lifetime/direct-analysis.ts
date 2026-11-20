import {
  runFallowModule,
  ThreadPool,
  type RunOptions,
  type WasiOutcome,
  type WasiRequest,
} from "../../fallow-wasi.ts"
import { directAnalysisScopeFor } from "./direct-analysis-scope.ts"

/**
 * Direct test analyses bypass fallow-worker's post-request collection. Release their completed
 * instance memory and helper workers before the next test call, including when WASI traps.
 */
export function runDirectFallowModule(
  module: WebAssembly.Module,
  request: WasiRequest,
  options: RunOptions = {},
): Promise<WasiOutcome> {
  const scope = directAnalysisScopeFor(request.root)
  return scope.run(async () => {
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
        const gcStarted = performance.now()
        try {
          Bun.gc(true)
        } finally {
          scope.metrics.gcMs += performance.now() - gcStarted
        }
      }
    }
  })
}
