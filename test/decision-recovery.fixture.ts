// Isolated process: this fixture exercises the actual decision adapter/runtime
// while replacing only tokenizer, model assets, ORT, and the native GPU boundary.
import { mock } from "bun:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { InferenceBroker } from "../src/webgpu/broker.ts"
import { ModelLease } from "../src/webgpu/lease.ts"
import { LocalInference } from "../src/webgpu/rpc.ts"
import { isOrtWebGpuDeviceLoss } from "../src/webgpu/decision-loss.ts"
import type { SystemOneInput } from "../src/webgpu/system-one.ts"
import type { Plugin } from "@opencode/plugin/gui"

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
  MODEL_SHORT_NAMES: { chat: "LFM3", decision: "d1" },
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
  probabilities: () => [0.9, 0.1],
  readAnswer: (question: { type: string }) => ({ type: question.type, noul: 0.9 }),
  renderQuestion: () => "",
  SystemOneRequest: { parse: (input: unknown) => input },
}))

class TestTensor {
  constructor(
    readonly type: string,
    readonly data: BigInt64Array | Float32Array,
    readonly dims: number[],
  ) {}

  dispose() {}
}

type Logits = { logits: TestTensor }
type Device = {
  lost: Promise<{ reason: string; message: string }>
  resolveLost(value?: { reason: string; message: string }): void
  destroy(): void
  destroyed: boolean
}
const metrics = {
  deviceRequests: 0,
  activeDevices: 0,
  creates: 0,
  activeSessions: 0,
  releases: 0,
  destroys: 0,
  runs: 0,
  runSessionIDs: [] as number[],
  timeline: [] as string[],
}
const devices: Device[] = []
let runHandler = async (_sessionID: number): Promise<Logits> => ({
  logits: new TestTensor("float32", new Float32Array(128_000), [1, 128_000]),
})

mock.module("onnxruntime-web/webgpu", () => ({
  env: { wasm: {} },
  Tensor: TestTensor,
  InferenceSession: {
    create: async () => {
      assert.equal(metrics.activeDevices, 1, "ORT session must own one live adapter device")
      assert.equal(metrics.activeSessions, 0, "A replacement session must not overlap cleanup")
      const sessionID = metrics.creates++
      metrics.activeSessions++
      metrics.timeline.push(`session:${sessionID}`)
      return {
        run: async () => {
          metrics.runs++
          metrics.runSessionIDs.push(sessionID)
          return runHandler(sessionID)
        },
        release: async () => {
          metrics.releases++
          metrics.activeSessions--
          metrics.timeline.push(`release:${sessionID}`)
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
        metrics.deviceRequests++
        return {
          limits: { maxStorageBufferBindingSize: 1_073_741_824 },
          requestDevice: async () => {
            assert.equal(metrics.activeDevices, 0, "A new device must wait for old cleanup")
            metrics.activeDevices++
            let resolveLost!: (value: { reason: string; message: string }) => void
            const lost = new Promise<{ reason: string; message: string }>((resolve) => {
              resolveLost = resolve
            })
            const device: Device = {
              lost,
              resolveLost: (value = { reason: "unknown", message: "test device loss" }) =>
                resolveLost(value),
              destroyed: false,
              destroy: () => {
                if (device.destroyed) return
                device.destroyed = true
                metrics.activeDevices--
                metrics.destroys++
                metrics.timeline.push(`destroy:${devices.indexOf(device)}`)
              },
            }
            devices.push(device)
            return device
          },
        }
      },
    },
  },
})

const { loadDecisionRuntime } = await import("../src/webgpu/decision-runtime.ts")
const read = async (id: string, offset: number, length: number) =>
  Buffer.from(contents.get(id)!.slice(offset, offset + length)).toString("base64")
const signal = () => new AbortController().signal
const input: SystemOneInput = {
  model: "d1-omni-2b",
  state: {},
  questions: { q: { type: "noul", instructions: "Is the device usable?" } },
}
const ortLoss = () =>
  new Error("failed to call OrtRun(). ERROR_CODE: 6, ERROR_MESSAGE: WebGPU device lost.")
const callbackLoss = () =>
  new Error(
    "failed to call OrtRun(). ERROR_CODE: 6, ERROR_MESSAGE: WebGPU device lost (1): backend reported loss",
  )
const mapAsyncLoss = () =>
  new Error(
    "failed to call OrtRun(). ERROR_CODE: 1, ERROR_MESSAGE: /mnt/azure_nvme_temp/_work/1/s/onnxruntime/core/providers/webgpu/buffer_manager.cc:669 void onnxruntime::webgpu::BufferManager::Download(CommandRecordingState &, WGPUBuffer, void *, size_t) const map_async_result.status == wgpu::MapAsyncStatus::Success was false. Failed to download data from buffer. wgpu::MapAsyncStatus value: 4, message: Failed to execute 'mapAsync' on 'GPUBuffer': Device was lost before MapAsync completed.",
  )
const validLogits = (): Logits => ({
  logits: new TestTensor("float32", new Float32Array(128_000), [1, 128_000]),
})
const until = async (condition: () => boolean, message: string) => {
  const deadline = Date.now() + 8_000
  while (!condition()) {
    if (Date.now() > deadline) throw Error(`Timed out waiting for ${message}`)
    await Bun.sleep(5)
  }
}
const settleLost = async (device: Device) => {
  device.resolveLost()
  await device.lost
  await Promise.resolve()
}

mock.module("../.cache/lfm3-engine.js", () => ({ Lfm3OmniForConditionalGeneration: {} }))
const solid: typeof import("solid-js") = await import(
  createRequire(import.meta.url).resolve("solid-js/dist/solid.js")
)
mock.module("solid-js", () => solid)
const { createInferenceRuntime } = await import("../src/webgpu/runtime.ts")

assert.equal(isOrtWebGpuDeviceLoss(ortLoss()), true)
assert.equal(isOrtWebGpuDeviceLoss(callbackLoss()), true)
assert.equal(isOrtWebGpuDeviceLoss(mapAsyncLoss()), true)
for (const error of [
  new Error(
    mapAsyncLoss().message.replace(
      "Device was lost before MapAsync completed.",
      "Buffer was already mapped.",
    ),
  ),
  new Error(mapAsyncLoss().message.replace("providers/webgpu/", "providers/cpu/")),
  new Error(
    mapAsyncLoss().message.replace(
      /^failed to call OrtRun\(\)\. ERROR_CODE: 1, ERROR_MESSAGE: /,
      "",
    ),
  ),
  new Error(
    "failed to call OrtRun(). ERROR_CODE: 6, ERROR_MESSAGE: WebGPU device error(2): validation",
  ),
  new Error("failed to call OrtRun(). ERROR_CODE: 6, ERROR_MESSAGE: mapAsync failed"),
  new Error("failed to call OrtRun(). ERROR_CODE: 6, ERROR_MESSAGE: network fetch failed"),
  new Error("GPU device lost"),
  Object.assign(
    new Error("failed to call OrtRun(). ERROR_CODE: 6, ERROR_MESSAGE: WebGPU device lost."),
    {
      name: "OperationError",
    },
  ),
])
  assert.equal(isOrtWebGpuDeviceLoss(error), false)

// Rejection-before-callback: the pinned ORT signature retires the adapter and
// requests recovery once even while GPUDevice.lost remains unresolved.
runHandler = async () => {
  throw ortLoss()
}
let afterRejection = 0
const rejectedEngine = await loadDecisionRuntime(
  read,
  signal(),
  () => {},
  () => afterRejection++,
)
const rejectedDevice = devices.at(-1)!
await assert.rejects(rejectedEngine.systemOne(input, signal()), /WebGPU device lost/)
assert.equal(afterRejection, 1)
const rejectedRuns = metrics.runs
await assert.rejects(rejectedEngine.systemOne(input, signal()), /retired/)
assert.equal(metrics.runs, rejectedRuns, "A retired adapter must not execute later work")
await rejectedEngine.dispose()
await settleLost(rejectedDevice)
assert.equal(afterRejection, 1, "The later device callback must not duplicate recovery")

// Callback-before-rejection: a pending run stays in flight, then its failure
// settles without a second retirement notification.
const beforeGate = Promise.withResolvers<Logits>()
runHandler = () => beforeGate.promise
let beforeRejection = 0
const beforeEngine = await loadDecisionRuntime(
  read,
  signal(),
  () => {},
  () => beforeRejection++,
)
const beforeDevice = devices.at(-1)!
const beforeRun = beforeEngine.systemOne(input, signal())
await until(() => metrics.runs >= rejectedRuns + 1, "pending decision run")
await settleLost(beforeDevice)
assert.equal(beforeRejection, 1)
beforeGate.reject(new DOMException("Buffer mapAsync failed", "OperationError"))
await assert.rejects(beforeRun, /mapAsync failed/)
assert.equal(beforeRejection, 1)
await beforeEngine.dispose()

// A callback arriving only after disposal cannot request recovery.
runHandler = async () => validLogits()
let disposedCallback = 0
const disposedEngine = await loadDecisionRuntime(
  read,
  signal(),
  () => {},
  () => disposedCallback++,
)
const disposedDevice = devices.at(-1)!
await disposedEngine.dispose()
await settleLost(disposedDevice)
assert.equal(disposedCallback, 0)

// Generic failures from the ORT run and output validation do not retire the adapter.
const genericErrors = [
  new DOMException("buffer mapAsync rejected", "OperationError"),
  new Error("inference failed"),
  new Error("WebGPU validation error"),
  new Error("network fetch failed"),
]
runHandler = async () => {
  const error = genericErrors.shift()
  if (error) throw error
  return { logits: new TestTensor("float32", new Float32Array(128_000), [2, 128_000]) }
}
let genericRecovery = 0
const genericEngine = await loadDecisionRuntime(
  read,
  signal(),
  () => {},
  () => genericRecovery++,
)
for (const match of [
  "mapAsync rejected",
  "inference failed",
  "validation error",
  "network fetch failed",
])
  await assert.rejects(genericEngine.systemOne(input, signal()), new RegExp(match))
await assert.rejects(genericEngine.systemOne(input, signal()), /unexpected logits dimensions/)
assert.equal(genericRecovery, 0)
runHandler = async () => validLogits()
await genericEngine.systemOne(input, signal())
assert.equal(genericRecovery, 0, "Generic errors must leave the adapter available")
await genericEngine.dispose()

// Integration: one positively identified failed job is not replayed. Existing
// recovery cleans the old session/device and loads the replacement on demand.
const broker = new InferenceBroker()
const lease = new ModelLease(async () => {})
const hostController = new AbortController()
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
  trace: async () => {},
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
const ctx = {
  signal: hostController.signal,
  main: () => files,
  client: { rpc: (definition: unknown) => (definition === LocalInference ? {} : worker) },
} as unknown as Parameters<Plugin.Setup>[0]
const [features] = solid.createSignal({
  enabled: true,
  questions: false,
  decisions: true,
  review: false,
  dictation: false,
  readAloud: false,
})
let releaseRoot!: () => void
const runtimeSession = metrics.creates
const runtimeDeviceIndex = devices.length
const runtimeReleaseStart = metrics.releases
runHandler = async (sessionID) => {
  if (sessionID === runtimeSession) throw mapAsyncLoss()
  return validLogits()
}
const runtime = solid.createRoot((dispose) => {
  releaseRoot = dispose
  return createInferenceRuntime(ctx, () => -1, undefined, features)
})
const loadNextJob = () =>
  broker.generate(
    {
      prompt: JSON.stringify(input),
      mode: "systemone",
      maxTokens: 1,
      timeoutMs: 5_000,
    },
    new AbortController().signal,
  )
try {
  await until(() => runtime.state() === "ready", "initial decision model")
  const failedJob = await loadNextJob()
  assert.equal(failedJob.ok, false, "A positively identified loss must fail the delivered job")
  assert.equal(
    metrics.runSessionIDs.filter((sessionID) => sessionID === runtimeSession).length,
    1,
    "The failed inference must not be replayed",
  )
  await until(
    () =>
      runtime.state() === "unloaded" &&
      metrics.creates === runtimeSession + 1 &&
      metrics.releases === runtimeReleaseStart + 1,
    "released decision model after cleanup",
  )
  assert.equal(metrics.activeDevices, 0)
  assert.equal(metrics.activeSessions, 0)
  await settleLost(devices[runtimeDeviceIndex]!)
  assert.equal(runtime.state(), "unloaded")
  runHandler = async () => validLogits()
  const recoveredJob = await loadNextJob()
  assert.equal(recoveredJob.ok, true)
  const replacementID = runtimeSession + 1
  const replacementDevice = devices[runtimeDeviceIndex + 1]!
  assert.equal(metrics.activeDevices, 1)
  assert.equal(metrics.activeSessions, 1)
  const releaseAt = metrics.timeline.indexOf(`release:${runtimeSession}`)
  const destroyAt = metrics.timeline.indexOf(`destroy:${runtimeDeviceIndex}`)
  const replacementAt = metrics.timeline.indexOf(`session:${replacementID}`)
  assert.ok(releaseAt >= 0 && destroyAt >= 0 && replacementAt >= 0)
  assert.ok(releaseAt < destroyAt, "ORT session release must precede device destruction")
  assert.ok(destroyAt < replacementAt, "A replacement must wait until the old device is destroyed")

  await until(() => runtime.state() === "ready", "ready after the recovered decision")
  assert.equal(metrics.creates, runtimeSession + 2)
  assert.equal(metrics.runSessionIDs.at(-1), replacementID)
  assert.equal(replacementDevice.destroyed, false)

  // Cancellation and deadline fail the caller immediately, but do not release
  // or replace a device while native ORT work ignores abort. Settlement is
  // awaited, and its late logits cannot become success or trigger replay.
  const pendingCase = async (deadline: boolean) => {
    const sessionID = metrics.creates - 1
    const startRuns = metrics.runs
    const startReleases = metrics.releases
    const startDestroys = metrics.destroys
    const gate = Promise.withResolvers<Logits>()
    runHandler = (running) =>
      running === sessionID ? gate.promise : Promise.resolve(validLogits())
    const controller = new AbortController()
    const request = broker.generate(
      {
        prompt: JSON.stringify(input),
        mode: "systemone",
        maxTokens: 1,
        timeoutMs: deadline ? 1_000 : 5_000,
      },
      controller.signal,
    )
    await until(() => metrics.runs === startRuns + 1, "pending native inference")
    if (!deadline) controller.abort()
    const callerResult = await request
    assert.equal(callerResult.ok, false)
    assert.match(callerResult.error, deadline ? /deadline/i : /cancel/i)
    const unloading = runtime.unload()
    await Bun.sleep(30)
    assert.equal(metrics.releases, startReleases, "Pending ORT work retains the session")
    assert.equal(metrics.destroys, startDestroys, "Pending ORT work retains the device")
    assert.equal(metrics.creates, sessionID + 1, "No replacement can overlap pending work")
    assert.equal(metrics.activeDevices, 1)
    gate.resolve(validLogits())
    await unloading
    assert.equal(metrics.runs, startRuns + 1, "Cancelled/deadline work is never replayed")
    assert.equal(metrics.releases, startReleases + 1)
    assert.equal(metrics.destroys, startDestroys + 1)
    assert.equal(metrics.activeDevices, 0)
  }
  await pendingCase(false)
  await runtime.load()
  await until(() => runtime.state() === "ready", "explicit reload after cancellation")
  await pendingCase(true)
  assert.equal(lease.occupied(), false)
  console.log("decision loss retirement and pending recovery checks passed")
} finally {
  hostController.abort()
  await runtime.dispose()
  releaseRoot()
  broker.close()
}
