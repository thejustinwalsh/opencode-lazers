import type { ThreadPool } from "./fallow-thread-pool.ts"

type RunResources<Host> = {
  helpers: ReturnType<ThreadPool["take"]>[]
  imports: Record<string, Record<string, unknown>>
  host: Host | undefined
  instance: WebAssembly.Instance | undefined
  memory: WebAssembly.Memory | undefined
}

/** Clear inner bindings before dropping namespace maps; a retained namespace must not pin memory. */
export function releaseFallowImports(
  imports: Record<string, Record<string, unknown>> | undefined,
): void {
  if (!imports) return
  for (const namespace of Object.values(imports))
    for (const name of Object.keys(namespace)) delete namespace[name]
  for (const name of Object.keys(imports)) delete imports[name]
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
    releaseFallowImports(resources.imports)
    resources.host = undefined
    resources.instance = undefined
    resources.memory = undefined
    resources.helpers.length = 0
  }
}
