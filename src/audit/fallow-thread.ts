import { parentPort } from "node:worker_threads"
import { hostImports, StdoutBuffer, type ThreadStart } from "./fallow-wasi.ts"
import { releaseFallowImports, releaseFallowWasiMemory } from "./fallow-wasi-lifecycle.ts"

/**
 * A helper thread of the threaded Fallow module: one rayon pool worker. For each run it is sent,
 * it instantiates the same compiled module over the run's shared memory and enters it at
 * `wasi_thread_start`, with its own read-only WASI instance over the same preopens. When the
 * entry point returns (the pool shut down) it flags that and waits for the next run; a helper
 * that never returns is terminated by the host.
 */
const port = parentPort
if (!port) throw new Error("fallow-thread must run in a worker thread")

function runThread(start: ThreadStart): boolean {
  const { module, roots, tid, arg } = start
  let memory: WebAssembly.Memory | undefined = start.memory
  Reflect.deleteProperty(start, "memory")
  const sinks = { input: new Uint8Array(), inputOffset: 0, out: new StdoutBuffer(), err: [] }
  let host: ReturnType<typeof hostImports> | undefined
  let imports: Record<string, Record<string, unknown>> | undefined
  let instance: WebAssembly.Instance | undefined
  try {
    // Keep the captured binding mutable: WASI may retain an import closure after start returns.
    host = hostImports(roots, () => memory!, sinks)
    imports = {
      ...host.imports,
      env: { memory: memory! },
      // Helper threads never start threads of their own.
      wasi: { "thread-spawn": () => -1 },
    }
    instance = new WebAssembly.Instance(module, imports as WebAssembly.Imports)
    try {
      host.wasi.start({
        exports: {
          memory: memory!,
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
    releaseFallowWasiMemory(host?.wasi)
    instance = undefined
    sinks.out.take()
    sinks.err.length = 0
    // If a retained WASI closure outlives this run, it must not keep the shared memory alive.
    memory = undefined
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
  const flag = start.flag
  // MessagePort may keep its last payload reachable after dispatch. Drop its 4 GiB memory
  // reference explicitly; runThread also clears its captured memory binding in its finally block.
  if (runThread(start))
    // The handler and run-local instance have left their stacks before collection. Signal reuse
    // only after the helper can release this run's shared memory.
    signalCompletionAfterCollection(flag)
})
