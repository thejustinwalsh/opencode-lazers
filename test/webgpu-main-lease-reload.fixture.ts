// Isolated process: exercise a real registered main/runtime reload without replacing shared modules.
import { mock } from "bun:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin/gui"
import { InferenceBroker } from "../src/webgpu/broker.ts"
import { defaultFeatures } from "../src/webgpu/features.ts"
import { ModelFiles } from "../src/webgpu/ipc.ts"
import type { ModelLeaseGrant } from "../src/webgpu/ipc.ts"
import { setupMain } from "../src/webgpu/main.ts"
import { LocalInference } from "../src/webgpu/rpc.ts"

const solid: typeof import("solid-js") = await import(
  createRequire(import.meta.url).resolve("solid-js/dist/solid.js")
)
mock.module("solid-js", () => solid)

let modelDisposals = 0
mock.module("../.cache/lfm3-engine.js", () => ({
  Lfm3OmniForConditionalGeneration: {
    from_pretrained: async () => ({
      dispose: async () => {
        modelDisposals++
      },
      lost: new Promise(() => {}),
      deviceInfo: () => ({ description: "Registered reload test GPU" }),
      create_session: () => ({ dispose: async () => {}, generate: async function* () {} }),
    }),
  },
}))
mock.module("../src/webgpu/decision-runtime.ts", () => ({
  loadDecisionRuntime: async () => ({ dispose: async () => {}, systemOne: async () => ({}) }),
}))
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu: {} } })

const { createInferenceRuntime } = await import("../src/webgpu/runtime.ts")

type Caller = { window: number; signal: AbortSignal }
type MainHandler = (input: unknown, caller: Caller) => unknown
type MainHost = {
  implementation: Record<string, MainHandler>
  cleanup: Array<() => void>
  stop?: () => void | Promise<void>
  window: FakeBrowserWindow
  otherWindow: FakeBrowserWindow
}

class FakeWebContents extends EventEmitter {
  constructor(private readonly pid: number) {
    super()
  }

  getOSProcessId() {
    return this.pid
  }
}

class FakeBrowserWindow extends EventEmitter {
  readonly webContents: FakeWebContents

  constructor(
    readonly id: number,
    pid: number,
  ) {
    super()
    this.webContents = new FakeWebContents(pid)
  }
}

const makeMain = (): MainHost => {
  const window = new FakeBrowserWindow(17, 4_217)
  const otherWindow = new FakeBrowserWindow(18, 4_218)
  const persistent = new Map<string, unknown>()
  const cleanup: Array<() => void> = []
  const listeners = new Map<string, (...args: never[]) => void>()
  let implementation: Record<string, MainHandler> = {}
  const ctx = {
    options: { dataDirectory: join(tmpdir(), `lazers-window-reload-${crypto.randomUUID()}`) },
    signal: new AbortController().signal,
    storage: {
      store: (key: string, options: { initial: unknown }) => {
        if (!persistent.has(key)) persistent.set(key, options.initial)
        return {
          get value() {
            return persistent.get(key)
          },
          set: (value: unknown) => persistent.set(key, value),
        }
      },
    },
    log: { write: () => {} },
    windows: {
      get: (id: number) =>
        id === window.id ? window : id === otherWindow.id ? otherWindow : undefined,
      list: () => [window, otherWindow],
      focused: () => window,
      on: (event: string, handler: (...args: never[]) => void) => {
        listeners.set(event, handler)
        return () => listeners.delete(event)
      },
    },
    onCleanup: (fn: () => void) => cleanup.push(fn),
    provide: (token: unknown, value: unknown) => {
      assert.equal(token, ModelFiles)
      implementation = value as Record<string, MainHandler>
      // Keep the registered lease/lifecycle implementation real while avoiding model downloads.
      implementation.ensure = (_input, caller) => caller.signal.throwIfAborted()
      implementation.decisionEnsure = (_input, caller) => caller.signal.throwIfAborted()
      return () => {}
    },
  } as unknown as Parameters<typeof setupMain>[0]
  const stop = setupMain(ctx)
  return {
    implementation,
    cleanup,
    stop: typeof stop === "function" ? stop : undefined,
    window,
    otherWindow,
  }
}

const invoke = async <T = unknown>(
  host: MainHost,
  method: string,
  input: unknown,
  window: number,
  signal = new AbortController().signal,
) => {
  signal.throwIfAborted()
  const handler = host.implementation[method]
  if (!handler) throw new Error(`No registered ModelFiles method: ${method}`)
  return (await handler(input, { window, signal })) as T
}

const makeFiles = (host: MainHost, window: number, signal: AbortSignal) => {
  const call = <T>(method: string, input: unknown = {}, options?: { signal?: AbortSignal }) =>
    invoke<T>(host, method, input, window, options?.signal ?? signal)
  return {
    identity: (options?: { signal?: AbortSignal }) =>
      call<{
        providerEpoch: string
        windowID: number
        previousProviderEpoch?: string
        previousProviderState?: string
      }>("identity", {}, options),
    registerGeneration: (
      input: { generationID: string; generationSequence: number },
      options?: { signal?: AbortSignal },
    ) => call<void>("registerGeneration", input, options),
    status: (options?: { signal?: AbortSignal }) =>
      call<{ occupied: boolean }>("status", {}, options),
    decisionStatus: (options?: { signal?: AbortSignal }) =>
      call<unknown>("decisionStatus", {}, options),
    ensure: (input: unknown, options?: { signal?: AbortSignal }) =>
      call<void>("ensure", input, options),
    decisionEnsure: (input: unknown, options?: { signal?: AbortSignal }) =>
      call<void>("decisionEnsure", input, options),
    acquire: (input: unknown, options?: { signal?: AbortSignal }) =>
      call<ModelLeaseGrant>("acquire", input, options),
    reconcileAcquire: (input: unknown, options?: { signal?: AbortSignal }) =>
      call<{ lease: ModelLeaseGrant | null }>("reconcileAcquire", input, options),
    release: (input: unknown, options?: { signal?: AbortSignal }) =>
      call("release", input, options),
    reconcileRelease: (input: unknown, options?: { signal?: AbortSignal }) =>
      call("reconcileRelease", input, options),
    read: (input: unknown, options?: { signal?: AbortSignal }) => call("read", input, options),
    decisionRead: (input: unknown, options?: { signal?: AbortSignal }) =>
      call("decisionRead", input, options),
    cancel: (input: unknown, options?: { signal?: AbortSignal }) =>
      call<void>("cancel", input, options),
    trace: (input: unknown, options?: { signal?: AbortSignal }) =>
      call<void>("trace", input, options),
    clear: (options?: { signal?: AbortSignal }) => call<void>("clear", {}, options),
  }
}

const broker = new InferenceBroker()
let brokerOwner: string | undefined
let attachCalls = 0
let detachCalls = 0
const worker = {
  attach: async ({ owner }: { owner: string }) => {
    attachCalls++
    broker.attach(owner)
    brokerOwner = owner
  },
  detach: async ({ owner, error }: { owner: string; error?: string }) => {
    detachCalls++
    broker.detach(owner, error)
    if (brokerOwner === owner) brokerOwner = undefined
  },
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

const makeRuntime = (host: MainHost, memory = new Map<string, object>()) => {
  const controller = new AbortController()
  const files = makeFiles(host, 17, controller.signal)
  const storage = {
    memory: <T extends object>(
      key: string,
      options: { initial: T },
    ): [T, (update: (draft: T) => void) => void] => {
      if (!memory.has(key)) memory.set(key, options.initial)
      const value = memory.get(key) as T
      return [value, (update) => update(value)]
    },
  }
  const ctx = {
    signal: controller.signal,
    storage,
    main: (token: unknown) => {
      assert.equal(token, ModelFiles)
      return files
    },
    client: { rpc: (definition: unknown) => (definition === LocalInference ? {} : worker) },
  } as unknown as Parameters<Plugin.Setup>[0]
  const [features] = solid.createSignal(defaultFeatures(true))
  let disposeRoot!: () => void
  const timing = {
    now: () => performance.now(),
    wallNow: () => Date.now(),
    schedule: () => () => {},
    serviceTimeoutMs: 5_000,
  }
  const runtime = solid.createRoot((dispose) => {
    disposeRoot = dispose
    return createInferenceRuntime(ctx, () => -1, undefined, features, timing)
  })
  return { runtime, controller, files, memory, disposeRoot }
}

const until = async (condition: () => boolean | Promise<boolean>, label: string) => {
  const deadline = Date.now() + 8_000
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await Bun.sleep(10)
  }
}

const memoryFor = (runtime: ReturnType<typeof makeRuntime>) =>
  runtime.memory.get("webgpu-model-lease") as {
    sequence: number
    current?: string
    generations: Record<
      string,
      {
        generationID: string
        generationSequence: number
        acquire?: Parameters<typeof runtime.files.acquire>[0]
        grant?: ModelLeaseGrant
      }
    >
  }

const cleanupMain = async (host: MainHost) => {
  for (const fn of host.cleanup.reverse()) fn()
  await host.stop?.()
}

const main = makeMain()
let current: ReturnType<typeof makeRuntime> | undefined
let partial: ReturnType<typeof makeRuntime> | undefined
let successor: ReturnType<typeof makeRuntime> | undefined
const requestController = new AbortController()

try {
  current = makeRuntime(main)
  await until(() => current!.runtime.state() === "ready", "registered original renderer")
  const originalMemory = structuredClone(memoryFor(current))
  const originalEntry = memoryFor(current).generations[memoryFor(current).current!]!
  assert.ok(originalEntry?.grant)
  assert.ok(originalEntry.acquire)
  const original = originalEntry.grant
  const oldOwner = original.owner
  const oldEpoch = (await current.files.identity()).providerEpoch
  assert.equal(brokerOwner, oldOwner)
  assert.equal(attachCalls, 1)

  const queued = broker.generate(
    { prompt: "queued across renderer reload", maxTokens: 8, timeoutMs: 10_000 },
    requestController.signal,
  )
  assert.equal(broker.demand().requested, true)
  assert.throws(() => broker.attach("foreign-window-token"), /Another renderer owns inference/)

  await assert.rejects(
    invoke(main, "registerGeneration", { generationID: "forged-reset", generationSequence: 1 }, 17),
    /stale renderer generation|identity does not match/,
  )
  main.window.webContents.emit(
    "did-frame-navigate",
    {},
    "https://opencode.local/subframe",
    0,
    0,
    false,
  )
  await assert.rejects(
    invoke(
      main,
      "registerGeneration",
      { generationID: "subframe-reset", generationSequence: 1 },
      17,
    ),
    /stale renderer generation|identity does not match/,
  )
  main.window.webContents.emit("did-navigate-in-page", {}, "https://opencode.local/#section", true)
  await assert.rejects(
    invoke(
      main,
      "registerGeneration",
      { generationID: "in-page-reset", generationSequence: 1 },
      17,
    ),
    /stale renderer generation|identity does not match/,
  )
  main.otherWindow.webContents.emit("did-navigate", {}, "https://opencode.local/other")
  await invoke(
    main,
    "registerGeneration",
    { generationID: "other-window", generationSequence: 1 },
    18,
  )
  await assert.rejects(
    invoke(
      main,
      "acquire",
      {
        generationID: "other-window",
        generationSequence: 1,
        operationID: "other-window-acquire",
        providerEpoch: oldEpoch,
      },
      18,
    ),
    /owned|cleaned up/,
  )

  const lateReplyGate = Promise.withResolvers<void>()
  const lateReplyReached = Promise.withResolvers<ModelLeaseGrant>()
  const registeredAcquire = main.implementation.acquire!
  const lateReply = Promise.resolve(
    registeredAcquire(originalEntry.acquire, {
      window: 17,
      signal: new AbortController().signal,
    }),
  ).then(async (reply) => {
    lateReplyReached.resolve(reply as ModelLeaseGrant)
    await lateReplyGate.promise
    return reply as ModelLeaseGrant
  })
  assert.deepEqual(await lateReplyReached.promise, original)

  // Electron's registered did-navigate callback is the only reset authority; repeating it is idempotent.
  main.window.webContents.emit("did-navigate", {}, "https://opencode.local/reload")
  main.window.webContents.emit("did-navigate", {}, "https://opencode.local/reload")
  await until(
    async () => (await invoke<{ occupied: boolean }>(main, "status", {}, 17)).occupied,
    "host-loss reservation",
  )
  assert.equal(modelDisposals, 0, "main host loss is not reported as renderer model disposal")
  assert.equal(detachCalls, 0, "the persistent broker is not detached by a host event")
  assert.equal(brokerOwner, oldOwner)

  // Stale, unexplained handoff memory is not promoted into proof of a page-lifetime reset.
  partial = makeRuntime(main, new Map([["webgpu-model-lease", originalMemory]]))
  await until(() => partial!.runtime.state() === "error", "partial memory rejection")
  assert.match(partial.runtime.detail(), /restart its generation sequence/)
  assert.equal(brokerOwner, oldOwner)

  successor = makeRuntime(main)
  await until(() => successor!.runtime.state() === "ready", "fresh renderer after window reload")
  const freshMemory = memoryFor(successor)
  const freshEntry = freshMemory.generations[freshMemory.current!]!
  assert.equal(freshMemory.sequence, 1)
  assert.notEqual(freshEntry.generationID, original.generationID)
  assert.equal((await successor.files.identity()).providerEpoch, oldEpoch)
  assert.equal(freshEntry.grant?.owner, oldOwner)
  assert.equal(
    freshEntry.grant?.retired,
    undefined,
    "host loss is not an explicit renderer disposal ack",
  )
  assert.equal(brokerOwner, oldOwner)
  assert.equal(attachCalls, 2, "the same persistent server broker accepts its exact token")
  assert.equal(detachCalls, 0)
  assert.throws(() => broker.attach("foreign-window-token"), /Another renderer owns inference/)

  lateReplyGate.resolve()
  assert.deepEqual(await lateReply, original, "late old acquire replies remain descriptive only")
  await assert.rejects(invoke(main, "cancel", original, 17), /does not own/)
  await invoke(main, "cancel", freshEntry.grant, 17)
  assert.equal((await invoke<{ occupied: boolean }>(main, "status", {}, 18)).occupied, true)

  const job = broker.poll(oldOwner).job
  assert.equal(job?.prompt, "queued across renderer reload")
  broker.complete(oldOwner, job!.id, {
    ok: true,
    text: "still queued",
    error: "",
    promptTokens: 3,
    completionTokens: 2,
  })
  assert.equal((await queued).text, "still queued")

  await successor.runtime.unload()
  successor.controller.abort()
  await successor.runtime.dispose()
  successor.disposeRoot()
  successor = undefined
  partial.controller.abort()
  await partial.runtime.dispose()
  partial.disposeRoot()
  partial = undefined
  await cleanupMain(main)
  console.log("registered renderer-window reload recovered without broker reset")
} finally {
  requestController.abort()
  if (successor) {
    successor.controller.abort()
    await successor.runtime.dispose()
    successor.disposeRoot()
  }
  if (partial) {
    partial.controller.abort()
    await partial.runtime.dispose()
    partial.disposeRoot()
  }
  if (current) current.disposeRoot()
  await cleanupMain(main)
}
