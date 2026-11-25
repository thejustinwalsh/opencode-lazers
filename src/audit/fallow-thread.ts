import { parentPort } from "node:worker_threads"
import { hostImports, type ThreadStart } from "./fallow-wasi.ts"
import { releaseFallowImports } from "./fallow-wasi-lifecycle.ts"

/**
 * A helper thread of the threaded Fallow module: one rayon pool worker. For each run it is sent,
 * it instantiates the same compiled module over the run's shared memory and enters it at
 * `wasi_thread_start`, with its own read-only WASI instance over the same preopens. When the
 * entry point returns (the pool shut down) it flags that and waits for the next run; a helper
 * that never returns is terminated by the host.
 */
const port = parentPort
if (!port) throw new Error("fallow-thread must run in a worker thread")

function runThread(
  module: WebAssembly.Module,
  memory: WebAssembly.Memory,
  roots: string[],
  tid: number,
  arg: number,
): boolean {
  const sinks = { input: new Uint8Array(), inputOffset: 0, out: [], err: [] }
  let host: ReturnType<typeof hostImports> | undefined
  let imports: Record<string, Record<string, unknown>> | undefined
  let instance: WebAssembly.Instance | undefined
  try {
    host = hostImports(roots, () => memory, sinks)
    imports = {
      ...host.imports,
      env: { memory },
      // Helper threads never start threads of their own.
      wasi: { "thread-spawn": () => -1 },
    }
    instance = new WebAssembly.Instance(module, imports as WebAssembly.Imports)
    try {
      host.wasi.start({
        exports: {
          memory,
          _start: () =>
            (instance!.exports.wasi_thread_start as (tid: number, arg: number) => void)(tid, arg),
        },
      } as never)
      return true
    } catch {
      // Leave the flag unset: the host ends this worker.
      return false
    }
  } finally {
    // WASI may keep the import namespace objects alive after start. Clear their bindings (not
    // only the outer map) so they cannot pin the shared memory between helper runs.
    releaseFallowImports(imports)
    if (host) releaseFallowImports(host.imports)
    instance = undefined
    sinks.out.length = 0
    sinks.err.length = 0
  }
}

function signalCompletionAfterCollection(flag: Int32Array): void {
  setImmediate(() => {
    Bun.gc(true)
    Atomics.store(flag, 0, 1)
    Atomics.notify(flag, 0)
  })
}

port.on("message", (start: ThreadStart) => {
  const { module, memory, roots, tid, arg, flag } = start
  // MessagePort may keep its last payload reachable after dispatch. Drop its 4 GiB memory
  // reference explicitly; the local is used only until runThread returns.
  Reflect.deleteProperty(start, "memory")
  if (runThread(module, memory, roots, tid, arg))
    // The handler and run-local instance have left their stacks before collection. Signal reuse
    // only after the helper can release this run's shared memory.
    signalCompletionAfterCollection(flag)
})
