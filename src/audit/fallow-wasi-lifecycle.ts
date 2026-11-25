import type { ThreadPool } from "./fallow-thread-pool.ts"
import type { WASI } from "node:wasi"

type RunResources = {
  helpers: ReturnType<ThreadPool["take"]>[]
  imports: Record<string, Record<string, unknown>>
  host: { wasi: WASI } | undefined
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

/**
 * Bun's node:wasi host keeps the last memory and DataView on the WASI object after `start`.
 * Imports cleanup alone does not clear those bindings.
 */
export function releaseFallowWasiMemory(wasi: WASI | undefined): void {
  if (!wasi) return
  const state = wasi as unknown as { memory?: WebAssembly.Memory; view?: DataView }
  state.view = undefined
  state.memory = undefined
}

/** Settle helper workers and release every reference owned by one completed WASI run. */
export function settleFallowRun(
  pool: ThreadPool,
  resources: RunResources,
  keepHelpers: boolean,
): void {
  try {
    pool.settle(resources.helpers, keepHelpers)
  } finally {
    releaseFallowImports(resources.imports)
    releaseFallowWasiMemory(resources.host?.wasi)
    resources.host = undefined
    resources.instance = undefined
    resources.memory = undefined
    resources.helpers.length = 0
  }
}
