import { Worker } from "node:worker_threads"
import { join } from "node:path"
import { WasiTrap } from "../../fallow-wasi.ts"
import { runDirectFallowModule } from "./direct-analysis.ts"
import { directAnalysisScopeFor } from "./direct-analysis-scope.ts"
import {
  disposeFixture,
  makeFixture,
  repoRoot,
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
const scheduledInstanceRefs: WeakRef<WebAssembly.Instance>[] = []
const scheduledMemoryRefs: WeakRef<WebAssembly.Memory>[] = []
const memorySizes: number[] = []
const instancesByKind: Record<ModuleKind, number> = { single: 0, threads: 0 }
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

const observeInstance = (kind: ModuleKind) => (instance: WebAssembly.Instance) => {
  instanceRefs.push(new WeakRef(instance))
  const memory = instance.exports.memory
  if (!(memory instanceof WebAssembly.Memory))
    throw new Error("analysis instance did not export its linear memory")
  memoryRefs.push(new WeakRef(memory))
  memorySizes.push(memory.buffer.byteLength)
  instancesByKind[kind]++
}

const recordRss = () => {
  peakRssMb = Math.max(peakRssMb, Math.round(process.memoryUsage().rss / 1048576))
}

const fixture = makeFixture({ "config/bad.json": "{ nope" })
const badConfig = join(fixture, "config/bad.json")

try {
  const scope = directAnalysisScopeFor(fixture)
  const gcBeforeSingleBatch = scope.metrics.gcMs
  for (let run = 0; run < 8; run++) {
    await runDirectFallowModule(
      wasmModule,
      {
        op: "health",
        root: fixture,
        options: { threads: 1, cache: false },
      },
      {
        maxThreads: 1,
        onInstance: (instance) => {
          scheduledInstanceRefs.push(new WeakRef(instance))
          const memory = instance.exports.memory
          if (!(memory instanceof WebAssembly.Memory))
            throw new Error("analysis instance did not export its linear memory")
          scheduledMemoryRefs.push(new WeakRef(memory))
        },
      },
    )
    recordRss()
  }
  const scheduledCollectionGcMs = Math.round(scope.metrics.gcMs - gcBeforeSingleBatch)
  if (scheduledCollectionGcMs <= 0)
    throw new Error("eight single-module analyses did not trigger scheduled collection")

  for (let round = 0; round < 4; round++) {
    for (const kind of ["single", "threads"] as const) {
      const { threads } = modules[kind]
      for (const outcome of ["success", "failure"] as const) {
        const options = {
          maxThreads: threads,
          onInstance: observeInstance(kind),
          ...(outcome === "failure" ? { extraRoots: [join(fixture, "config")] } : {}),
        }
        const failed = outcome === "failure"
        const result = await runDirectFallowModule(
          modules[kind].module,
          {
            op: failed ? "duplicationReport" : "deadCode",
            root: repoRoot,
            ...(failed ? { configPath: badConfig } : {}),
            options: { threads, explain: true, css: true, cache: false },
          },
          options,
        )
        const parsed = JSON.parse(result.stdout) as {
          report?: unknown
          error?: { code?: string; message?: string }
        }
        if (!failed) {
          if (parsed.error || parsed.report === undefined)
            throw new Error(`unexpected ${kind} analysis result: ${JSON.stringify(parsed.error)}`)
          completed++
        } else {
          if (parsed.error?.code !== "FALLOW_CONFIG_LOAD_FAILED")
            throw new Error(
              `${kind} module unexpectedly accepted an invalid configuration: ${JSON.stringify(parsed.error)}`,
            )
          expectedFailures++
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
          onInstance: observeInstance("threads"),
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
  const retainedInstances = [...instanceRefs, ...scheduledInstanceRefs].filter(
    (ref) => ref.deref() !== undefined,
  ).length
  const retainedMemories = [...memoryRefs, ...scheduledMemoryRefs].filter(
    (ref) => ref.deref() !== undefined,
  ).length
  const timings = directAnalysisScopeFor(repoRoot).metrics
  if (peakPendingTerminations > 2)
    throw new Error(`direct helper termination peak exceeded its bound: ${peakPendingTerminations}`)
  if (timings.pendingHelpers !== 0)
    throw new Error(`direct analysis left ${timings.pendingHelpers} helpers pending`)

  console.log(
    JSON.stringify({
      completed,
      expectedFailures,
      instancesByKind,
      observedInstances: instanceRefs.length,
      scheduledCollectionRuns: scheduledInstanceRefs.length,
      scheduledCollectionGcMs,
      distinctMemorySizes: [...new Set(memorySizes)],
      retainedInstances,
      retainedMemories,
      peakRssMb,
      helperTerminations: {
        pending: pendingTerminations,
        peakPending: peakPendingTerminations,
      },
      timings: {
        queued: timings.queued,
        started: timings.started,
        cancelled: timings.cancelled,
        queueWaitMs: Math.round(timings.queueWaitMs),
        executionMs: Math.round(timings.executionMs),
        terminationMs: Math.round(timings.terminationMs),
        gcMs: Math.round(timings.gcMs),
        peakHelpers: timings.peakHelpers,
        pendingHelpers: timings.pendingHelpers,
      },
    }),
  )
} finally {
  Worker.prototype.terminate = terminateWorker
  await Bun.sleep(0)
  Bun.gc(true)
  await disposeFixture(fixture)
}
