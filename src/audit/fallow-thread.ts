import { parentPort } from "node:worker_threads"
import { hostImports, type ThreadStart } from "./fallow-wasi.ts"

/**
 * A helper thread of the threaded Fallow module: one rayon pool worker. For each run it is sent,
 * it instantiates the same compiled module over the run's shared memory and enters it at
 * `wasi_thread_start`, with its own read-only WASI instance over the same preopens. When the
 * entry point returns (the pool shut down) it flags that and waits for the next run; a helper
 * that never returns is terminated by the host.
 */
const port = parentPort
if (!port) throw new Error("fallow-thread must run in a worker thread")

port.on("message", (start: ThreadStart) => {
  const sinks = { input: new Uint8Array(), inputOffset: 0, out: [], err: [] }
  const { wasi, imports } = hostImports(start.roots, () => start.memory, sinks)
  const instance = new WebAssembly.Instance(start.module, {
    ...imports,
    env: { memory: start.memory },
    // Helper threads never start threads of their own.
    wasi: { "thread-spawn": () => -1 },
  } as WebAssembly.Imports)
  try {
    wasi.start({
      exports: {
        memory: start.memory,
        _start: () =>
          (instance.exports.wasi_thread_start as (tid: number, arg: number) => void)(
            start.tid,
            start.arg,
          ),
      },
    } as never)
    Atomics.store(start.flag, 0, 1)
    Atomics.notify(start.flag, 0)
  } catch {
    // Leave the flag unset: the host ends this worker.
  }
})
