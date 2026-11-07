// Isolated process: exercise pending registration through the actual registered main IPC adapter.
import { mock } from "bun:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelFiles } from "../src/webgpu/ipc.ts"

type StopGate = {
  reached: PromiseWithResolvers<void>
  released: PromiseWithResolvers<void>
  failure?: Error
  used: boolean
}

let nextStopGate: StopGate | undefined

class MainCache {
  constructor(readonly directory: string) {}

  async status() {
    return {
      phase: "empty",
      cachedBytes: 0,
      totalBytes: 0,
      downloadedBytes: 0,
      directory: this.directory,
      error: "",
    }
  }

  async ensure() {}
  async read() {
    return ""
  }
  cancel() {}
  async clear() {}

  async stop() {
    const gate = nextStopGate
    if (!gate || gate.used) return
    gate.used = true
    gate.reached.resolve()
    await gate.released.promise
    if (gate.failure) throw gate.failure
  }
}

mock.module("../src/webgpu/cache.ts", () => ({
  ModelCache: MainCache,
  modelCacheDirectory: (directory?: string) =>
    directory ?? join(tmpdir(), `lazers-main-registration-${crypto.randomUUID()}`),
}))

const { setupMain } = await import("../src/webgpu/main.ts")

type Caller = { window: number; signal: AbortSignal }
type MainHandler = (input: unknown, caller: Caller) => unknown

class FakeWebContents extends EventEmitter {
  getOSProcessId() {
    return 4_217
  }
}

class FakeBrowserWindow extends EventEmitter {
  readonly webContents = new FakeWebContents()

  constructor(readonly id: number) {
    super()
  }
}

const makeMain = () => {
  const window = new FakeBrowserWindow(17)
  const otherWindow = new FakeBrowserWindow(18)
  const cleanup: Array<() => void> = []
  const persistent = new Map<string, unknown>()
  const windowListeners = new Map<string, (...args: never[]) => void>()
  let implementation: Record<string, MainHandler> = {}
  const context = {
    options: { dataDirectory: join(tmpdir(), `lazers-main-registration-${crypto.randomUUID()}`) },
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
        windowListeners.set(event, handler)
        return () => windowListeners.delete(event)
      },
    },
    onCleanup: (fn: () => void) => cleanup.push(fn),
    provide: (token: unknown, value: unknown) => {
      assert.equal(token, ModelFiles)
      implementation = value as Record<string, MainHandler>
      return () => {}
    },
  } as unknown as Parameters<typeof setupMain>[0]

  const stop = setupMain(context)
  return {
    implementation,
    cleanup,
    window,
    otherWindow,
    stop: typeof stop === "function" ? stop : async () => {},
  }
}

const caller = (window: number): Caller => ({ window, signal: new AbortController().signal })
const handler = (host: ReturnType<typeof makeMain>, method: string) => {
  const found = host.implementation[method]
  assert.ok(found, `registered ModelFiles handler missing: ${method}`)
  return found
}
const invoke = <T>(
  host: ReturnType<typeof makeMain>,
  method: string,
  input: unknown,
  window = 17,
) => Promise.resolve().then(() => handler(host, method)(input, caller(window))) as Promise<T>
const holdNextDrain = (failure?: Error) => {
  const gate: StopGate = {
    reached: Promise.withResolvers<void>(),
    released: Promise.withResolvers<void>(),
    ...(failure ? { failure } : {}),
    used: false,
  }
  nextStopGate = gate
  return gate
}
const cleanupMain = async (host: ReturnType<typeof makeMain>) => {
  for (const fn of host.cleanup.reverse()) fn()
  await host.stop()
}

const makeOwner = async (host: ReturnType<typeof makeMain>, generationID: string) => {
  const identity = await invoke<{ providerEpoch: string }>(host, "identity", {}, 17)
  await invoke<void>(host, "registerGeneration", { generationID, generationSequence: 1 })
  const grant = await invoke<{
    owner: string
    generationID: string
    generationSequence: number
    operationID: string
    providerEpoch: string
  }>(host, "acquire", {
    generationID,
    generationSequence: 1,
    operationID: `acquire-${generationID}`,
    providerEpoch: identity.providerEpoch,
  })
  return { identity, grant }
}

const waitOneTurn = () => new Promise<void>((resolve) => queueMicrotask(resolve))

try {
  // A held host-loss drain keeps the main IPC call pending, then registers before success.
  {
    const host = makeMain()
    try {
      const { identity, grant } = await makeOwner(host, "old-page")
      assert.equal(
        handler(host, "registerGeneration")(
          { generationID: "old-page", generationSequence: 1 },
          caller(17),
        ),
        undefined,
        "already-current registration remains synchronously compatible",
      )
      const drain = holdNextDrain()
      host.window.webContents.emit("did-navigate", {}, "https://opencode.local/reload")
      await drain.reached.promise

      const rawRegistration = handler(host, "registerGeneration")(
        { generationID: "new-page", generationSequence: 1 },
        caller(17),
      )
      assert.ok(rawRegistration instanceof Promise, "IPC returns the held lease registration")
      let registrationSettled = false
      const registration = Promise.resolve(rawRegistration).then(() => {
        registrationSettled = true
      })
      await waitOneTurn()
      assert.equal(registrationSettled, false, "renderer cannot observe success before the drain")

      await assert.rejects(
        invoke(host, "acquire", {
          generationID: "new-page",
          generationSequence: 1,
          operationID: "too-early",
          providerEpoch: identity.providerEpoch,
        }),
        /stale renderer generation/,
      )
      assert.equal((await invoke<{ occupied: boolean }>(host, "status", {})).occupied, true)

      drain.released.resolve()
      await registration
      assert.equal(registrationSettled, true)
      const successor = await invoke<typeof grant>(host, "acquire", {
        generationID: "new-page",
        generationSequence: 1,
        operationID: "acquire-new-page",
        providerEpoch: identity.providerEpoch,
      })
      assert.equal(successor.owner, grant.owner)
      assert.equal(successor.generationID, "new-page")
      assert.equal(successor.providerEpoch, identity.providerEpoch)
    } finally {
      nextStopGate = undefined
      await cleanupMain(host)
    }
  }

  // Rejected main cleanup propagates through the registered IPC promise to its caller.
  {
    const host = makeMain()
    try {
      const { identity } = await makeOwner(host, "reject-old-page")
      const drainFailure = new Error("simulated host-loss drain rejection")
      const drain = holdNextDrain(drainFailure)
      host.window.webContents.emit("did-navigate", {}, "https://opencode.local/reject")
      await drain.reached.promise
      const rawRegistration = handler(host, "registerGeneration")(
        { generationID: "reject-new-page", generationSequence: 1 },
        caller(17),
      )
      assert.ok(rawRegistration instanceof Promise, "pending registration promise reaches IPC")
      const rejectedRegistration = assert.rejects(
        rawRegistration,
        /simulated host-loss drain rejection/,
      )
      drain.released.resolve()
      await rejectedRegistration
      await assert.rejects(
        invoke(host, "registerGeneration", {
          generationID: "retry-new-page",
          generationSequence: 1,
        }),
        /Host-observed renderer lifetime loss did not settle/,
      )
      await assert.rejects(
        invoke(host, "acquire", {
          generationID: "reject-new-page",
          generationSequence: 1,
          operationID: "rejected-page-acquire",
          providerEpoch: identity.providerEpoch,
        }),
        /stale renderer generation/,
      )
    } finally {
      nextStopGate = undefined
      await cleanupMain(host)
    }
  }

  // Provider shutdown stays blocked while the registered host-loss registration is pending.
  {
    const host = makeMain()
    const { grant } = await makeOwner(host, "shutdown-old-page")
    const drain = holdNextDrain()
    host.window.webContents.emit("did-navigate", {}, "https://opencode.local/shutdown")
    await drain.reached.promise
    const rawRegistration = handler(host, "registerGeneration")(
      { generationID: "shutdown-new-page", generationSequence: 1 },
      caller(17),
    )
    assert.ok(rawRegistration instanceof Promise)
    const rejectedRegistration = assert.rejects(rawRegistration, /provider is shutting down/)

    let shutdownSettled = false
    for (const fn of host.cleanup.reverse()) fn()
    const shutdown = Promise.resolve(host.stop()).then(() => {
      shutdownSettled = true
    })
    await waitOneTurn()
    assert.equal(shutdownSettled, false, "provider shutdown waits for pending lease work")
    assert.equal(grant.generationID, "shutdown-old-page")

    drain.released.resolve()
    await rejectedRegistration
    await shutdown
    assert.equal(shutdownSettled, true)
    nextStopGate = undefined
  }

  console.log("registered main generation registration lifecycle passed")
} finally {
  nextStopGate?.released.resolve()
  nextStopGate = undefined
}
