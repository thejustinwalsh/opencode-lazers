// Isolated process: keep actual decision adapter tests from leaking module mocks.
import { mock } from "bun:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { ExclusiveModels, retryLoad } from "../src/webgpu/lifecycle.ts"
import { ModelLease } from "../src/webgpu/lease.ts"
import { LocalInference } from "../src/webgpu/rpc.ts"
import type { DecisionRuntime } from "../src/webgpu/decision-runtime.ts"

const contents = new Map([
  ["decoder", new Uint8Array([1])],
  ["weights", new Uint8Array([2])],
  ["tokenizer", new TextEncoder().encode("{}")],
  ["tokenizerConfig", new TextEncoder().encode("{}")],
  ["calibration", new TextEncoder().encode('{"default":1}')],
])
const decisionFiles = [...contents].map(([id, bytes]) => ({ id, bytes: bytes.length }))
mock.module("../src/webgpu/manifest.ts", () => ({
  DECISION_FILES: decisionFiles,
  DECISION_BYTES: decisionFiles.reduce((sum, file) => sum + file.bytes, 0),
  MAX_READ_BYTES: 1,
  MODEL_FILES: [],
  MODEL_BYTES: 0,
  MODEL_REPOSITORY: "test/model",
  MODEL_REVISION: "test",
  modelURL: () => "",
}))

class TestTokenizer {
  constructor(_tokenizer: unknown, _config: unknown) {}

  get_added_tokens_decoder() {
    return new Map()
  }

  encode(text: string) {
    return { ids: text ? [1] : [] }
  }
}
mock.module("@huggingface/tokenizers", () => ({ Tokenizer: TestTokenizer }))
mock.module("../src/webgpu/system-one.ts", () => ({
  describe: () => "",
  probabilities: () => [],
  readAnswer: () => undefined,
  renderQuestion: () => "",
  SystemOneRequest: { parse: (input: unknown) => input },
}))

let releaseFailure: Error | undefined
let deviceFailure: Error | undefined
const counts = { deviceRequests: 0, destroys: 0, creates: 0, releases: 0 }
const reset = () => {
  releaseFailure = undefined
  deviceFailure = undefined
  counts.deviceRequests = 0
  counts.destroys = 0
  counts.creates = 0
  counts.releases = 0
}

mock.module("onnxruntime-web/webgpu", () => ({
  env: { wasm: {} },
  InferenceSession: {
    create: async () => {
      counts.creates++
      return {
        release: async () => {
          counts.releases++
          if (releaseFailure) throw releaseFailure
        },
      }
    },
  },
}))
mock.module("onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url", () => ({
  default: "test.wasm",
}))
mock.module("onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url", () => ({
  default: "test.mjs",
}))
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    gpu: {
      requestAdapter: async () => {
        counts.deviceRequests++
        return {
          limits: { maxStorageBufferBindingSize: 1_073_741_824 },
          requestDevice: async () => ({
            lost: new Promise(() => {}),
            destroy: () => {
              counts.destroys++
              if (deviceFailure) throw deviceFailure
            },
          }),
        }
      },
    },
  },
})

const { loadDecisionRuntime } = await import("../src/webgpu/decision-runtime.ts")
const read = async (id: string, offset: number, length: number) =>
  Buffer.from(contents.get(id)!.slice(offset, offset + length)).toString("base64")
const load = (signal: AbortSignal, trace?: Parameters<typeof loadDecisionRuntime>[4]) =>
  loadDecisionRuntime(
    read,
    signal,
    () => {},
    () => {},
    trace,
  )
const retriedLoad = (
  signal: AbortSignal,
  track: () => void,
  trace?: Parameters<typeof loadDecisionRuntime>[4],
) =>
  retryLoad(
    () => {
      track()
      return load(signal, trace)
    },
    signal,
    () => assert.fail("Cleanup uncertainty must not schedule a model-load retry"),
  )

type Models = { decision: DecisionRuntime; chat: { dispose(): Promise<void> } }

const residentReleaseBarrier = async () => {
  reset()
  releaseFailure = Error("GPU device lost while ORT released its session")
  const models = new ExclusiveModels<Models>()
  const signal = new AbortController().signal
  let loads = 0
  const decision = await models.ensure("decision", () => retriedLoad(signal, () => loads++), signal)

  const concurrent = await Promise.allSettled([models.release(), models.release()])
  assert.ok(concurrent.every((result) => result.status === "rejected"))
  await assert.rejects(
    models.ensure("decision", () => retriedLoad(signal, () => loads++), signal),
    /GPU device lost/,
  )
  await assert.rejects(
    models.ensure(
      "chat",
      async () => {
        throw new Error("A chat model must not be allocated")
      },
      signal,
    ),
    /GPU device lost/,
  )
  await assert.rejects(models.release(), /GPU device lost/)
  assert.equal(models.isTainted(), true)
  assert.equal(models.current(), "decision")
  assert.equal(models.get("decision"), undefined)
  assert.equal(loads, 1)
  assert.equal(counts.creates, 1)
  assert.equal(counts.releases, 1)
  assert.equal(counts.destroys, 1)
  await assert.rejects(
    decision.systemOne(
      {
        model: "d1-omni-2b",
        state: {},
        questions: { q: { type: "noul", instructions: "Is the model usable?" } },
      },
      signal,
    ),
    /disposed/,
  )
}

const failedLoadBarrier = async (cancel: boolean) => {
  reset()
  releaseFailure = Error("GPU device lost during ORT cleanup")
  const models = new ExclusiveModels<Models>()
  const controller = new AbortController()
  let loads = 0
  const trace = async (stage: string) => {
    if (stage !== "session-ready") return
    if (cancel) controller.abort(new Error("decision load cancelled after session creation"))
    else throw new Error("GPU device lost after session became ready")
  }
  await assert.rejects(
    models.ensure(
      "decision",
      () => retriedLoad(controller.signal, () => loads++, trace),
      controller.signal,
    ),
    /cleanup failed|GPU device lost|cancelled/,
  )
  assert.equal(models.isTainted(), true)
  assert.equal(models.current(), "decision")
  assert.equal(models.get("decision"), undefined)
  assert.equal(loads, 1, "retryLoad must not replay an allocation with uncertain cleanup")
  assert.equal(counts.creates, 1)
  assert.equal(counts.releases, 1)
  assert.equal(counts.destroys, 1)

  const retrySignal = new AbortController().signal
  await assert.rejects(
    models.ensure("decision", () => retriedLoad(retrySignal, () => loads++), retrySignal),
    /GPU device lost/,
  )
  await assert.rejects(
    models.ensure("chat", async () => ({ dispose: async () => {} }), retrySignal),
    /GPU device lost/,
  )
  await assert.rejects(models.release(), /GPU device lost/)
  assert.equal(loads, 1)
  assert.equal(counts.creates, 1)
  assert.equal(counts.releases, 1)
  assert.equal(counts.destroys, 1)
}

const healthyCancellationAllowsExplicitReload = async () => {
  reset()
  const models = new ExclusiveModels<Models>()
  const cancelled = new AbortController()
  let creates = 0
  await assert.rejects(
    models.ensure(
      "decision",
      () =>
        retriedLoad(
          cancelled.signal,
          () => creates++,
          async (stage) => {
            if (stage === "session-ready")
              cancelled.abort(new Error("decision load cancelled after session creation"))
          },
        ),
      cancelled.signal,
    ),
    /cancelled/,
  )
  assert.equal(models.current(), undefined)
  assert.equal(models.isTainted(), false)
  assert.equal(counts.releases, 1)
  assert.equal(counts.destroys, 1)

  const signal = new AbortController().signal
  const decision = await models.ensure(
    "decision",
    () => retriedLoad(signal, () => creates++),
    signal,
  )
  assert.equal(models.get("decision"), decision)
  const order: string[] = []
  await models.ensure(
    "chat",
    async () => {
      order.push("chat allocated")
      return {
        dispose: async () => {
          order.push("chat disposed")
        },
      }
    },
    signal,
  )
  assert.deepEqual(order, ["chat allocated"])
  assert.equal(counts.releases, 2)
  assert.equal(counts.destroys, 2)
  await models.release()
  assert.deepEqual(order, ["chat allocated", "chat disposed"])
}

const failedRuntimeLoadRetainsTheMainOwnershipLease = async () => {
  reset()
  releaseFailure = Error("GPU device lost during ORT cleanup")
  const contextController = new AbortController()
  const lease = new ModelLease(async () => {})
  let cancelledAtSessionReady = false
  const files = {
    trace: async (event: { stage: string }) => {
      if (event.stage === "session-ready" && !cancelledAtSessionReady) {
        cancelledAtSessionReady = true
        contextController.abort(new Error("renderer closed during decision load"))
      }
    },
    acquire: async () => lease.acquire(1),
    release: async ({ owner }: { owner: string }) => lease.release(1, owner),
    cancel: async ({ owner }: { owner: string }) => lease.assert(1, owner),
    ensure: async () => {},
    decisionEnsure: async () => {},
    read: async ({ id, offset, length }: { id: string; offset: number; length: number }) =>
      read(id, offset, length),
    decisionRead: async ({ id, offset, length }: { id: string; offset: number; length: number }) =>
      read(id, offset, length),
    status: async () => ({ phase: "cached" }),
    decisionStatus: async () => ({ phase: "cached" }),
  }
  const worker = {
    attach: async () => {},
    detach: async () => {},
    poll: async () => ({}),
    complete: async () => {},
    demand: async () => ({ requested: false }),
  }

  mock.module("../.cache/lfm3-engine.js", () => ({ Lfm3OmniForConditionalGeneration: {} }))
  const solid: typeof import("solid-js") = await import(
    createRequire(import.meta.url).resolve("solid-js/dist/solid.js")
  )
  mock.module("solid-js", () => solid)
  const { createInferenceRuntime } = await import("../src/webgpu/runtime.ts")
  const [features] = solid.createSignal({
    enabled: true,
    questions: false,
    decisions: true,
    review: false,
    dictation: false,
    readAloud: false,
  })
  let releaseRoot!: () => void
  const runtime = solid.createRoot((dispose) => {
    releaseRoot = dispose
    return createInferenceRuntime(
      {
        signal: contextController.signal,
        main: () => files,
        client: { rpc: (definition: unknown) => (definition === LocalInference ? {} : worker) },
      } as never,
      () => -1,
      undefined,
      features,
    )
  })
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 4_000
    while (!condition()) {
      if (Date.now() > deadline)
        throw Error(`Timed out waiting for failed load: ${runtime.state()} ${runtime.detail()}`)
      await Bun.sleep(10)
    }
  }
  try {
    await until(() => runtime.state() === "error")
    const detailAtError = runtime.detail()
    await runtime.dispose()
    assert.equal(cancelledAtSessionReady, true, detailAtError)
    assert.equal(runtime.state(), "error", "uncertain cleanup must not report Ready")
    assert.equal(runtime.resident(), "decision")
    assert.equal(lease.occupied(), true, "the main ownership lease must remain held")
    assert.throws(() => lease.acquire(2), /owned or being cleaned up/)
    assert.equal(counts.creates, 1)
    assert.equal(counts.releases, 1)
    assert.equal(counts.destroys, 1)
  } finally {
    contextController.abort()
    await runtime.dispose()
    releaseRoot()
  }
}

await residentReleaseBarrier()
await failedLoadBarrier(true)
await failedLoadBarrier(false)
await healthyCancellationAllowsExplicitReload()
await failedRuntimeLoadRetainsTheMainOwnershipLease()
console.log("decision cleanup fault injection passed")
