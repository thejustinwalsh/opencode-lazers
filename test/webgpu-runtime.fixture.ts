// Isolated process: module mocks must never replace real inference adapters in other tests.
import { mock } from "bun:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { InferenceBroker } from "../src/webgpu/broker.ts"
import { ModelLease } from "../src/webgpu/lease.ts"
import { defaultFeatures } from "../src/webgpu/features.ts"
import type { Plugin } from "@opencode/plugin/gui"
import type { InferenceTraceEvent } from "../src/webgpu/inference-trace.ts"
import { LocalInference } from "../src/webgpu/rpc.ts"

const solid: typeof import("solid-js") = await import(
  createRequire(import.meta.url).resolve("solid-js/dist/solid.js")
)
mock.module("solid-js", () => solid)
const traces: InferenceTraceEvent[] = []
let failTracing = false
let holdTerminalTrace = false
const terminalTraceGate = Promise.withResolvers<void>()
let generationGate: Promise<void> | undefined
let generationStarted = Promise.withResolvers<void>()
let fakeNow = 1_000
let rendererTimer: (() => void) | undefined
let automaticTicks = false
let wallNow = Date.now()
let pollFailure: unknown
let attachFailures = 0
let attachCalls = 0
let detachCalls = 0
let detachFailure: Error | undefined
let hangDetach = false
let allocations = 0
let maximum = 0
let releases = 0
let releaseCalls = 0
let cleanupAttempts = 0
let failCleanup = false
let cleanupGate: Promise<void> | undefined
let failDecisionEnsure = false
let failDecisionLoad = false
let chatLoadGate: Promise<void> | undefined
let decisionLoadGate: Promise<void> | undefined
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
    from_pretrained: async () => {
      await chatLoadGate
      return {
        dispose: allocate(),
        lost: new Promise(() => {}),
        deviceInfo: () => ({ description: "Test GPU" }),
        create_session: () => ({
          dispose: async () => {},
          generate: () => {
            assert.equal(
              traces.at(-1)?.stage,
              "generate",
              "The stage must reach the independent log sink before model work",
            )
            const gate = generationGate
            generationStarted.resolve()
            return {
              async *[Symbol.asyncIterator]() {
                await gate
                yield { type: "text", text: "" }
              },
              result: (async () => {
                await gate
                return {
                  message: { content: "ready" },
                  usage: { prompt_tokens: 1, completion_tokens: 1 },
                  finish_reason: "stop",
                }
              })(),
            }
          },
        }),
      }
    },
  },
}))
mock.module("../src/webgpu/decision-runtime.ts", () => ({
  loadDecisionRuntime: async (
    _read: unknown,
    _signal: unknown,
    _progress: unknown,
    lost: () => void,
  ) => {
    await decisionLoadGate
    if (failDecisionLoad) throw Error("simulated decision model load failure")
    return {
      dispose: allocate(),
      loseDevice: lost,
      systemOne: async () => ({
        model: "d1-omni-2b",
        answers: { q: { type: "noul", noul: 0.9 } },
        usage: { input_tokens: 1, output_tokens: 0 },
      }),
    }
  },
}))
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu: {} } })
const { createInferenceRuntime } = await import("../src/webgpu/runtime.ts")
const broker = new InferenceBroker()
const lease = new ModelLease(async () => {})
const controller = new AbortController()
const worker = {
  attach: async ({ owner }: { owner: string }) => {
    attachCalls++
    if (attachFailures-- > 0) throw { type: "rpc.unavailable", message: "Service is reconnecting" }
    broker.attach(owner)
  },
  detach: async (
    { owner, error }: { owner: string; error?: string },
    options?: { signal?: AbortSignal },
  ) => {
    detachCalls++
    if (detachFailure) throw detachFailure
    if (hangDetach) {
      const signal = options?.signal
      if (!signal) throw new Error("A bounded detach signal is required")
      if (signal.aborted) throw signal.reason
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    }
    broker.detach(owner, error)
  },
  poll: async ({ owner, available }: { owner: string; available: boolean }) => {
    if (pollFailure) throw pollFailure
    return broker.poll(owner, available)
  },
  complete: async ({
    owner,
    id,
    result,
  }: Parameters<InferenceBroker["complete"]> extends [string, string, infer R]
    ? { owner: string; id: string; result: R }
    : never) => broker.complete(owner, id, result),
  demand: async () => broker.demand(),
}
const memoryStores = new Map<string, object>()
const storage = {
  memory: <T extends object>(
    key: string,
    options: { initial: T },
  ): [T, (update: (draft: T) => void) => void] => {
    if (!memoryStores.has(key)) memoryStores.set(key, options.initial)
    const value = memoryStores.get(key) as T
    return [value, (update) => update(value)]
  },
}
const files = {
  trace: async (event: InferenceTraceEvent) => {
    traces.push(event)
    if (holdTerminalTrace && event.stage === "complete") await terminalTraceGate.promise
    if (failTracing) throw Error("Diagnostic sink unavailable")
  },
  identity: async () => ({ providerEpoch: lease.providerEpoch, windowID: 1 }),
  registerGeneration: async ({
    generationID,
    generationSequence,
  }: {
    generationID: string
    generationSequence: number
  }) => lease.registerGeneration(1, generationID, generationSequence),
  acquire: async (request: Parameters<ModelLease["acquire"]>[1]) => lease.acquire(1, request),
  reconcileAcquire: async (identity: {
    generationID: string
    operationID: string
    providerEpoch: string
  }) => ({
    lease: (await lease.reconcileAcquire(1, identity)) ?? null,
  }),
  release: async (request: {
    lease: import("../src/webgpu/ipc.ts").ModelLeaseIdentity
    retirementID: string
    rendererDisposalID: string
  }) => {
    releaseCalls++
    return lease.release(1, request)
  },
  reconcileRelease: async (request: {
    lease: import("../src/webgpu/ipc.ts").ModelLeaseIdentity
    retirementID: string
    rendererDisposalID: string
  }) => ({ retirement: (await lease.reconcileRelease(1, request)) ?? null }),
  cancel: async (identity: import("../src/webgpu/ipc.ts").ModelLeaseIdentity) =>
    lease.assert(1, identity),
  ensure: async () => {},
  decisionEnsure: async () => {
    if (failDecisionEnsure) throw Error("simulated decision cache failure")
  },
  status: async () => ({ phase: "cached" }),
  decisionStatus: async () => ({ phase: "cached" }),
}
const ctx = {
  signal: controller.signal,
  storage,
  main: () => files,
  client: { rpc: (definition: unknown) => (definition === LocalInference ? {} : worker) },
} as unknown as Parameters<Plugin.Setup>[0]
const [features, setFeatures] = solid.createSignal(defaultFeatures(true))
const initialChatLoad = Promise.withResolvers<void>()
chatLoadGate = initialChatLoad.promise
const timing = {
  now: () => fakeNow,
  wallNow: () => wallNow,
  schedule: (callback: () => void, delayMs: number) => {
    assert.equal(delayMs, 500)
    rendererTimer = callback
    const timer = setInterval(() => {
      if (automaticTicks) callback()
    }, delayMs)
    return () => {
      clearInterval(timer)
      rendererTimer = undefined
    }
  },
  serviceTimeoutMs: 25,
}
let releaseRoot!: () => void
const runtime = solid.createRoot((dispose) => {
  releaseRoot = dispose
  return createInferenceRuntime(ctx, () => -1, undefined, features, timing)
})
const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 4_000
  while (!condition()) {
    if (Date.now() > deadline) throw Error(`Timed out: ${runtime.state()} ${runtime.detail()}`)
    await Bun.sleep(10)
  }
}
try {
  await until(() => runtime.modelName() === "LFM3" && runtime.phase() === "loading")
  assert.equal(runtime.resident(), undefined, "A cold chat load is named from its selected target")
  initialChatLoad.resolve()
  chatLoadGate = undefined
  await until(() => runtime.state() === "ready")
  assert.equal(runtime.modelName(), "LFM3")
  assert.equal(runtime.resident(), "chat")
  const timerTick = () => {
    assert.ok(rendererTimer, "The production renderer timer callback is installed")
    rendererTimer()
  }
  const runtimeID = traces.find((event) => event.stage === "session-ready")?.requestID
  assert.ok(runtimeID?.startsWith("renderer:"))

  fakeNow = 5_000
  timerTick()
  await until(() =>
    traces.some(
      (event) => event.requestID === runtimeID && event.stage === "renderer-lag" && !event.active,
    ),
  )
  const idleBeforeRequest = traces.find(
    (event) => event.requestID === runtimeID && event.stage === "renderer-lag",
  )!
  assert.deepEqual(
    {
      elapsedMs: idleBeforeRequest.elapsedMs,
      deltaMs: idleBeforeRequest.deltaMs,
      rendererLagMs: idleBeforeRequest.rendererLagMs,
      configuredEP: idleBeforeRequest.configuredEP,
      observedEP: idleBeforeRequest.observedEP,
      active: idleBeforeRequest.active,
    },
    {
      elapsedMs: 4_000,
      deltaMs: 4_000,
      rendererLagMs: 3_500,
      configuredEP: "unknown",
      observedEP: "unknown",
      active: false,
    },
  )
  await Bun.sleep(10)

  const generationGateController = Promise.withResolvers<void>()
  generationGate = generationGateController.promise
  holdTerminalTrace = true
  const firstStarted = generationStarted.promise
  const firstRequestPromise = broker.generate(
    { prompt: "hello", maxTokens: 16, timeoutMs: 3_000 },
    controller.signal,
  )
  fakeNow = 10_000
  timerTick()
  await firstStarted
  await until(() =>
    traces.some((event) => event.requestID !== runtimeID && event.stage === "generate"),
  )
  assert.equal(runtime.modelName(), "LFM3", "A busy resident keeps its short name")
  assert.equal(runtime.phase(), "busy")
  const firstRequestID = traces.find(
    (event) => event.requestID !== runtimeID && event.stage === "generate",
  )!.requestID
  const firstGenerate = traces.find(
    (event) => event.requestID === firstRequestID && event.stage === "generate",
  )!
  assert.deepEqual(
    { elapsedMs: firstGenerate.elapsedMs, deltaMs: firstGenerate.deltaMs },
    { elapsedMs: 0, deltaMs: 0 },
    "A request started well after renderer startup must begin its own clock",
  )

  fakeNow = 20_000
  timerTick()
  await until(() =>
    traces.some((event) => event.requestID === firstRequestID && event.stage === "renderer-lag"),
  )
  const activeLagIndex = traces.findIndex(
    (event) => event.requestID === firstRequestID && event.stage === "renderer-lag",
  )
  const activeLag = traces[activeLagIndex]!
  assert.deepEqual(
    {
      elapsedMs: activeLag.elapsedMs,
      deltaMs: activeLag.deltaMs,
      rendererLagMs: activeLag.rendererLagMs,
      active: activeLag.active,
      jobID: activeLag.jobID,
      configuredEP: activeLag.configuredEP,
      observedEP: activeLag.observedEP,
    },
    {
      elapsedMs: 10_000,
      deltaMs: 10_000,
      rendererLagMs: 9_500,
      active: true,
      jobID: firstRequestID,
      configuredEP: "webgpu",
      observedEP: "unknown",
    },
  )
  generationGateController.resolve()
  fakeNow = 20_025
  await until(() =>
    traces.some((event) => event.requestID === firstRequestID && event.stage === "complete"),
  )

  // The terminal record is already emitted, but its sink is blocked. This lag must go to runtime.
  fakeNow = 30_000
  timerTick()
  terminalTraceGate.resolve()
  holdTerminalTrace = false
  const answer = await firstRequestPromise
  assert.equal(answer.text, "ready")
  assert.ok(
    traces.some(
      (event) =>
        event.stage === "complete" &&
        event.requestID === firstRequestID &&
        event.actualInputTokens === 1 &&
        event.outputGeneratedTokens === 1,
    ),
  )
  await until(() =>
    traces.some(
      (event) =>
        event.requestID === runtimeID &&
        event.stage === "renderer-lag" &&
        event.elapsedMs === 29_000,
    ),
  )
  const postTerminalLag = traces.find(
    (event) =>
      event.requestID === runtimeID && event.stage === "renderer-lag" && event.elapsedMs === 29_000,
  )!
  assert.deepEqual(
    {
      elapsedMs: postTerminalLag.elapsedMs,
      deltaMs: postTerminalLag.deltaMs,
      rendererLagMs: postTerminalLag.rendererLagMs,
      active: postTerminalLag.active,
      jobID: postTerminalLag.jobID,
    },
    { elapsedMs: 29_000, deltaMs: 20_000, rendererLagMs: 9_500, active: false, jobID: undefined },
  )
  assert.equal(traces[activeLagIndex + 1]?.stage, "dispose")
  assert.equal(traces[activeLagIndex - 1]?.stage, "generate")
  assert.deepEqual(
    {
      elapsedMs: traces[activeLagIndex + 1]?.elapsedMs,
      deltaMs: traces[activeLagIndex + 1]?.deltaMs,
    },
    { elapsedMs: 10_025, deltaMs: 25 },
    "The next request event's delta starts after the emitted lag record",
  )
  assert.deepEqual(
    traces.filter((event) => event.requestID === firstRequestID).map((event) => event.stage),
    [
      "queued",
      "polled",
      "loading",
      "session-create",
      "session-ready",
      "generate",
      "renderer-lag",
      "dispose",
      "complete",
    ],
  )

  await Bun.sleep(10)
  fakeNow = 35_000
  timerTick()
  await until(() =>
    traces.some(
      (event) =>
        event.requestID === runtimeID &&
        event.stage === "renderer-lag" &&
        event.elapsedMs === 34_000,
    ),
  )
  const betweenRequestsLag = traces.find(
    (event) =>
      event.requestID === runtimeID && event.stage === "renderer-lag" && event.elapsedMs === 34_000,
  )!
  assert.deepEqual(
    {
      elapsedMs: betweenRequestsLag.elapsedMs,
      deltaMs: betweenRequestsLag.deltaMs,
      rendererLagMs: betweenRequestsLag.rendererLagMs,
      active: betweenRequestsLag.active,
      jobID: betweenRequestsLag.jobID,
    },
    { elapsedMs: 34_000, deltaMs: 5_000, rendererLagMs: 4_500, active: false, jobID: undefined },
  )
  await Bun.sleep(10)
  generationStarted = Promise.withResolvers<void>()
  const secondStarted = generationStarted.promise
  const secondRequestPromise = broker.generate(
    { prompt: "second private request", maxTokens: 16, timeoutMs: 3_000 },
    controller.signal,
  )
  fakeNow = 40_000
  timerTick()
  await secondStarted
  const secondResult = await secondRequestPromise
  assert.equal(secondResult.text, "ready")
  const secondRequestID = traces.find(
    (event) =>
      event.stage === "generate" &&
      event.requestID !== runtimeID &&
      event.requestID !== firstRequestID,
  )!.requestID
  const secondQueued = traces.find(
    (event) => event.requestID === secondRequestID && event.stage === "queued",
  )!
  const secondGenerated = traces.find(
    (event) => event.requestID === secondRequestID && event.stage === "generate",
  )!
  assert.deepEqual(
    { elapsedMs: secondQueued.elapsedMs, deltaMs: secondQueued.deltaMs, jobID: secondQueued.jobID },
    { elapsedMs: 0, deltaMs: 0, jobID: secondRequestID },
  )
  assert.equal(secondGenerated.jobID, secondRequestID)
  automaticTicks = true
  const traceJSON = JSON.stringify(traces)
  for (const privateValue of ["hello", "private", "second private request"])
    assert.ok(!traceJSON.includes(privateValue), `Trace must not retain ${privateValue}`)
  assert.ok(
    traces.every((event) => ["prompt", "text", "audioBase64"].every((field) => !(field in event))),
    "Trace schema must not carry prompt, output or audio content",
  )
  assert.ok(traces.every((event) => event.observedEP === "unknown"))
  automaticTicks = false
  pollFailure = { type: "rpc.unavailable", message: "Renderer mailbox unavailable" }
  timerTick()
  await until(() => runtime.state() === "error")
  assert.match(runtime.detail(), /rpc\.unavailable: Renderer mailbox unavailable/)
  assert.equal(lease.occupied(), false)
  assert.equal(broker.demand().requested, false, "Recovery must not need another user request")
  pollFailure = undefined
  const beforeReconnect = attachCalls
  attachFailures = 1
  timerTick()
  await Bun.sleep(20)
  assert.equal(attachCalls, beforeReconnect, "Reconnection waits for its backoff")
  wallNow += 1_000
  timerTick()
  await until(() => attachCalls === beforeReconnect + 1 && runtime.state() === "error")
  assert.match(runtime.detail(), /Service is reconnecting/)
  timerTick()
  await Bun.sleep(20)
  assert.equal(attachCalls, beforeReconnect + 1, "A failed reattach does not spin")
  wallNow += 2_000
  timerTick()
  await until(() => runtime.state() === "ready")
  assert.equal(attachCalls, beforeReconnect + 2)
  assert.equal(allocations, 1)
  assert.equal(broker.demand().requested, false)
  pollFailure = new Error("Temporary transport loss before disable")
  timerTick()
  await until(() => runtime.state() === "error")
  pollFailure = undefined
  setFeatures(defaultFeatures(false))
  await until(() => runtime.state() === "disabled")
  wallNow += 30_000
  timerTick()
  await Bun.sleep(20)
  assert.equal(allocations, 0, "Disabling inference cancels a scheduled reconnect")
  setFeatures(defaultFeatures(true))
  await until(() => runtime.state() === "ready")
  automaticTicks = true
  failTracing = true
  const withoutLogs = await broker.generate(
    { prompt: "private", maxTokens: 16, timeoutMs: 3_000 },
    controller.signal,
  )
  assert.equal(withoutLogs.ok, true, "A failed diagnostic sink cannot fail model inference")
  failTracing = false
  const decision = () => {
    const result = broker.generate(
      { prompt: "{}", mode: "systemone", maxTokens: 1, timeoutMs: 3_000 },
      controller.signal,
    )
    timerTick()
    return result
  }
  const chat = () => {
    const result = broker.generate(
      { prompt: "switch back to chat", maxTokens: 16, timeoutMs: 3_000 },
      controller.signal,
    )
    timerTick()
    return result
  }

  failDecisionEnsure = true
  assert.equal((await decision()).ok, false, "Cache failure occurs before old-model disposal")
  failDecisionEnsure = false
  assert.equal(runtime.modelName(), "LFM3", "The resident model wins over a failed target")
  assert.equal(runtime.resident(), "chat")
  assert.equal(runtime.state(), "error")

  failCleanup = true
  assert.equal((await decision()).ok, false, "Failed disposal retains the old allocation")
  failCleanup = false
  assert.equal(runtime.modelName(), "LFM3", "A tainted resident wins over the requested d1 target")
  assert.equal(runtime.resident(), "chat")
  assert.equal(runtime.state(), "error")

  const decisionLoad = Promise.withResolvers<void>()
  decisionLoadGate = decisionLoad.promise
  const oldDisposal = Promise.withResolvers<void>()
  cleanupGate = oldDisposal.promise
  const toDecision = decision()
  await until(() => runtime.modelName() === "LFM3" && runtime.phase() === "loading")
  assert.equal(runtime.resident(), "chat", "A resident remains authoritative during its disposal")
  oldDisposal.resolve()
  cleanupGate = undefined
  await until(() => runtime.modelName() === "d1" && runtime.resident() === undefined)
  assert.equal(runtime.phase(), "loading")
  assert.equal(runtime.state(), "loading", "After disposal the selected target is named")
  decisionLoad.resolve()
  decisionLoadGate = undefined
  assert.equal((await toDecision).ok, true)
  assert.equal(runtime.modelName(), "d1")
  assert.equal(runtime.resident(), "decision")

  const chatLoad = Promise.withResolvers<void>()
  chatLoadGate = chatLoad.promise
  const toChat = chat()
  await until(
    () =>
      runtime.modelName() === "LFM3" &&
      runtime.resident() === undefined &&
      runtime.phase() === "loading",
  )
  chatLoad.resolve()
  chatLoadGate = undefined
  assert.equal((await toChat).ok, true)
  assert.equal(runtime.modelName(), "LFM3", "Switching back restores the chat identity")

  failDecisionLoad = true
  assert.equal((await decision()).ok, false, "Load failure occurs after disposing the old model")
  failDecisionLoad = false
  assert.equal(runtime.resident(), undefined)
  assert.equal(runtime.modelName(), "d1", "The failed target is named without claiming residency")
  assert.equal(runtime.state(), "error")
  await Bun.sleep(600)
  assert.equal(
    runtime.resident(),
    undefined,
    "A failed switch is not retargeted from feature settings",
  )
  assert.equal(runtime.modelName(), "d1")
  assert.equal((await decision()).ok, true)
  assert.equal(runtime.modelName(), "d1")

  for (let loss = 0; loss < 3; loss++) {
    const before = releases
    const recoveryLoad = loss === 0 ? Promise.withResolvers<void>() : undefined
    if (recoveryLoad) decisionLoadGate = recoveryLoad.promise
    runtime.simulateDeviceLoss()
    if (recoveryLoad) {
      await until(
        () =>
          runtime.modelName() === "d1" &&
          runtime.resident() === undefined &&
          runtime.phase() === "loading",
      )
      recoveryLoad.resolve()
      decisionLoadGate = undefined
    }
    await until(
      () => releases > before && (runtime.state() === "ready" || runtime.state() === "error"),
    )
    assert.equal(runtime.modelName(), "d1", "Device loss recovery retains the known identity")
  }
  assert.equal(runtime.state(), "error")
  assert.equal(runtime.resident(), undefined, "Circuit breaker does not leave a model resident")
  assert.equal(runtime.modelName(), "d1", "The failed recovery target remains explicitly named")
  assert.match(runtime.detail(), /cooling down/)
  const afterCircuit = releases
  await Bun.sleep(700)
  assert.equal(
    allocations,
    0,
    "The ordinary poll loop must not bypass the recovery circuit breaker",
  )
  assert.equal(releases, afterCircuit)
  wallNow += 60_000
  timerTick()
  await until(() => runtime.state() === "ready")
  assert.equal(allocations, 1, "Repeated loss retries after cooling down without new demand")
  assert.equal(broker.demand().requested, false)
  assert.equal(runtime.modelName(), "d1")
  assert.equal((await decision()).ok, true, "The recovered model must serve a fresh request")
  for (let loss = 0; loss < 3 && runtime.state() !== "error"; loss++) {
    const before = releases
    runtime.simulateDeviceLoss()
    await until(
      () => releases > before && (runtime.state() === "ready" || runtime.state() === "error"),
    )
  }
  assert.equal(runtime.state(), "error")
  assert.equal((await decision()).ok, true, "An explicit new request may recover before cooldown")

  const gate = Promise.withResolvers<void>()
  cleanupGate = gate.promise
  const first = runtime.unload()
  const second = runtime.unload()
  assert.equal(first, second, "Concurrent unload callers must await the same disposal")
  await Bun.sleep(10)
  assert.equal(lease.occupied(), true)
  assert.equal(allocations, 1)
  assert.equal(runtime.modelName(), "d1", "An in-progress unload keeps the resident identity")
  await runtime.load()
  assert.equal(allocations, 1)
  gate.resolve()
  await Promise.all([first, second])
  cleanupGate = undefined
  assert.equal(lease.occupied(), false)
  assert.equal(allocations, 0)
  assert.equal(runtime.modelName(), undefined, "A successful unload has no inferred model identity")
  timerTick()
  await Bun.sleep(20)
  assert.equal(allocations, 0, "Manual unload does not rearm automatic loading")

  // Demand can reload after an unload; a disposal failure must retain the main lease.
  assert.equal((await decision()).ok, true)
  failCleanup = true
  await runtime.unload()
  assert.equal(runtime.state(), "error")
  assert.equal(runtime.modelName(), "d1", "A tainted resource keeps its retained identity")
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
  assert.equal(runtime.modelName(), undefined)
  setFeatures({ ...defaultFeatures(true), questions: false, dictation: false, readAloud: false })
  const coldDecisionLoad = runtime.load()
  assert.equal(runtime.modelName(), "d1", "A cold decision load is named from its selected target")
  await coldDecisionLoad
  assert.equal(runtime.modelName(), "d1")
  assert.equal(runtime.resident(), "decision")
  assert.equal((await decision()).ok, true)

  const releasesBeforeDetachFailure = releaseCalls
  const detachCallsBeforeFailure = detachCalls
  detachFailure = new Error("simulated live broker detach failure")
  await runtime.unload()
  assert.equal(runtime.state(), "error")
  assert.match(runtime.detail(), /detach.*cache ownership is retained/i)
  assert.equal(detachCalls, detachCallsBeforeFailure + 1)
  assert.equal(releaseCalls, releasesBeforeDetachFailure)
  assert.equal(lease.occupied(), true, "failed live detachment keeps the main-process lease")
  assert.equal(allocations, 0, "renderer disposal is observed before broker detachment")

  detachFailure = undefined
  hangDetach = true
  const detachCallsBeforeTimeout = detachCalls
  const timeoutStartedAt = Date.now()
  await runtime.unload()
  assert.equal(runtime.state(), "error")
  assert.match(runtime.detail(), /detach.*cache ownership is retained/i)
  assert.ok(Date.now() - timeoutStartedAt < 1_000, "live detach failure is bounded")
  assert.equal(detachCalls, detachCallsBeforeTimeout + 1)
  assert.equal(releaseCalls, releasesBeforeDetachFailure)
  assert.equal(lease.occupied(), true, "a timed-out detachment cannot release ownership")

  hangDetach = false
  await runtime.unload()
  assert.equal(lease.occupied(), false, "a later successful detachment can retire the lease")
  assert.equal(releaseCalls, releasesBeforeDetachFailure + 1)
  assert.equal((await decision()).ok, true, "the runtime can load again after safe detachment")

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
  assert.equal(
    lease.occupied(),
    true,
    "aborted renderer cleanup retains main ownership for handoff",
  )
  assert.equal(allocations, 0)
  const storedGenerations = (
    memoryStores.get("webgpu-model-lease") as {
      generations: Record<string, { state: string; disposalID?: string; grant?: unknown }>
    }
  ).generations
  const storedGeneration = Object.values(storedGenerations)[0]
  assert.equal(storedGeneration?.state, "disposed")
  assert.ok(storedGeneration?.disposalID, "renderer disposal is recorded only after model cleanup")
  console.log("Renderer lifecycle fault injection passed")
} finally {
  failCleanup = false
  cleanupGate = undefined
  controller.abort()
  await runtime.dispose()
  releaseRoot()
  broker.close()
}
