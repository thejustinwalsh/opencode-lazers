import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { Schema } from "effect"
import { InferenceTrace } from "./ipc.ts"
import { setupMain } from "./main.ts"

const decode = Schema.decodeUnknownSync(InferenceTrace, { onExcessProperty: "error" })

const event = {
  requestID: "request-1",
  jobID: "job-1",
  mode: "systemone",
  feature: "decisions",
  stage: "prefill",
  elapsedMs: 12,
  deltaMs: 4,
  queueDepth: 0,
  active: true,
  configuredEP: "webgpu",
  observedEP: "unknown",
  contextCapacityTokens: 8_192,
  configuredMaxTokens: 0,
  inputChars: 640,
  questionCount: 4,
  actualInputTokens: 640,
  outputGeneratedTokens: 0,
  rendererLagMs: 250,
  jsHeapBytes: 2_900_000_000,
  heapLimitBytes: 8_100_000_000,
  inputShape: [1, 640],
  outputShape: [1, 128_000],
} as const

test("IPC accepts the bounded content-free trace contract", () => {
  expect(decode(event)).toEqual(event)
})

test("IPC rejects invalid and unbounded metadata", () => {
  expect(() => decode({ ...event, requestID: "" })).toThrow()
  expect(() => decode({ ...event, inputShape: Array.from({ length: 9 }, () => 1) })).toThrow()
  expect(() => decode({ ...event, elapsedMs: 86_400_001 })).toThrow()
  expect(() =>
    decode({ ...event, prompt: "user content must not cross the trace contract" }),
  ).toThrow()
})

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

type LogEntry = {
  level: string
  message: string
  data: Record<string, unknown> | undefined
}

const makeMainFixture = (write: (entry: LogEntry) => void) => {
  const window = new FakeBrowserWindow(17, 4242)
  const cleanup: (() => void)[] = []
  const windowListeners = new Map<string, (...args: never[]) => void>()
  let implementation!: { trace: (event: unknown, caller: { window: number }) => void }
  const ctx = {
    options: { dataDirectory: `/private/tmp/lazers-main-trace-${crypto.randomUUID()}` },
    log: {
      write: (level: string, message: string, data?: Record<string, unknown>) =>
        write({ level, message, data }),
    },
    windows: {
      get: (id: number) => (id === window.id ? window : undefined),
      list: () => [window],
      focused: () => window,
      on: (event: "open" | "close", handler: (...args: never[]) => void) => {
        windowListeners.set(event, handler)
        return () => windowListeners.delete(event)
      },
    },
    onCleanup: (fn: () => void) => cleanup.push(fn),
    provide: (_token: unknown, value: typeof implementation) => {
      implementation = value
      return () => {}
    },
  } as unknown as Parameters<typeof setupMain>[0]
  const stop = setupMain(ctx)
  return {
    window,
    cleanup,
    implementation,
    windowListeners,
    stop,
  }
}

const traceEvent = {
  requestID: "request-native",
  jobID: "job-native",
  stage: "run",
  elapsedMs: 12,
  deltaMs: 3,
  configuredEP: "webgpu",
  observedEP: "unknown",
} as const

test("main persists the last trace and annotates renderer lifecycle events", async () => {
  const logs: LogEntry[] = []
  const fixture = makeMainFixture((entry) => logs.push(entry))
  expect(
    logs.find((entry) => entry.message === "LAZERS WebGPU cache available")?.data,
  ).toMatchObject({
    diagnosticsDirectory: expect.any(String),
    rendererDebugProfileMs: 500,
    rendererDebugTimeoutMs: 2_000,
  })
  fixture.implementation.trace(traceEvent, { window: 17 })
  fixture.window.emit("unresponsive")
  fixture.window.emit("unresponsive")
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(logs.filter((entry) => entry.message === "LAZERS renderer debugger capture")).toHaveLength(
    1,
  )
  fixture.window.emit("responsive")
  fixture.window.emit("unresponsive")
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(logs.filter((entry) => entry.message === "LAZERS renderer debugger capture")).toHaveLength(
    2,
  )
  fixture.window.webContents.emit("render-process-gone", {}, { reason: "oom" })
  fixture.window.webContents.emit("did-navigate", {}, "https://opencode.local")

  const traceLog = logs.find((entry) => entry.message === "LAZERS WebGPU inference trace")
  expect(traceLog).toMatchObject({ level: "info" })
  expect(traceLog?.data).toMatchObject({
    windowID: 17,
    requestID: "request-native",
    jobID: "job-native",
  })
  const unresponsive = logs.find((entry) => entry.message === "LAZERS WebGPU renderer unresponsive")
  expect(unresponsive?.data).toMatchObject({
    windowID: 17,
    rendererPID: 4242,
    lastStage: "run",
    lastRequestID: "request-native",
    lastJobID: "job-native",
  })
  expect(logs.some((entry) => entry.message === "LAZERS WebGPU renderer responsive")).toBe(true)
  expect(logs.some((entry) => entry.message === "LAZERS WebGPU renderer process gone")).toBe(true)
  expect(logs.some((entry) => entry.message === "LAZERS WebGPU renderer navigated")).toBe(true)

  const beforeCleanup = logs.length
  for (const fn of fixture.cleanup.reverse()) fn()
  fixture.window.emit("unresponsive")
  fixture.window.webContents.emit("did-navigate", {}, "https://opencode.local")
  expect(logs).toHaveLength(beforeCleanup)
  if (typeof fixture.stop === "function") await fixture.stop()
})

test("host logging failures do not reject trace reporting or renderer callbacks", async () => {
  const fixture = makeMainFixture(() => {
    throw new Error("log unavailable")
  })
  expect(() => fixture.implementation.trace(traceEvent, { window: 17 })).not.toThrow()
  expect(() => fixture.window.emit("unresponsive")).not.toThrow()
  for (const fn of fixture.cleanup.reverse()) fn()
  if (typeof fixture.stop === "function") await fixture.stop()
})
