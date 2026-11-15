// Isolated process: these module mocks must not replace inference adapters in other tests.
import { mock } from "bun:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import type { Plugin } from "@opencode/plugin/gui"
import { InferenceBroker } from "./broker.ts"
import { defaultFeatures } from "./features.ts"
import type { InferenceTraceEvent } from "./inference-trace.ts"
import type { ChatRoute } from "./inference-route.ts"
import type { NativeConversationMessage } from "./rpc.ts"
import { DECISION_REPOSITORY, DECISION_REVISION, MODEL_FILES } from "./manifest.ts"
import { GENERATION_RESULT_CONTRACT_REVISION, LocalInference } from "./rpc.ts"

const solid: typeof import("solid-js") = await import(
  createRequire(import.meta.url).resolve("solid-js/dist/solid.js")
)
mock.module("solid-js", () => solid)

let allocations = 0
let serverContractRevision = "old-contract"
let failCompletion = false
let failNextAudioLoad = false
let heldAudioLoad: PromiseWithResolvers<void> | undefined
let loseLastDevice: (() => void) | undefined
let attachedOwner: string | undefined
let lastRunntimeMessages: readonly NativeConversationMessage[] | undefined
let lastLiquidMessages:
  readonly { role: string; content: string | readonly unknown[] }[] | undefined
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

mock.module("../../.cache/lfm3-engine.js", () => ({
  Lfm3OmniForConditionalGeneration: {
    from_pretrained: async () => ({
      dispose: allocate(),
      lost: new Promise(() => {}),
      deviceInfo: () => ({ description: "Liquid test GPU" }),
      create_session: () => ({
        dispose: async () => {},
        generate: (
          messages: readonly { role: string; content: string | readonly unknown[] }[],
          options: { generation_mode: string },
        ) => {
          lastLiquidMessages = messages
          return {
            async *[Symbol.asyncIterator]() {
              if (options.generation_mode === "text") {
                yield { type: "text", text: "Liquid " }
                yield { type: "text", text: "reply" }
              }
            },
            result: Promise.resolve(
              options.generation_mode === "audio"
                ? {
                    message: {
                      content: [{ type: "audio_out", audio: new Float32Array([0.25]) }],
                    },
                    usage: { prompt_tokens: 6, completion_tokens: 2 },
                    finish_reason: "stop",
                  }
                : {
                    message: { content: "Liquid reply" },
                    usage: { prompt_tokens: 6, completion_tokens: 2 },
                    finish_reason: "stop",
                  },
            ),
          }
        },
      }),
    }),
  },
}))

mock.module("./runntime-adapter.ts", () => ({
  loadRunntimeChat: async () => {
    const dispose = allocate()
    const lost = Promise.withResolvers<{ reason: string }>()
    loseLastDevice = () => lost.resolve({ reason: "simulated" })
    return {
      engine: {
        generate: (messages: readonly NativeConversationMessage[]) => {
          lastRunntimeMessages = messages
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
      },
      lost: lost.promise,
      dispose,
      loseDevice: () => lost.resolve({ reason: "simulated" }),
    }
  },
  loadRunntimeAudio: async () => {
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

mock.module("./decision-runtime.ts", () => ({
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
      usage: { input_tokens: 4, output_tokens: 0 },
    }),
  }),
}))

Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu: {} } })
const { createInferenceRuntime } = await import("./runtime.ts")
const broker = new InferenceBroker()
const controller = new AbortController()
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
let pollUnavailable = false
const worker = {
  contract: async () => ({ revision: serverContractRevision }),
  attach: async ({ owner, contractRevision }: { owner: string; contractRevision: string }) => {
    if (contractRevision !== GENERATION_RESULT_CONTRACT_REVISION)
      throw new Error("Incompatible renderer completion contract")
    broker.attach(owner)
    attachedOwner = owner
  },
  detach: async ({ owner, error }: { owner: string; error?: string }) => {
    broker.detach(owner, error)
    if (attachedOwner === owner) attachedOwner = undefined
  },
  poll: async ({ owner, available }: { owner: string; available: boolean }) => {
    if (pollUnavailable) throw new Error("Transport: Failed to fetch")
    return broker.poll(owner, available)
  },
  complete: async ({
    owner,
    id,
    result,
  }: Parameters<InferenceBroker["complete"]> extends [string, string, infer R]
    ? { owner: string; id: string; result: R }
    : never) => {
    if (failCompletion) {
      failCompletion = false
      throw new Error("completion schema mismatch")
    }
    broker.complete(owner, id, result)
  },
  delta: async ({ owner, id, text }: { owner: string; id: string; text: string }) =>
    broker.delta(owner, id, text),
  demand: async () => broker.demand(),
}
const ctx = {
  signal: controller.signal,
  main: () => files,
  client: { rpc: (definition: unknown) => (definition === LocalInference ? {} : worker) },
} as unknown as Parameters<Plugin.Setup>[0]
const [features] = solid.createSignal(defaultFeatures(true))
const [route, setRoute] = solid.createSignal<ChatRoute>("liquid")
let now = Date.now()
let timer: (() => void) | undefined
let stopRuntime: (() => void) | undefined
const runtime = solid.createRoot((dispose) => {
  stopRuntime = dispose
  return createInferenceRuntime(ctx, undefined, undefined, features, {
    wallNow: () => now,
    schedule: (callback, delayMs) => {
      assert.equal(delayMs, 500)
      timer = callback
      return () => {
        timer = undefined
      }
    },
    serviceTimeoutMs: 2_000,
    chatRoute: route,
  })
})

let displayedBackend: string | undefined
let displayedName: string | undefined
let recoveryEnabled = false
let stopDisplay: (() => void) | undefined
solid.createRoot((dispose) => {
  stopDisplay = dispose
  solid.createEffect(() => {
    displayedBackend = runtime.modelIdentity()?.backend
    displayedName = runtime.modelName()
    recoveryEnabled = runtime.canSimulateDeviceLoss()
  })
})

const until = async (condition: () => boolean, description: string) => {
  const deadline = Date.now() + 5_000
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(
        `Timed out waiting for ${description}: ${runtime.state()} · ${runtime.detail()}`,
      )
    await Bun.sleep(5)
  }
}
const tick = async () => {
  assert.ok(timer, "The production runtime scheduler is installed")
  timer()
  await Bun.sleep(0)
}
const tickUntil = async (condition: () => boolean, description: string) => {
  const deadline = Date.now() + 5_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`)
    await tick()
    await Bun.sleep(5)
  }
}
const submit = async (input: {
  prompt: string
  mode?: "speak" | "systemone"
  audioBase64?: string
  requestID?: string
  feature?: "questions" | "decisions" | "readAloud" | "dictation"
  messages?: readonly NativeConversationMessage[]
  route?: ChatRoute
  streaming?: boolean
  onText?: (text: string) => void
}) => {
  const pending = broker.generate(
    {
      ...input,
      maxTokens: input.mode === "systemone" ? 1 : 32,
      timeoutMs: 4_000,
      messages: input.messages ? [...input.messages] : undefined,
      route: input.route,
      streaming: input.streaming,
    },
    controller.signal,
    input.onText,
  )
  await tick()
  return pending
}

try {
  await until(() => runtime.state() === "error", "initial incompatible service contract")
  assert.equal(runtime.contractStatus(), "incompatible")
  assert.match(runtime.detail(), /Reload the OpenCode service and reopen Desktop/)
  assert.equal(acquisitions, 0, "Contract validation precedes cache ownership")
  assert.equal(allocations, 0, "An incompatible pairing must not allocate a model")
  assert.equal(runtime.modelIdentity(), undefined)
  assert.equal(displayedBackend, undefined)
  assert.equal(displayedName, undefined)
  assert.equal(recoveryEnabled, false)

  serverContractRevision = GENERATION_RESULT_CONTRACT_REVISION
  now += 2_000
  const initialLoad = runtime.load()
  assert.equal(runtime.state(), "loading")
  assert.equal(runtime.modelIdentity(), undefined)
  assert.equal(recoveryEnabled, false)
  await initialLoad
  await until(() => runtime.state() === "ready", "first compatible Liquid load")
  assert.equal(runtime.contractStatus(), "compatible")
  assert.equal(runtime.modelIdentity()?.backend, "liquid")
  assert.equal(displayedBackend, "liquid")
  assert.equal(displayedName, "LFM3")
  assert.equal(recoveryEnabled, false, "Liquid's engine has no injected recovery hook")
  assert.match(runtime.modelIdentity()?.precision ?? "", /language Q4_K_M \+ projector Q8_0/)
  assert.match(runtime.modelIdentity()?.artifacts ?? "", /LFM3-Omni-2B-Q4_K_M\.gguf sha256:/)
  assert.match(runtime.modelIdentity()?.artifacts ?? "", /mmproj-LFM3-Omni-2B-Q8_0\.gguf sha256:/)

  const legacyText = await submit({ prompt: "liquid text" })
  assert.equal(legacyText.ok, true)
  assert.equal(legacyText.promptTokens, 6)
  assert.deepEqual(lastLiquidMessages, [{ role: "user", content: "liquid text" }])
  const liquidTextTrace = traces.find(
    (event) => event.mode === "text" && event.backend === "liquid",
  )!
  assert.match(liquidTextTrace.modelArtifacts ?? "", /LFM3-Omni-2B-Q4_K_M\.gguf sha256:/)
  assert.match(liquidTextTrace.modelArtifacts ?? "", /mmproj-LFM3-Omni-2B-Q8_0\.gguf sha256:/)
  assert.match(liquidTextTrace.modelPrecision ?? "", /language Q4_K_M \+ projector Q8_0/)

  const nativeDeltas: string[] = []
  const nativeMessages: NativeConversationMessage[] = [
    { role: "system", content: "System context" },
    { role: "user", content: "First question" },
    { role: "assistant", content: "Previous answer" },
    { role: "user", content: "Follow-up question" },
  ]
  const nativeReply = await submit({
    prompt: "Follow-up question",
    messages: nativeMessages,
    route: "runntime",
    streaming: true,
    onText: (text) => nativeDeltas.push(text),
  })
  assert.equal(nativeReply.text, "ruNNtime reply")
  assert.deepEqual(nativeDeltas, ["ruNNtime ", "reply"])
  assert.deepEqual(lastRunntimeMessages, nativeMessages)
  assert.equal(route(), "liquid", "Native model selection does not mutate the global route")
  const nativeTrace = traces.find((event) => event.backend === "runntime" && event.mode === "text")!
  assert.equal(nativeTrace.modelRepository, "LiquidAI/LFM3-Omni-2B-GGUF")
  assert.equal(nativeTrace.modelRevision, "3d29af2ad166f8299c2d820937e47dc0add20ffc")
  assert.equal(nativeTrace.modelPrecision, "language Q4_K_M")
  await tick()
  assert.equal(
    runtime.modelIdentity()?.backend,
    "runntime",
    "Polling must not allocate an idle fallback",
  )
  const selectedLiquid = await submit({ prompt: "Liquid remains selected", route: "liquid" })
  assert.equal(selectedLiquid.text, "Liquid reply")
  assert.equal(traces.filter((event) => event.mode === "text").at(-1)?.backend, "liquid")
  const liquidConversation = await submit({
    prompt: "Follow-up question",
    messages: nativeMessages,
    route: "liquid",
    streaming: true,
    onText: () => {},
  })
  assert.equal(liquidConversation.text, "Liquid reply")
  assert.deepEqual(lastLiquidMessages, nativeMessages)
  assert.equal(route(), "liquid", "Explicit native route does not mutate the global route")

  setRoute("runntime")
  assert.equal(runtime.state(), "loading")
  assert.equal(recoveryEnabled, false)
  await until(() => runtime.state() === "unloaded", "ruNNtime route switch releases weights")
  const runntimeText = await submit({ prompt: "ruNNtime text" })
  assert.equal(displayedBackend, "runntime")
  assert.equal(displayedName, "ruNNtime LFM3")
  assert.equal(recoveryEnabled, true)
  assert.equal(runtime.modelIdentity()?.precision, "language Q4_K_M")
  assert.match(runtime.modelIdentity()?.artifacts ?? "", /LFM3-Omni-2B-Q4_K_M\.gguf sha256:/)
  assert.doesNotMatch(runtime.modelIdentity()?.artifacts ?? "", /mmproj-/)
  assert.equal(runntimeText.text, "ruNNtime reply")
  assert.equal(runntimeText.promptTokens, 8)
  const runntimeTextTrace = traces.find(
    (event) => event.mode === "text" && event.backend === "runntime",
  )!
  assert.match(runntimeTextTrace.modelArtifacts ?? "", /tokenizer\.json revision:/)
  assert.doesNotMatch(runntimeTextTrace.modelArtifacts ?? "", /mmproj-/)
  assert.equal(runntimeTextTrace.modelPrecision, "language Q4_K_M")

  failNextAudioLoad = true
  const failedAudio = await submit({
    prompt: "failed audio load",
    mode: "speak",
    feature: "readAloud",
  })
  assert.equal(failedAudio.ok, false)
  assert.match(failedAudio.error, /simulated audio model load failure/)
  await until(() => runtime.state() === "error", "audio load failure")
  assert.equal(
    runtime.modelIdentity(),
    undefined,
    "A failed target must not retain stale model identity",
  )
  assert.equal(displayedBackend, undefined)
  assert.equal(displayedName, undefined)
  assert.equal(recoveryEnabled, false)

  const speech = await submit({ prompt: "ruNNtime audio", mode: "speak", feature: "readAloud" })
  assert.equal(speech.ok, true)
  assert.equal(speech.promptTokens, null)
  assert.equal(speech.completionTokens, null)
  assert.ok(speech.audioBase64)
  assert.equal(runtime.modelIdentity()?.backend, "runntime")
  assert.equal(displayedName, "ruNNtime Omni audio")
  assert.match(runtime.modelIdentity()?.precision ?? "", /language Q4_K_M \+ projector Q8_0/)
  assert.match(runtime.modelIdentity()?.artifacts ?? "", /LFM3-Omni-2B-Q4_K_M\.gguf sha256:/)
  assert.match(runtime.modelIdentity()?.artifacts ?? "", /mmproj-LFM3-Omni-2B-Q8_0\.gguf sha256:/)
  assert.match(runtime.modelIdentity()?.artifacts ?? "", /tokenizer\.json revision:/)
  const runntimeAudioTrace = traces.find(
    (event) => event.mode === "speak" && event.backend === "runntime",
  )!
  assert.match(runntimeAudioTrace.modelPrecision ?? "", /language Q4_K_M \+ projector Q8_0/)
  for (const file of MODEL_FILES)
    assert.ok(runntimeAudioTrace.modelArtifacts?.includes(`${file.name} sha256:${file.sha256}`))

  const recoveryGate = Promise.withResolvers<void>()
  heldAudioLoad = recoveryGate
  assert.ok(loseLastDevice)
  runtime.simulateDeviceLoss()
  await until(() => runtime.state() === "loading", "device loss starts recovery")
  assert.equal(runtime.state(), "loading")
  assert.equal(
    recoveryEnabled,
    false,
    "The recovery control disables as soon as device recovery starts",
  )
  await until(
    () => runtime.state() === "loading" && runtime.resident() === undefined,
    "device-loss recovery loading state",
  )
  assert.equal(runtime.modelIdentity(), undefined)
  assert.equal(displayedBackend, undefined)
  assert.equal(displayedName, undefined)
  assert.equal(
    recoveryEnabled,
    false,
    "The recovery control is disabled while no model is resident",
  )
  recoveryGate.resolve()
  await until(
    () => runtime.state() === "ready" && runtime.resident() === "audio",
    "recovered ruNNtime audio model",
  )
  assert.equal(displayedBackend, "runntime")
  assert.equal(displayedName, "ruNNtime Omni audio")
  assert.equal(recoveryEnabled, true)

  setRoute("liquid")
  assert.equal(runtime.state(), "loading")
  assert.equal(recoveryEnabled, false)
  await until(() => runtime.state() === "unloaded", "route switch back to Liquid releases weights")
  const liquidSpeech = await submit({ prompt: "Liquid audio", mode: "speak", feature: "readAloud" })
  assert.equal(displayedBackend, "liquid")
  assert.equal(displayedName, "LFM3")
  assert.equal(recoveryEnabled, false)
  assert.equal(liquidSpeech.ok, true)
  assert.equal(liquidSpeech.promptTokens, 6)
  const liquidAudioTrace = traces.find(
    (event) => event.mode === "speak" && event.backend === "liquid",
  )!
  assert.match(liquidAudioTrace.modelPrecision ?? "", /language Q4_K_M \+ projector Q8_0/)
  for (const file of MODEL_FILES)
    assert.ok(liquidAudioTrace.modelArtifacts?.includes(`${file.name} sha256:${file.sha256}`))

  const decision = await submit({
    prompt: JSON.stringify({ questions: { q: {} } }),
    mode: "systemone",
    feature: "decisions",
  })
  assert.equal(decision.ok, true)
  assert.equal(runtime.modelIdentity()?.backend, "d1")
  assert.equal(runtime.modelIdentity()?.repository, DECISION_REPOSITORY)
  assert.equal(runtime.modelIdentity()?.revision, DECISION_REVISION)
  assert.match(runtime.modelIdentity()?.precision ?? "", /Q4f16/)
  assert.equal(displayedBackend, "d1")
  assert.equal(displayedName, "d1")
  assert.equal(recoveryEnabled, true)
  const decisionTrace = traces.find((event) => event.mode === "systemone")!
  assert.equal(decisionTrace.backend, "d1")
  assert.equal(decisionTrace.modelRepository, DECISION_REPOSITORY)
  assert.equal(decisionTrace.modelRevision, DECISION_REVISION)
  assert.match(decisionTrace.modelArtifacts ?? "", /decoder_q4f16\.onnx sha256:/)
  assert.doesNotMatch(decisionTrace.modelArtifacts ?? "", /LFM3-Omni/)

  now += 60_001
  pollUnavailable = true
  await tickUntil(() => runtime.state() === "error", "disconnected idle eviction")
  assert.equal(runtime.modelIdentity(), undefined, "Transport failure must not keep idle weights")
  pollUnavailable = false
  await tickUntil(() => runtime.state() === "unloaded", "default idle eviction")
  const allocationsAfterEviction = allocations
  await tick()
  assert.equal(runtime.modelIdentity(), undefined)
  assert.equal(allocations, allocationsAfterEviction, "An idle tick must not reload weights")

  failCompletion = true
  const undelivered = await submit({ prompt: "delivery failure" })
  assert.equal(undelivered.ok, false)
  assert.match(undelivered.error, /completion delivery failed.*completion schema mismatch/i)
  await until(
    () => runtime.contractStatus() === "unverified" && runtime.resident() === undefined,
    "completion delivery failure cleanup",
  )
  assert.equal(runtime.state(), "error")
  assert.equal(runtime.modelIdentity(), undefined)
  assert.equal(displayedBackend, undefined)
  assert.equal(displayedName, undefined)
  assert.equal(recoveryEnabled, false)
  assert.match(runtime.detail(), /not ready for qualification/)
  await runtime.unload()

  serverContractRevision = GENERATION_RESULT_CONTRACT_REVISION
  now += 2_000
  await runtime.load()
  await until(
    () => runtime.state() === "ready",
    "revalidation before cancellation transport failure",
  )
  const cancellation = new AbortController()
  const cancelled = broker.generate(
    { prompt: "cancelled before renderer handles it", maxTokens: 8, timeoutMs: 4_000 },
    cancellation.signal,
  )
  assert.ok(attachedOwner)
  const cancelledJob = broker.poll(attachedOwner).job!
  cancellation.abort()
  assert.match((await cancelled).error, /cancelled/i)
  failCompletion = true
  await tick()
  await until(
    () => runtime.contractStatus() === "unverified" && runtime.resident() === undefined,
    "cancelled completion delivery failure cleanup",
  )
  assert.equal(runtime.state(), "error")
  assert.equal(runtime.modelIdentity(), undefined)
  assert.equal(recoveryEnabled, false)
  assert.equal(cancelledJob.prompt, "cancelled before renderer handles it")

  serverContractRevision = "old-contract"
  now += 2_000
  await runtime.load()
  assert.equal(runtime.state(), "error")
  assert.equal(runtime.contractStatus(), "incompatible")
  assert.equal(runtime.modelIdentity(), undefined)
  assert.equal(displayedName, undefined)
  assert.match(runtime.detail(), /Service reports old-contract/)
  assert.equal(allocations, 0)

  serverContractRevision = GENERATION_RESULT_CONTRACT_REVISION
  now += 2_000
  await runtime.load()
  await until(() => runtime.state() === "ready", "explicit revalidation after contract mismatch")
  const unload = runtime.unload()
  assert.equal(runtime.state(), "loading")
  assert.equal(recoveryEnabled, false)
  await unload
  assert.equal(runtime.state(), "unloaded")
  assert.equal(runtime.modelIdentity(), undefined)
  assert.equal(displayedBackend, undefined)
  assert.equal(recoveryEnabled, false)
  assert.equal(allocations, 0)
  console.log("Candidate completion, identity, and reactive recovery checks passed")
} finally {
  controller.abort()
  await runtime.dispose()
  stopDisplay?.()
  stopRuntime?.()
  broker.close()
}
