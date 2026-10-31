// Isolated process: module mocks must never replace real inference adapters in other tests.
import { mock } from "bun:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { InferenceBroker } from "../src/webgpu/broker.ts"
import { ModelLease } from "../src/webgpu/lease.ts"
import { defaultFeatures } from "../src/webgpu/features.ts"
import type { Plugin } from "@opencode/plugin/gui"
import { LocalInference } from "../src/webgpu/rpc.ts"

const solid: typeof import("solid-js") = await import(
  createRequire(import.meta.url).resolve("solid-js/dist/solid.js")
)
mock.module("solid-js", () => solid)
let allocations = 0
let maximum = 0
let releases = 0
let cleanupAttempts = 0
let failCleanup = false
let cleanupGate: Promise<void> | undefined
const allocate = () => {
  assert.equal(allocations, 0, "A second GPU model must never allocate")
  allocations++
  maximum = Math.max(maximum, allocations)
  let disposed = false
  return async () => {
    cleanupAttempts++
    await cleanupGate
    if (failCleanup) throw Error("simulated GPU cleanup failure")
    if (disposed) return
    disposed = true
    allocations--
    releases++
  }
}
mock.module("../.cache/lfm3-engine.js", () => ({
  Lfm3OmniForConditionalGeneration: {
    from_pretrained: async () => ({
      dispose: allocate(),
      lost: new Promise(() => {}),
      deviceInfo: () => ({ description: "Test GPU" }),
      create_session: () => ({
        dispose: async () => {},
        generate: () => ({
          async *[Symbol.asyncIterator]() {},
          result: Promise.resolve({
            message: { content: "ready" },
            usage: { prompt_tokens: 1, completion_tokens: 1 },
            finish_reason: "stop",
          }),
        }),
      }),
    }),
  },
}))
mock.module("../src/webgpu/decision-runtime.ts", () => ({
  loadDecisionRuntime: async (
    _read: unknown,
    _signal: unknown,
    _progress: unknown,
    lost: () => void,
  ) => ({
    dispose: allocate(),
    loseDevice: lost,
    systemOne: async () => ({
      model: "d1-omni-2b",
      answers: { q: { type: "noul", noul: 0.9 } },
      usage: { input_tokens: 1, output_tokens: 0 },
    }),
  }),
}))
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu: {} } })
const { createInferenceRuntime } = await import("../src/webgpu/runtime.ts")
const broker = new InferenceBroker()
const lease = new ModelLease(async () => {})
const controller = new AbortController()
const worker = {
  attach: async ({ owner }: { owner: string }) => broker.attach(owner),
  detach: async ({ owner, error }: { owner: string; error?: string }) =>
    broker.detach(owner, error),
  poll: async ({ owner, available }: { owner: string; available: boolean }) =>
    broker.poll(owner, available),
  complete: async ({
    owner,
    id,
    result,
  }: Parameters<InferenceBroker["complete"]> extends [string, string, infer R]
    ? { owner: string; id: string; result: R }
    : never) => broker.complete(owner, id, result),
  demand: async () => broker.demand(),
}
const files = {
  acquire: async () => lease.acquire(1),
  release: async ({ owner }: { owner: string }) => lease.release(1, owner),
  cancel: async ({ owner }: { owner: string }) => lease.assert(1, owner),
  ensure: async () => {},
  decisionEnsure: async () => {},
  status: async () => ({ phase: "cached" }),
  decisionStatus: async () => ({ phase: "cached" }),
}
const ctx = {
  signal: controller.signal,
  main: () => files,
  client: { rpc: (definition: unknown) => (definition === LocalInference ? {} : worker) },
} as unknown as Parameters<Plugin.Setup>[0]
const [features, setFeatures] = solid.createSignal(defaultFeatures(true))
let releaseRoot!: () => void
const runtime = solid.createRoot((dispose) => {
  releaseRoot = dispose
  return createInferenceRuntime(ctx, () => -1, undefined, features)
})
const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 4_000
  while (!condition()) {
    if (Date.now() > deadline) throw Error(`Timed out: ${runtime.state()} ${runtime.detail()}`)
    await Bun.sleep(10)
  }
}
try {
  await until(() => runtime.state() === "ready")
  const answer = await broker.generate(
    { prompt: "hello", maxTokens: 16, timeoutMs: 3_000 },
    controller.signal,
  )
  assert.equal(answer.text, "ready")
  const decision = () =>
    broker.generate(
      { prompt: "{}", mode: "systemone", maxTokens: 1, timeoutMs: 3_000 },
      controller.signal,
    )
  assert.equal((await decision()).ok, true)
  assert.equal(runtime.resident(), "decision")
  for (let loss = 0; loss < 3; loss++) {
    const before = releases
    runtime.simulateDeviceLoss()
    await until(
      () => releases > before && (runtime.state() === "ready" || runtime.state() === "error"),
    )
  }
  assert.equal(runtime.state(), "error")
  assert.match(runtime.detail(), /recovery stopped/)
  const afterCircuit = releases
  await Bun.sleep(700)
  assert.equal(
    allocations,
    0,
    "The ordinary poll loop must not bypass the recovery circuit breaker",
  )
  assert.equal(releases, afterCircuit)
  assert.equal((await decision()).ok, true, "An explicit new request may attempt recovery")

  const gate = Promise.withResolvers<void>()
  cleanupGate = gate.promise
  const first = runtime.unload()
  const second = runtime.unload()
  assert.equal(first, second, "Concurrent unload callers must await the same disposal")
  await Bun.sleep(10)
  assert.equal(lease.occupied(), true)
  assert.equal(allocations, 1)
  await runtime.load()
  assert.equal(allocations, 1)
  gate.resolve()
  await Promise.all([first, second])
  cleanupGate = undefined
  assert.equal(lease.occupied(), false)
  assert.equal(allocations, 0)

  // Demand can reload after an unload; a disposal failure must retain the main lease.
  assert.equal((await decision()).ok, true)
  failCleanup = true
  await runtime.unload()
  assert.equal(runtime.state(), "error")
  assert.equal(lease.occupied(), true)
  assert.equal(allocations, 1)
  assert.throws(() => lease.acquire(2))
  assert.equal(
    (await decision()).ok,
    false,
    "A failed-disposal model must not be reused for another request",
  )
  setFeatures(defaultFeatures(false))
  await Bun.sleep(30)
  const attempts = cleanupAttempts
  await Bun.sleep(650)
  assert.equal(
    cleanupAttempts,
    attempts,
    "A disabled failed-cleanup runtime must not spin on disposal",
  )
  assert.equal(runtime.state(), "error", "Failed disposal must not claim GPU memory was freed")
  setFeatures(defaultFeatures(true))
  failCleanup = false
  await runtime.unload()
  assert.equal(lease.occupied(), false)
  assert.equal(maximum, 1)
  assert.equal((await decision()).ok, true)
  const finalGate = Promise.withResolvers<void>()
  cleanupGate = finalGate.promise
  const disposing = runtime.dispose()
  controller.abort()
  assert.equal(
    runtime.dispose(),
    disposing,
    "Abort cleanup and host teardown must await the same disposal",
  )
  await Bun.sleep(10)
  assert.equal(lease.occupied(), true)
  finalGate.resolve()
  await disposing
  cleanupGate = undefined
  assert.equal(lease.occupied(), false)
  assert.equal(allocations, 0)
  console.log("Renderer lifecycle fault injection passed")
} finally {
  failCleanup = false
  cleanupGate = undefined
  controller.abort()
  await runtime.dispose()
  releaseRoot()
  broker.close()
}
