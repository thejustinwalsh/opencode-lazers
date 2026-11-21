import type { ThreadPool } from "./fallow-thread-pool.ts"

type RunResources<Host> = {
  helpers: ReturnType<ThreadPool["take"]>[]
  imports: Record<string, Record<string, unknown>>
  host: Host | undefined
  instance: WebAssembly.Instance | undefined
  memory: WebAssembly.Memory | undefined
}

/** Settle helper workers and release every reference owned by one completed WASI run. */
export function settleFallowRun<Host>(
  pool: ThreadPool,
  resources: RunResources<Host>,
  keepHelpers: boolean,
): void {
  try {
    pool.settle(resources.helpers, keepHelpers)
  } finally {
    for (const namespace of Object.keys(resources.imports)) delete resources.imports[namespace]
    resources.host = undefined
    resources.instance = undefined
    resources.memory = undefined
    resources.helpers.length = 0
  }
}
