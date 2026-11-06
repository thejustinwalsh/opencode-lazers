// Isolated process: exercise the registered main IPC and renderer runtime with pinned GUI abort ordering.
import { mock } from "bun:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin/gui"
import { ModelFiles } from "../src/webgpu/ipc.ts"
import type { ModelLeaseGrant, ModelLeaseRetirement } from "../src/webgpu/ipc.ts"
import { setupMain } from "../src/webgpu/main.ts"
import { LocalInference } from "../src/webgpu/rpc.ts"
import { defaultFeatures } from "../src/webgpu/features.ts"

const solid: typeof import("solid-js") = await import(
  createRequire(import.meta.url).resolve("solid-js/dist/solid.js")
)
mock.module("solid-js", () => solid)

let allocations = 0
let maximumAllocations = 0
let successfulDisposals = 0
let failedDisposal = false
let disposeGate: Promise<void> | undefined
let disposeStarted = Promise.withResolvers<void>()
const holdNextDisposal = () => {
  const gate = Promise.withResolvers<void>()
  disposeGate = gate.promise
  disposeStarted = Promise.withResolvers<void>()
  return { started: disposeStarted.promise, release: gate.resolve }
}

const allocateModel = () => {
  allocations++
  maximumAllocations = Math.max(maximumAllocations, allocations)
  let disposed = false
  return async () => {
    disposeStarted.resolve()
    await disposeGate
    if (failedDisposal) throw new Error("simulated renderer disposal failure")
    if (disposed) return
    disposed = true
    allocations--
    successfulDisposals++
  }
}

mock.module("../.cache/lfm3-engine.js", () => ({
  Lfm3OmniForConditionalGeneration: {
    from_pretrained: async () => ({
      dispose: allocateModel(),
      lost: new Promise(() => {}),
      deviceInfo: () => ({ description: "Registered test GPU" }),
      create_session: () => ({ dispose: async () => {}, generate: async function* () {} }),
    }),
  },
}))
mock.module("../src/webgpu/decision-runtime.ts", () => ({
  loadDecisionRuntime: async () => ({ dispose: allocateModel(), systemOne: async () => ({}) }),
}))
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu: {} } })

const { createInferenceRuntime } = await import("../src/webgpu/runtime.ts")

type Caller = { window: number; signal: AbortSignal }
type MainHandler = (input: unknown, caller: Caller) => unknown
type ResponseGate = {
  method: string
  matches(input: unknown): boolean
  reached: PromiseWithResolvers<void>
  released: PromiseWithResolvers<void>
}
type MainHost = {
  implementation: Record<string, MainHandler>
  calls: Map<string, number>
  invocations: Array<{ method: string; window: number; input: unknown }>
  logs: Array<{ level: string; message: string; data?: Record<string, unknown> }>
  memory: Map<string, object>
  gate?: ResponseGate
  cleanup: Array<() => void>
  stop?: () => void | Promise<void>
  foreignSequence: number
  workerOwner?: string
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
  const window = new FakeBrowserWindow(17, 4217)
  const otherWindow = new FakeBrowserWindow(18, 4218)
  const cleanup: Array<() => void> = []
  const calls = new Map<string, number>()
  const invocations: MainHost["invocations"] = []
  const logs: MainHost["logs"] = []
  const listeners = new Map<string, (...args: never[]) => void>()
  let implementation: Record<string, MainHandler> = {}
  const ctx = {
    options: { dataDirectory: join(tmpdir(), `lazers-main-lease-${crypto.randomUUID()}`) },
    signal: new AbortController().signal,
    log: {
      write: (level: string, message: string, data?: Record<string, unknown>) =>
        logs.push({ level, message, data }),
    },
    windows: {
      get: (id: number) => (id === 17 ? window : id === 18 ? otherWindow : undefined),
      list: () => [window, otherWindow],
      focused: () => window,
      on: (event: string, handler: (...args: never[]) => void) => {
        listeners.set(event, handler)
        return () => listeners.delete(event)
      },
    },
    onCleanup: (fn: () => void) => cleanup.push(fn),
    provide: (_token: unknown, value: unknown) => {
      assert.equal(_token, ModelFiles)
      implementation = value as Record<string, MainHandler>
      return () => {}
    },
  } as unknown as Parameters<typeof setupMain>[0]
  const stop = setupMain(ctx)
  return {
    implementation,
    calls,
    invocations,
    logs,
    memory: new Map(),
    foreignSequence: 0,
    cleanup,
    stop: typeof stop === "function" ? stop : undefined,
    window,
    otherWindow,
  }
}

const abortError = () =>
  Object.assign(new Error("GUI main client context is aborted"), { name: "AbortError" })

const invoke = async (
  host: MainHost,
  method: string,
  input: unknown,
  window: number,
  signal: AbortSignal,
) => {
  if (signal.aborted) throw abortError()
  let onAbort!: () => void
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError())
    signal.addEventListener("abort", onAbort, { once: true })
  })
  const operation = Promise.resolve().then(async () => {
    if (signal.aborted) throw abortError()
    host.calls.set(method, (host.calls.get(method) ?? 0) + 1)
    host.invocations.push({ method, window, input })
    const handler = host.implementation[method]
    if (!handler) throw new Error(`No registered ModelFiles method: ${method}`)
    const output = await handler(input, { window, signal })
    const gate = host.gate
    if (gate?.method === method && gate.matches(input)) {
      gate.reached.resolve()
      await gate.released.promise
    }
    return output
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

const filesFor = (host: MainHost, window: number, contextSignal: AbortSignal) => {
  const signal = (options?: { signal?: AbortSignal }) => options?.signal ?? contextSignal
  return {
    identity: (options?: { signal?: AbortSignal }) =>
      invoke(host, "identity", {}, window, signal(options)) as Promise<{
        providerEpoch: string
        windowID: number
      }>,
    registerGeneration: (
      input: { generationID: string; generationSequence: number },
      options?: { signal?: AbortSignal },
    ) => invoke(host, "registerGeneration", input, window, signal(options)) as Promise<void>,
    status: (options?: { signal?: AbortSignal }) =>
      invoke(host, "status", {}, window, signal(options)) as Promise<{ occupied: boolean }>,
    decisionStatus: (options?: { signal?: AbortSignal }) =>
      invoke(host, "decisionStatus", {}, window, signal(options)) as Promise<unknown>,
    acquire: (input: unknown, options?: { signal?: AbortSignal }) =>
      invoke(host, "acquire", input, window, signal(options)) as Promise<ModelLeaseGrant>,
    reconcileAcquire: (input: unknown, options?: { signal?: AbortSignal }) =>
      invoke(host, "reconcileAcquire", input, window, signal(options)) as Promise<{
        lease: ModelLeaseGrant | null
      }>,
    ensure: async (_input: unknown, options?: { signal?: AbortSignal }) => {
      if (signal(options).aborted) throw abortError()
    },
    decisionEnsure: async (_input: unknown, options?: { signal?: AbortSignal }) => {
      if (signal(options).aborted) throw abortError()
    },
    read: async (_input: unknown, options?: { signal?: AbortSignal }) => {
      if (signal(options).aborted) throw abortError()
      return ""
    },
    decisionRead: async (_input: unknown, options?: { signal?: AbortSignal }) => {
      if (signal(options).aborted) throw abortError()
      return ""
    },
    release: (input: unknown, options?: { signal?: AbortSignal }) =>
      invoke(host, "release", input, window, signal(options)) as Promise<ModelLeaseRetirement>,
    reconcileRelease: (input: unknown, options?: { signal?: AbortSignal }) =>
      invoke(host, "reconcileRelease", input, window, signal(options)) as Promise<{
        retirement: ModelLeaseRetirement | null
      }>,
    cancel: (input: unknown, options?: { signal?: AbortSignal }) =>
      invoke(host, "cancel", input, window, signal(options)) as Promise<void>,
    trace: (input: unknown, options?: { signal?: AbortSignal }) =>
      invoke(host, "trace", input, window, signal(options)) as Promise<void>,
    clear: (options?: { signal?: AbortSignal }) =>
      invoke(host, "clear", {}, window, signal(options)) as Promise<void>,
  }
}

const runtimes: Array<{
  runtime: ReturnType<typeof createInferenceRuntime>
  controller: AbortController
  files: ReturnType<typeof filesFor>
  disposeRoot(): void
}> = []
const makeRuntime = (host: MainHost) => {
  const controller = new AbortController()
  const files = filesFor(host, 17, controller.signal)
  const worker = {
    attach: async ({ owner }: { owner: string }) => {
      if (host.workerOwner && host.workerOwner !== owner)
        throw new Error("Another renderer owns inference")
      host.workerOwner = owner
    },
    detach: async ({ owner }: { owner: string }) => {
      if (host.workerOwner !== owner) throw new Error("Renderer ownership was lost")
      host.workerOwner = undefined
    },
    poll: async () => ({ job: null, cancelID: null }),
    complete: async () => {},
    demand: async () => ({ requested: false }),
  }
  const ctx = {
    signal: controller.signal,
    storage: {
      memory: <T extends object>(key: string, options: { initial: T }) => {
        if (!host.memory.has(key)) host.memory.set(key, options.initial)
        const value = host.memory.get(key) as T
        return [value, (update: (draft: T) => void) => update(value)] as const
      },
    },
    main: (token: unknown) => {
      assert.equal(token, ModelFiles)
      return files
    },
    client: {
      rpc: (definition: unknown) => (definition === LocalInference ? {} : worker),
    },
  } as unknown as Parameters<Plugin.Setup>[0]
  const [features] = solid.createSignal(defaultFeatures(true))
  const timing = {
    now: () => performance.now(),
    wallNow: () => Date.now(),
    schedule: (_callback: () => void) => () => {},
  }
  let disposeRoot!: () => void
  const runtime = solid.createRoot((dispose) => {
    disposeRoot = dispose
    return createInferenceRuntime(ctx, () => -1, undefined, features, timing)
  })
  const entry = { runtime, controller, files, disposeRoot }
  runtimes.push(entry)
  return entry
}

const until = async (condition: () => boolean, label: string) => {
  const deadline = Date.now() + 6_000
  while (!condition()) {
    if (Date.now() >= deadline)
      throw new Error(
        `Timed out waiting for ${label}; runtimes=${JSON.stringify(runtimes.map(({ runtime }) => ({ state: runtime.state(), detail: runtime.detail() })))}`,
      )
    await Bun.sleep(10)
  }
}

const callCount = (host: MainHost, method: string, window: number) =>
  host.invocations.filter((call) => call.method === method && call.window === window).length

const rejectWith = async (promise: Promise<unknown>, pattern: RegExp) => {
  try {
    await promise
    assert.fail(`Expected rejection matching ${pattern}`)
  } catch (error) {
    assert.match(String(error), pattern)
  }
}

const memoryFor = (host: MainHost) =>
  host.memory.get("webgpu-model-lease") as {
    current?: string
    generations: Record<
      string,
      {
        generationID: string
        generationSequence: number
        state: string
        disposalID?: string
        acquire?: { operationID: string; predecessor?: { retirementID: string } }
        grant?: ModelLeaseGrant
        retiredBy?: ModelLeaseRetirement
        releaseAck?: ModelLeaseRetirement
      }
    >
  }

const entryFor = (host: MainHost, sequence: number) =>
  Object.values(memoryFor(host).generations).find((entry) => entry.generationSequence === sequence)!

const assertOtherWindowBlocked = async (host: MainHost, epoch: string, label: string) => {
  const signal = new AbortController().signal
  const files = filesFor(host, 18, signal)
  const generationSequence = ++host.foreignSequence
  await files.registerGeneration(
    { generationID: `foreign-${label}`, generationSequence },
    { signal },
  )
  await rejectWith(
    files.acquire(
      {
        generationID: `foreign-${label}`,
        generationSequence,
        operationID: `foreign-op-${label}`,
        providerEpoch: epoch,
      },
      { signal },
    ),
    /owned|cleaned up/,
  )
  await rejectWith(files.clear({ signal }), /Unload the model/)
}

const setGate = (host: MainHost, method: string, matches: (input: unknown) => boolean) => {
  const gate: ResponseGate = {
    method,
    matches,
    reached: Promise.withResolvers<void>(),
    released: Promise.withResolvers<void>(),
  }
  host.gate = gate
  return { reached: gate.reached.promise, release: gate.released.resolve }
}

const cleanupHost = async (host: MainHost) => {
  for (const runtime of runtimes.splice(0)) runtime.disposeRoot()
  for (const fn of host.cleanup.reverse()) fn()
  await host.stop?.()
}

try {
  // A blocked renderer disposal keeps the exact predecessor occupied until its proof is recorded.
  {
    const host = makeMain()
    try {
      const a = makeRuntime(host)
      await until(() => a.runtime.state() === "ready", "generation A model load")
      assert.equal(allocations, 1)
      const epoch = (await a.files.identity({ signal: a.controller.signal })).providerEpoch

      const disposal = holdNextDisposal()
      const statusCalls = callCount(host, "status", 17)
      a.controller.abort()
      const cleanupA = a.runtime.dispose()
      await disposal.started
      await rejectWith(a.files.status({ signal: a.controller.signal }), /aborted/)
      assert.equal(
        callCount(host, "status", 17),
        statusCalls,
        "aborted ctx.main calls never reach main",
      )

      const b = makeRuntime(host)
      await until(
        () => callCount(host, "registerGeneration", 17) === 2,
        "generation B registration",
      )
      await Bun.sleep(60)
      assert.equal(
        callCount(host, "acquire", 17),
        1,
        "B does not acquire while A renderer disposal is pending",
      )
      assert.equal(allocations, 1)
      await assertOtherWindowBlocked(host, epoch, "pending-a")

      disposal.release()
      await cleanupA
      await until(() => b.runtime.state() === "ready", "generation B handoff")
      assert.equal(callCount(host, "acquire", 17), 2)
      assert.equal(successfulDisposals, 1)
      assert.equal(allocations, 1)
      assert.equal(maximumAllocations, 1)
      const aEntry = entryFor(host, 1)
      const bEntry = entryFor(host, 2)
      assert.equal(aEntry.state, "disposed")
      assert.ok(aEntry.disposalID)
      assert.equal(bEntry.grant?.retired?.generationID, aEntry.generationID)
      assert.equal(aEntry.retiredBy?.retirementID, bEntry.grant?.retired?.retirementID)
      await assertOtherWindowBlocked(host, epoch, "after-b")

      // A third generation must wait for B and must not accept B's identity as A's acknowledgement.
      const disposalB = holdNextDisposal()
      b.controller.abort()
      const cleanupB = b.runtime.dispose()
      await disposalB.started
      const c = makeRuntime(host)
      await until(
        () => callCount(host, "registerGeneration", 17) === 3,
        "generation C registration",
      )
      await Bun.sleep(60)
      assert.equal(callCount(host, "acquire", 17), 2, "C waits for proven B disposal")
      assert.equal(allocations, 1)
      await assertOtherWindowBlocked(host, epoch, "pending-b")
      disposalB.release()
      await cleanupB
      await until(() => c.runtime.state() === "ready", "generation C handoff")
      assert.equal(callCount(host, "acquire", 17), 3)
      assert.equal(maximumAllocations, 1)
      const cEntry = entryFor(host, 3)
      assert.equal(cEntry.grant?.retired?.generationID, bEntry.generationID)
      await assertOtherWindowBlocked(host, epoch, "after-c")

      const token = cEntry.grant!.owner
      const leaseDiagnostics = JSON.stringify(host.logs)
      assert.ok(leaseDiagnostics.includes(cEntry.grant!.operationID))
      assert.ok(leaseDiagnostics.includes(cEntry.grant!.retired!.retirementID))
      assert.ok(!leaseDiagnostics.includes(token), "lease diagnostics never expose release tokens")
      c.controller.abort()
      await c.runtime.dispose()
    } finally {
      await cleanupHost(host)
    }
  }

  // Cancellation before dispatch allocates nothing; cancellation after main acquisition reconciles its exact operation.
  {
    const host = makeMain()
    try {
      const active = filesFor(host, 17, new AbortController().signal)
      const epoch = (await active.identity()).providerEpoch
      const cancelled = new AbortController()
      cancelled.abort()
      const staleFiles = filesFor(host, 17, cancelled.signal)
      await rejectWith(
        staleFiles.acquire(
          {
            generationID: "cancelled-before-dispatch",
            generationSequence: 1,
            operationID: "cancelled-before-acquire",
            providerEpoch: epoch,
          },
          { signal: cancelled.signal },
        ),
        /aborted/,
      )
      assert.equal(callCount(host, "acquire", 17), 0)
      assert.equal((await active.status()).occupied, false)

      const response = setGate(host, "acquire", () => true)
      const a = makeRuntime(host)
      await response.reached
      assert.equal(
        (await active.status()).occupied,
        true,
        "main acquired before the response was lost",
      )
      a.controller.abort()
      await a.runtime.dispose()
      await rejectWith(a.files.status({ signal: a.controller.signal }), /aborted/)
      host.gate = undefined

      const b = makeRuntime(host)
      await until(() => b.runtime.state() === "ready", "reconciled acquisition handoff")
      assert.equal(allocations, 1, "the cancelled generation never allocated an anonymous model")
      assert.equal(maximumAllocations, 1)
      assert.equal(callCount(host, "acquire", 17), 2)
      assert.equal(entryFor(host, 2).grant?.retired?.generationID, entryFor(host, 1).generationID)
      assert.equal(
        entryFor(host, 2).grant?.retired?.rendererDisposalID,
        entryFor(host, 1).disposalID,
      )
      response.release()
      b.controller.abort()
      await b.runtime.dispose()
    } finally {
      await cleanupHost(host)
    }
  }

  // A lost B retirement reply is reconciled by C using B's operation ID, then fenced by a distinct C acknowledgement.
  {
    const host = makeMain()
    try {
      const a = makeRuntime(host)
      await until(() => a.runtime.state() === "ready", "retirement scenario A")
      a.controller.abort()
      await a.runtime.dispose()
      assert.equal(allocations, 0)

      const response = setGate(host, "acquire", (input) =>
        Boolean((input as { predecessor?: unknown }).predecessor),
      )
      const b = makeRuntime(host)
      await response.reached
      assert.equal(callCount(host, "acquire", 17), 2)
      assert.equal((await b.files.status({ signal: b.controller.signal })).occupied, true)
      assert.equal(allocations, 0, "B has no model before the retirement response is acknowledged")

      b.controller.abort()
      await b.runtime.dispose()
      assert.equal(entryFor(host, 2).state, "disposed")
      assert.equal(
        entryFor(host, 2).grant,
        undefined,
        "B did not mistake the lost response for an ack",
      )
      const lostRetirementID = entryFor(host, 2).acquire?.predecessor?.retirementID
      host.gate = undefined

      const c = makeRuntime(host)
      await until(() => c.runtime.state() === "ready", "C reconciles B retirement")
      const bEntry = entryFor(host, 2)
      const cEntry = entryFor(host, 3)
      assert.equal(cEntry.grant?.retired?.generationID, bEntry.generationID)
      assert.equal(bEntry.retiredBy?.retirementID, cEntry.grant?.retired?.retirementID)
      assert.notEqual(cEntry.grant?.retired?.retirementID, lostRetirementID)
      assert.equal(callCount(host, "acquire", 17), 3)
      assert.equal(maximumAllocations, 1)
      response.release()
      c.controller.abort()
      await c.runtime.dispose()
    } finally {
      await cleanupHost(host)
    }
  }

  // A lost explicit release reply is reconciled by its exact release identity and cannot retire a newer lease.
  {
    const host = makeMain()
    try {
      const a = makeRuntime(host)
      await until(() => a.runtime.state() === "ready", "explicit-retirement A")
      const lostReply = setGate(host, "release", () => true)
      const unloading = a.runtime.unload()
      await lostReply.reached
      assert.equal(allocations, 0, "renderer resources were disposed before main retirement")
      assert.equal((await a.files.status({ signal: a.controller.signal })).occupied, false)
      const releaseInput = host.invocations.findLast(
        (call) => call.method === "release" && call.window === 17,
      )?.input
      assert.ok(releaseInput)

      a.controller.abort()
      await Promise.all([unloading, a.runtime.dispose()])
      assert.equal(entryFor(host, 1).state, "disposed")
      assert.equal(
        entryFor(host, 1).releaseAck,
        undefined,
        "aborted caller never accepted the held reply",
      )
      host.gate = undefined

      const b = makeRuntime(host)
      await until(
        () => b.runtime.state() === "ready",
        "successor after exact release reconciliation",
      )
      assert.equal(callCount(host, "reconcileRelease", 17), 1)
      assert.equal(
        JSON.stringify(
          host.invocations.find((call) => call.method === "reconcileRelease" && call.window === 17)
            ?.input,
        ),
        JSON.stringify(releaseInput),
        "the successor reconciles the exact lost release operation",
      )
      assert.equal(entryFor(host, 2).grant?.retired, undefined)
      assert.equal(callCount(host, "acquire", 17), 2)

      lostReply.release()
      const active = filesFor(host, 17, new AbortController().signal)
      await active.release(releaseInput)
      assert.equal((await active.status()).occupied, true)
      await active.cancel({
        owner: entryFor(host, 2).grant!.owner,
        generationID: entryFor(host, 2).grant!.generationID,
        generationSequence: entryFor(host, 2).grant!.generationSequence,
        operationID: entryFor(host, 2).grant!.operationID,
        providerEpoch: entryFor(host, 2).grant!.providerEpoch,
      })
      b.controller.abort()
      await b.runtime.dispose()
    } finally {
      await cleanupHost(host)
    }
  }

  // Installed-plugin reload replaces main but retains the window's plugin memory.
  {
    const original = makeMain()
    let replacement: MainHost | undefined
    try {
      const a = makeRuntime(original)
      await until(() => a.runtime.state() === "ready", "normal reload original model")
      const oldEpoch = (await a.files.identity()).providerEpoch
      a.controller.abort()
      await a.runtime.dispose()
      assert.equal(allocations, 0, "the original renderer positively disposed its model")
      await cleanupHost(original)

      replacement = makeMain()
      replacement.memory = original.memory
      const b = makeRuntime(replacement)
      assert.notEqual((await b.files.identity()).providerEpoch, oldEpoch)
      await until(() => b.runtime.state() === "ready", "normal reload replacement model")
      assert.equal(allocations, 1)
      b.controller.abort()
      await b.runtime.dispose()
    } finally {
      if (replacement) await cleanupHost(replacement)
    }
  }

  // A failed renderer disposal and a changed provider epoch never turn unknown ownership into a free cache.
  {
    const host = makeMain()
    try {
      failedDisposal = true
      const a = makeRuntime(host)
      await until(() => a.runtime.state() === "ready", "failed-disposal A")
      a.controller.abort()
      await a.runtime.dispose()
      assert.equal(entryFor(host, 1).state, "failed")
      const b = makeRuntime(host)
      await until(() => b.runtime.state() === "error", "failed-disposal protection")
      assert.match(b.runtime.detail(), /disposal is unconfirmed/)
      assert.equal(callCount(host, "acquire", 17), 1)
      assert.equal(allocations, 1)
      const active = filesFor(host, 17, new AbortController().signal)
      const epoch = (await active.identity()).providerEpoch
      assert.equal((await active.status()).occupied, true)
      await assertOtherWindowBlocked(host, epoch, "failed-disposal")
      await rejectWith(active.clear(), /Unload the model/)
      b.controller.abort()
      await b.runtime.dispose()
    } finally {
      failedDisposal = false
      await cleanupHost(host)
    }
  }

  assert.equal(maximumAllocations, 1)
  console.log("registered abort-faithful lease handoff passed")
} finally {
  for (const runtime of runtimes.splice(0)) {
    runtime.controller.abort()
    await runtime.runtime.dispose()
    runtime.disposeRoot()
  }
  disposeGate = undefined
}
