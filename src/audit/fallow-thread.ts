import { parentPort } from "node:worker_threads"
import { hostImports, StdoutBuffer, type ThreadStart } from "./fallow-wasi.ts"

/**
 * A helper thread of the threaded Fallow module: one rayon pool worker. For each run it is sent,
 * it instantiates the same compiled module over the run's shared memory and enters it at
 * `wasi_thread_start`, with its own read-only WASI instance over the same preopens. When the
 * entry point returns (the pool shut down) it releases the run's memory, flags that and waits
 * for the next run; a helper that never returns is terminated by the host.
 *
 * The 4 GiB shared memory is freed only when the last thread drops it and collects, so the
 * helper drops every reference to it and collects before it flags: an idle helper must not keep
 * the finished run's memory alive until its next message.
 */
const port = parentPort
if (!port) throw new Error("fallow-thread must run in a worker thread")

/** Run the thread to completion; true when its entry point returned. Holds no reference after. */
function enter(start: ThreadStart): boolean {
  const sinks = { input: new Uint8Array(), inputOffset: 0, out: new StdoutBuffer(), err: [] }
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
    return true
  } catch {
    // Leave the flag unset: the host ends this worker.
    return false
  }
}

port.on("message", (start: ThreadStart) => {
  const flag = start.flag
  if (!enter(start)) return
  // After this handler returns, so `start` (and its memory) is no longer on the stack.
  setImmediate(() => {
    Bun.gc(true)
    Atomics.store(flag, 0, 1)
    Atomics.notify(flag, 0)
  })
})
