// Isolated process: keep actual decision adapter tests from leaking module mocks.
import { mock } from "bun:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { ExclusiveModels, retryLoad } from "../src/webgpu/lifecycle.ts"
import { ModelLease } from "../src/webgpu/lease.ts"
import { GENERATION_RESULT_CONTRACT_REVISION, LocalInference } from "../src/webgpu/rpc.ts"
import type { DecisionRuntime } from "../src/webgpu/decision-runtime.ts"
import type { SystemOneInput } from "../src/webgpu/system-one.ts"

const contents = new Map([
  ["decoder", new Uint8Array([1])],
  ["weights", new Uint8Array([2])],
  ["tokenizer", new TextEncoder().encode("{}")],
  ["tokenizerConfig", new TextEncoder().encode("{}")],
  ["calibration", new TextEncoder().encode('{"default":1}')],
])
const decisionFiles = [...contents].map(([id, bytes]) => ({ id, bytes: bytes.length }))
let targetInputTokens = 1
let targetQuestionCount = 1
mock.module("../src/webgpu/manifest.ts", () => ({
  DECISION_FILES: decisionFiles,
  DECISION_BYTES: decisionFiles.reduce((sum, file) => sum + file.bytes, 0),
  MAX_READ_BYTES: 1,
  MODEL_FILES: [],
  MODEL_BYTES: 0,
  MODEL_REPOSITORY: "test/model",
  MODEL_REVISION: "test",
  MODEL_SHORT_NAMES: { chat: "LFM3", decision: "d1" },
  modelURL: () => "",
}))

class TestTokenizer {
  constructor(_tokenizer: unknown, _config: unknown) {}

  get_added_tokens_decoder() {
    return new Map()
  }

  encode(text: string) {
    if (text.startsWith("<|startoftext|>"))
      return { ids: Array.from({ length: targetInputTokens - targetQuestionCount + 1 }, () => 1) }
    if (text.startsWith("QUESTION:\n")) return { ids: [1] }
    if (text.includes("<|im_end|>")) return { ids: [] }
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
const counts = {
  deviceRequests: 0,
  destroys: 0,
  creates: 0,
  releases: 0,
  tensorCreates: 0,
  tensorDisposals: 0,
  runs: 0,
}
const reset = () => {
  releaseFailure = undefined
  deviceFailure = undefined
  counts.deviceRequests = 0
  counts.destroys = 0
  counts.creates = 0
  counts.releases = 0
  counts.tensorCreates = 0
  counts.tensorDisposals = 0
  counts.runs = 0
}

class TestTensor {
  constructor(
    readonly type: string,
    readonly data: BigInt64Array | Float32Array,
    readonly dims: number[],
  ) {
    counts.tensorCreates++
  }

  dispose() {
    counts.tensorDisposals++
  }
}

mock.module("onnxruntime-web/webgpu", () => ({
  env: { wasm: {} },
  Tensor: TestTensor,
  InferenceSession: {
    create: async () => {
      counts.creates++
      return {
        run: async (feeds: { slot_positions: TestTensor }) => {
          counts.runs++
          const rows = feeds.slot_positions.dims[0]!
          return {
            logits: new TestTensor("float32", new Float32Array(rows * 128_000), [rows, 128_000]),
          }
        },
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
    contract: async () => ({ revision: GENERATION_RESULT_CONTRACT_REVISION }),
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

const actualTokenCapacityGuardsBeforeTensorAllocationAndRun = async () => {
  reset()
  targetQuestionCount = 14
  targetInputTokens = 8_192
  const controller = new AbortController()
  const decision = await load(controller.signal)
  const stateTextLength = 7_026 - JSON.stringify({ payload: "" }).length
  const state = { payload: "x".repeat(stateTextLength) }
  assert.equal(JSON.stringify(state).length, 7_026)
  const questions: SystemOneInput["questions"] = Object.fromEntries(
    Array.from({ length: 14 }, (_, index) => [
      `check-${index}`,
      { type: "noul" as const, instructions: `Question ${index}: Is the behavior preserved?` },
    ]),
  )
  const input: SystemOneInput = {
    model: "d1-omni-2b",
    state,
    questions,
    timeoutMs: 60_000,
  }
  assert.ok(JSON.stringify(input).length > 8_000)

  const accepted = await decision.systemOne(input, controller.signal)
  assert.equal(accepted.usage.input_tokens, 8_192)
  assert.deepEqual(Object.keys(accepted.answers), Object.keys(questions))
  assert.equal(counts.runs, 1)
  const allocations = counts.tensorCreates

  targetInputTokens = 8_193
  await assert.rejects(
    decision.systemOne(input, controller.signal),
    (error: Error & { name?: string; required?: number; capacity?: number }) => {
      assert.equal(error.name, "ContextOverflowError")
      assert.equal(error.required, 8_193)
      assert.equal(error.capacity, 8_192)
      assert.match(error.message, /input was not truncated/)
      return true
    },
  )
  assert.equal(counts.tensorCreates, allocations, "overflow must fail before tensor allocation")
  assert.equal(counts.runs, 1, "overflow must fail before session.run")
  await decision.dispose()
  targetInputTokens = 1
  targetQuestionCount = 1
}

const cancellationAtEachAsyncDispatchBoundaryPreventsSessionRun = async () => {
  reset()
  targetQuestionCount = 1
  targetInputTokens = 16
  const decision = await load(new AbortController().signal)
  const input: SystemOneInput = {
    model: "d1-omni-2b",
    state: { evidence: "dispatch-boundary" },
    questions: { check: { type: "noul", instructions: "Is dispatch safe?" } },
    timeoutMs: 60_000,
  }

  for (const boundary of ["tokenize", "inputs-ready", "run"] as const) {
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    const controller = new AbortController()
    const allocationsBefore = counts.tensorCreates
    const disposalsBefore = counts.tensorDisposals
    const pending = decision.systemOne(input, controller.signal, async (stage) => {
      if (stage !== boundary) return
      entered()
      await gate
    })

    await started
    controller.abort(new Error(`cancelled during ${boundary}`))
    release()
    await assert.rejects(pending, new RegExp(`cancelled during ${boundary}`))
    assert.equal(counts.runs, 0, `${boundary} cancellation must prevent session.run`)
    if (boundary === "run") {
      assert.equal(counts.tensorCreates - allocationsBefore, 8)
      assert.equal(counts.tensorDisposals - disposalsBefore, 8)
    } else {
      assert.equal(counts.tensorCreates, allocationsBefore)
      assert.equal(counts.tensorDisposals, disposalsBefore)
    }
  }
  const allocationsBeforeReadback = counts.tensorCreates
  const disposalsBeforeReadback = counts.tensorDisposals
  await assert.rejects(
    decision.systemOne(input, new AbortController().signal, async (stage) => {
      if (stage === "readback") throw new Error("readback trace failed")
    }),
    /readback trace failed/,
  )
  assert.equal(counts.tensorCreates - allocationsBeforeReadback, 9)
  assert.equal(counts.tensorDisposals - disposalsBeforeReadback, 9)
  await decision.dispose()
  targetInputTokens = 1
  targetQuestionCount = 1
}

await residentReleaseBarrier()
await failedLoadBarrier(true)
await failedLoadBarrier(false)
await healthyCancellationAllowsExplicitReload()
await failedRuntimeLoadRetainsTheMainOwnershipLease()
await actualTokenCapacityGuardsBeforeTensorAllocationAndRun()
await cancellationAtEachAsyncDispatchBoundaryPreventsSessionRun()
console.log("decision cleanup, context capacity, and pre-dispatch cancellation checks passed")
