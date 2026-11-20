import {
  runFallowModule,
  ThreadPool,
  type RunOptions,
  type WasiOutcome,
  type WasiRequest,
} from "../../fallow-wasi.ts"

let analysisTail: Promise<void> = Promise.resolve()

/**
 * Direct test analyses bypass fallow-worker's post-request collection. Release their completed
 * instance memory and helper workers before the next test call, including when WASI traps.
 */
export async function runDirectFallowModule(
  module: WebAssembly.Module,
  request: WasiRequest,
  options: RunOptions = {},
): Promise<WasiOutcome> {
  const previous = analysisTail
  let release!: () => void
  analysisTail = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  const pool = options.threadPool ?? new ThreadPool(undefined, false)
  try {
    return runFallowModule(module, request, { ...options, threadPool: pool })
  } finally {
    try {
      await pool.terminateAll()
    } finally {
      try {
        Bun.gc(true)
      } finally {
        release()
      }
    }
  }
}
