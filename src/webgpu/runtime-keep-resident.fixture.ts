// Isolated process: these module mocks must not replace inference adapters in other tests.
import { mock } from "bun:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import type { Plugin } from "@opencode/plugin/gui"
import { InferenceBroker } from "./broker.ts"
import { defaultFeatures } from "./features.ts"
import type { InferenceTraceEvent } from "./inference-trace.ts"
import { GENERATION_RESULT_CONTRACT_REVISION, LocalInference } from "./rpc.ts"

const solid: typeof import("solid-js") = await import(
  createRequire(import.meta.url).resolve("solid-js/dist/solid.js")
)
mock.module("solid-js", () => solid)

let allocations = 0
let failNextAudioLoad = false
let heldAudioLoad: PromiseWithResolvers<void> | undefined
let loseLastDevice: (() => void) | undefined
const traces: InferenceTraceEvent[] = []

const allocate = () => {
  assert.equal(allocations, 0, "Only one GPU model may be resident")
  allocations++
  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    allocations--
  }
}

mock.module("./runntime-adapter.ts", () => ({
  loadRunntimeOmni: async () => {
    if (failNextAudioLoad) {
      failNextAudioLoad = false
      throw new Error("simulated audio model load failure")
    }
    const gate = heldAudioLoad
    if (gate) await gate.promise
    if (heldAudioLoad === gate) heldAudioLoad = undefined
    const dispose = allocate()
    const lost = Promise.withResolvers<{ reason: string }>()
    loseLastDevice = () => lost.resolve({ reason: "simulated" })
    return {
      engine: {
        generate: () => {
          return {
            async *[Symbol.asyncIterator]() {
              yield "ruNNtime "
              yield "reply"
            },
            result: Promise.resolve({
              text: "ruNNtime reply",
              inputTokens: 8,
              completionTokens: 3,
              finishReason: "stop",
            }),
          }
        },
        transcribe: async () => "ruNNtime transcript",
        speak: () => ({
          async *[Symbol.asyncIterator]() {
            yield new Float32Array([0.25])
          },
          result: Promise.resolve({
            finishReason: "stop",
            samples: new Float32Array([0.25]),
            sampleRate: 24_000,
          }),
        }),
      },
      lost: lost.promise,
      dispose,
      loseDevice: () => lost.resolve({ reason: "simulated" }),
    }
  },
}))

mock.module("./runntime-decision-runtime.ts", () => ({
  loadDecisionRuntime: async () => {
    throw new Error("The decision model is not used here")
  },
}))

Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu: {} } })
const { createInferenceRuntime } = await import("./runtime.ts")
const broker = new InferenceBroker()
let acquisitions = 0
const files = {
  acquire: async () => `owner-${++acquisitions}`,
  release: async () => {},
  cancel: async () => {},
  ensure: async () => {},
  decisionEnsure: async () => {},
  status: async () => ({ phase: "cached", downloadedBytes: 0, cachedBytes: 1 }),
  decisionStatus: async () => ({ phase: "cached", downloadedBytes: 0, cachedBytes: 1 }),
  trace: async (event: InferenceTraceEvent) => traces.push(event),
}
let ownershipLost = false
const worker = {
  contract: async () => ({ revision: GENERATION_RESULT_CONTRACT_REVISION }),
  attach: async ({ owner }: { owner: string }) => broker.attach(owner),
  detach: async ({ owner, error }: { owner: string; error?: string }) =>
    broker.detach(owner, error),
  poll: async ({ owner, available }: { owner: string; available: boolean }) => {
    if (ownershipLost) {
      ownershipLost = false
      throw { type: "renderer_ownership_lost", message: "lost" }
    }
    return broker.poll(owner, available)
  },
  complete: async () => {},
  delta: async () => {},
  demand: async () => broker.demand(),
}

const [features] = solid.createSignal(defaultFeatures(true))
let now = Date.now()
type Generation = { controller: AbortController; timer?: () => void; stop: () => void }
const generation = (keepAliveMs: () => number | undefined): Generation => {
  const controller = new AbortController()
  const ctx = {
    signal: controller.signal,
    main: () => files,
    client: { rpc: (definition: unknown) => (definition === LocalInference ? {} : worker) },
  } as unknown as Parameters<Plugin.Setup>[0]
  const result: Generation = { controller, stop: () => {} }
  solid.createRoot((dispose) => {
    result.stop = dispose
    createInferenceRuntime(ctx, keepAliveMs, undefined, features, {
      wallNow: () => now,
      schedule: (callback) => {
        result.timer = callback
        return () => {
          result.timer = undefined
        }
      },
      serviceTimeoutMs: 2_000,
    })
  })
  return result
}
const tickUntil = async (current: Generation, condition: () => boolean, description: string) => {
  const deadline = Date.now() + 5_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`)
    now += 500 // backoff windows use the injected wall clock
    current.timer?.()
    await Bun.sleep(5)
  }
}
const settle = async (current: Generation, ticks = 20) => {
  for (let i = 0; i < ticks; i++) {
    current.timer?.()
    await Bun.sleep(5)
  }
}

try {
  // Never: resident without any job, and stays resident across a long idle period.
  const a = generation(() => -1)
  await tickUntil(a, () => allocations === 1, "Never preloads without a job")
  now += 10 * 60 * 60_000
  await settle(a)
  assert.equal(allocations, 1, "Never survives a long idle period")

  // Renderer generation reload: A is disposed, B restores from the same store value.
  a.controller.abort()
  await tickUntil(a, () => allocations === 0, "generation A disposal")
  a.stop()
  const b = generation(() => -1)
  await tickUntil(b, () => allocations === 1, "generation B restores the model without a job")

  // Ownership loss unloads, then reattaches and reloads.
  ownershipLost = true
  await tickUntil(b, () => !ownershipLost, "ownership loss observed")
  await tickUntil(b, () => allocations === 1, "ownership loss restores the model")

  // Device loss recovers through the existing recovery path and stays resident.
  loseLastDevice?.()
  await tickUntil(b, () => allocations === 1 && b.timer !== undefined, "device loss recovery")
  now += 60 * 60_000
  await settle(b)
  assert.equal(allocations, 1)
  b.controller.abort()
  await tickUntil(b, () => allocations === 0, "generation B disposal")
  b.stop()

  // Unhydrated store (undefined) is neither Never nor 60 seconds: nothing loads or unloads.
  let hydrated: number | undefined
  const c = generation(() => hydrated)
  await settle(c)
  assert.equal(allocations, 0, "An unhydrated preference does not preload")
  hydrated = -1
  await tickUntil(c, () => allocations === 1, "hydrated Never loads")
  hydrated = undefined
  now += 61_000
  await settle(c)
  assert.equal(allocations, 1, "An unhydrated preference is not treated as 60 seconds")
  hydrated = 60_000
  now += 61_000
  await tickUntil(c, () => allocations === 0, "explicit 60 second idle unload")
  c.controller.abort()
  await settle(c, 5)
  c.stop()
  console.log("Keep-resident checks passed")
  process.exit(0)
} catch (error) {
  console.error(error)
  process.exit(1)
}
