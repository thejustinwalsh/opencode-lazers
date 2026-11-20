import { rmSync } from "node:fs"
import { Worker } from "node:worker_threads"
import { join } from "node:path"
import { WasiTrap } from "../../fallow-wasi.ts"
import { runDirectFallowModule } from "./direct-analysis.ts"
import {
  makeFixture,
  repoRoot,
  runOp,
  threadedWasmModule,
  wasmModule,
  type ModuleKind,
} from "../test-support.ts"

const modules = {
  single: { module: wasmModule, threads: 1 },
  threads: { module: threadedWasmModule, threads: 2 },
} satisfies Record<ModuleKind, { module: WebAssembly.Module; threads: number }>
const instanceRefs: WeakRef<WebAssembly.Instance>[] = []
const memoryRefs: WeakRef<WebAssembly.Memory>[] = []
let completed = 0
let expectedFailures = 0
let peakRssMb = 0
let pendingTerminations = 0
let peakPendingTerminations = 0
const terminateWorker = Worker.prototype.terminate
Worker.prototype.terminate = function (this: Worker): Promise<number> {
  pendingTerminations++
  peakPendingTerminations = Math.max(peakPendingTerminations, pendingTerminations)
  return terminateWorker.call(this).finally(() => pendingTerminations--)
}

const observeInstance = (instance: WebAssembly.Instance) => {
  instanceRefs.push(new WeakRef(instance))
  const memory = instance.exports.memory
  if (!(memory instanceof WebAssembly.Memory))
    throw new Error("analysis instance did not export its linear memory")
  memoryRefs.push(new WeakRef(memory))
}

const recordRss = () => {
  peakRssMb = Math.max(peakRssMb, Math.round(process.memoryUsage().rss / 1048576))
}

const fixture = makeFixture({ "config/bad.json": "{ nope" })
const badConfig = join(fixture, "config/bad.json")

try {
  for (let round = 0; round < 4; round++) {
    for (const kind of ["single", "threads"] as const) {
      const { threads } = modules[kind]
      for (const outcome of ["success", "failure"] as const) {
        const options = {
          maxThreads: threads,
          onInstance: observeInstance,
          ...(outcome === "failure" ? { extraRoots: [join(fixture, "config")] } : {}),
        }
        if (outcome === "success") {
          await runOp("deadCode", repoRoot, {}, options, kind)
          completed++
        } else {
          try {
            await runOp("duplicationReport", repoRoot, { configPath: badConfig }, options, kind)
            throw new Error(`${kind} module unexpectedly accepted an invalid configuration`)
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !error.message.startsWith("FALLOW_CONFIG_LOAD_FAILED:")
            )
              throw error
            expectedFailures++
          }
        }
        if (pendingTerminations !== 0)
          throw new Error(
            `direct analysis left ${pendingTerminations} helper termination(s) pending`,
          )
        recordRss()
      }
    }
  }

  // Force a trap after the threaded module starts a helper and check that failed calls also wait
  // for teardown before resolving.
  for (let round = 0; round < 4; round++) {
    try {
      await runDirectFallowModule(
        threadedWasmModule,
        {
          op: "deadCode",
          root: repoRoot,
          options: { threads: modules.threads.threads, explain: true, css: true },
        },
        {
          maxThreads: modules.threads.threads,
          onInstance: observeInstance,
          onSpawn: () => {
            throw new Error("intentional helper teardown probe")
          },
        },
      )
      throw new Error("threaded module unexpectedly completed the teardown probe")
    } catch (error) {
      if (!(error instanceof WasiTrap)) throw error
      completed++
    }
    if (pendingTerminations !== 0)
      throw new Error(
        `failed direct analysis left ${pendingTerminations} helper termination(s) pending`,
      )
    recordRss()
  }

  await Bun.sleep(0)
  Bun.gc(true)
  const retainedInstances = instanceRefs.filter((ref) => ref.deref() !== undefined).length
  const retainedMemories = memoryRefs.filter((ref) => ref.deref() !== undefined).length
  if (peakPendingTerminations > 2)
    throw new Error(`direct helper termination peak exceeded its bound: ${peakPendingTerminations}`)

  console.log(
    JSON.stringify({
      completed,
      expectedFailures,
      retainedInstances,
      retainedMemories,
      peakRssMb,
      helperTerminations: {
        pending: pendingTerminations,
        peakPending: peakPendingTerminations,
      },
    }),
  )
} finally {
  Worker.prototype.terminate = terminateWorker
  await Bun.sleep(0)
  Bun.gc(true)
  rmSync(fixture, { recursive: true, force: true })
}
