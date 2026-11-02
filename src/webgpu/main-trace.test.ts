import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { Schema } from "effect"
import { InferenceTrace, RendererCaptureStatus } from "./ipc.ts"
import type { RendererArmedCaptureStatus } from "./renderer-armed-capture.ts"
import type { RendererDebugger } from "./renderer-debug.ts"
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

test("armed-capture status IPC stays bounded and content-free", () => {
  const decodeStatus = Schema.decodeUnknownSync(RendererCaptureStatus, {
    onExcessProperty: "error",
  })
  expect(
    decodeStatus({
      state: "recording",
      message: "Recording the targeted local inference job.",
      captureID: "capture-1",
      lastStage: "run",
      lastRequestID: "request-1",
      lastJobID: "job-1",
      stageCount: 2,
      stopTrigger: "manual-disarm",
      outcome: "failed",
      triggeredAt: 1_793_561_971_174,
      profilerCommands: [
        {
          method: "Profiler.start",
          outcome: "timed-out",
          startedAt: 1_793_561_971_174,
          settledAt: 1_793_561_973_174,
          nativePending: true,
          profilerStateUncertain: true,
        },
      ],
      profilerCleanup: {
        outcome: "detached",
        startedAt: 1_793_561_973_174,
        settledAt: 1_793_561_973_174,
      },
      persistenceFailure: "late-metadata-update",
    }),
  ).toMatchObject({
    state: "recording",
    lastJobID: "job-1",
    profilerCommands: [{ outcome: "timed-out", nativePending: true, profilerStateUncertain: true }],
    profilerCleanup: { outcome: "detached" },
    persistenceFailure: "late-metadata-update",
  })
  expect(() =>
    decodeStatus({ state: "recording", message: "x", stageCount: 2, prompt: "secret" }),
  ).toThrow()
  expect(() => decodeStatus({ state: "recording", message: "x", stageCount: 10_001 })).toThrow()
})

class FakeWebContents extends EventEmitter {
  constructor(
    private readonly pid: number,
    transport?: RendererDebugger,
  ) {
    super()
    if (transport) Object.defineProperty(this, "debugger", { value: transport })
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
    transport?: RendererDebugger,
  ) {
    super()
    this.webContents = new FakeWebContents(pid, transport)
  }
}

class FakeDebugger implements RendererDebugger {
  attached = false
  readonly calls: string[] = []
  rejectMethod = ""

  isAttached() {
    return this.attached
  }

  attach() {
    this.calls.push("attach")
    this.attached = true
  }

  detach() {
    this.calls.push("detach")
    this.attached = false
  }

  async sendCommand(method: string) {
    this.calls.push(method)
    if (method === this.rejectMethod) throw new Error(`${method} refused`)
    if (method === "Profiler.stop")
      return {
        profile: {
          nodes: [
            {
              id: 1,
              callFrame: {
                functionName: "root",
                scriptId: "1",
                url: "file:///runtime.js",
                lineNumber: -1,
                columnNumber: -1,
              },
              children: [],
            },
          ],
          samples: [1],
          timeDeltas: [10_000],
          startTime: 1,
          endTime: 10_001,
        },
      }
    return {}
  }
}

type LogEntry = {
  level: string
  message: string
  data: Record<string, unknown> | undefined
}

const makeMainFixture = (write: (entry: LogEntry) => void, withDebugger = false) => {
  const transport = withDebugger ? new FakeDebugger() : undefined
  const window = new FakeBrowserWindow(17, 4242, transport)
  const otherWindow = new FakeBrowserWindow(18, 4343)
  const cleanup: (() => void)[] = []
  const windowListeners = new Map<string, (...args: never[]) => void>()
  type MainAPI = {
    trace: (event: unknown, caller: { window: number }) => void
    rendererCaptureStatus: (_: undefined, caller: { window: number }) => RendererArmedCaptureStatus
    armRendererCapture: (
      _: undefined,
      caller: { window: number },
    ) => Promise<RendererArmedCaptureStatus>
    stopRendererCapture: (
      _: undefined,
      caller: { window: number },
    ) => Promise<RendererArmedCaptureStatus>
  }
  let implementation!: MainAPI
  const ctx = {
    options: { dataDirectory: `/private/tmp/lazers-main-trace-${crypto.randomUUID()}` },
    log: {
      write: (level: string, message: string, data?: Record<string, unknown>) =>
        write({ level, message, data }),
    },
    windows: {
      get: (id: number) =>
        id === window.id ? window : id === otherWindow.id ? otherWindow : undefined,
      list: () => [window, otherWindow],
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
    otherWindow,
    transport,
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

test("main exposes idempotent caller-window arm/status/stop controls and preserves target identity", async () => {
  const logs: LogEntry[] = []
  const fixture = makeMainFixture((entry) => logs.push(entry), true)
  const idle = fixture.implementation.rendererCaptureStatus(undefined, { window: 17 })
  expect(idle.state).toBe("idle")
  const armed = await fixture.implementation.armRendererCapture(undefined, { window: 17 })
  expect(armed.state).toBe("waiting")
  const duplicate = await fixture.implementation.armRendererCapture(undefined, { window: 17 })
  expect(duplicate.captureID).toBe(armed.captureID)
  expect(fixture.transport?.calls.filter((method) => method === "attach")).toHaveLength(1)
  expect(fixture.implementation.rendererCaptureStatus(undefined, { window: 18 }).state).toBe("idle")

  fixture.implementation.trace(
    {
      ...traceEvent,
      requestID: "other-window-request",
      jobID: "other-window-job",
      stage: "queued",
    },
    { window: 18 },
  )
  expect(fixture.implementation.rendererCaptureStatus(undefined, { window: 17 }).state).toBe(
    "waiting",
  )
  fixture.implementation.trace(
    { ...traceEvent, requestID: "target-request", jobID: "target-job", stage: "queued" },
    { window: 17 },
  )
  fixture.implementation.trace(
    { ...traceEvent, requestID: "target-request", jobID: "target-job", stage: "complete" },
    { window: 17 },
  )
  const result = await fixture.implementation.stopRendererCapture(undefined, { window: 17 })
  expect(result).toMatchObject({
    state: "complete",
    captured: true,
    lastRequestID: "target-request",
    lastJobID: "target-job",
    stopTrigger: "terminal",
  })
  expect(logs.some((entry) => entry.message === "LAZERS armed renderer CPU capture")).toBe(true)
  expect(fixture.transport?.attached).toBe(false)
  for (const fn of fixture.cleanup.reverse()) fn()
  if (typeof fixture.stop === "function") await fixture.stop()
})

test("armed unresponsive capture finalizes its owner instead of starting automatic capture", async () => {
  const logs: LogEntry[] = []
  const fixture = makeMainFixture((entry) => logs.push(entry), true)
  await fixture.implementation.armRendererCapture(undefined, { window: 17 })
  fixture.window.emit("unresponsive")
  const result = await fixture.implementation.stopRendererCapture(undefined, { window: 17 })
  expect(result).toMatchObject({
    state: "complete",
    captured: false,
    reason: "job-not-seen",
    stopTrigger: "unresponsive",
  })
  expect(logs.filter((entry) => entry.message === "LAZERS renderer debugger capture")).toHaveLength(
    0,
  )
  expect(fixture.transport?.calls.filter((method) => method === "Profiler.stop")).toHaveLength(1)
  expect(fixture.transport?.calls.filter((method) => method === "detach")).toHaveLength(1)
  for (const fn of fixture.cleanup.reverse()) fn()
  if (typeof fixture.stop === "function") await fixture.stop()
})

test("failed armed startup suppresses automatic CDP fallback across unresponsive/responsive events", async () => {
  const logs: LogEntry[] = []
  const fixture = makeMainFixture((entry) => logs.push(entry), true)
  fixture.transport!.rejectMethod = "Profiler.enable"
  const failed = await fixture.implementation.armRendererCapture(undefined, { window: 17 })
  expect(failed).toMatchObject({
    state: "complete",
    captured: false,
    reason: "error",
    failure: "profiler-enable",
    stopTrigger: "arming-failure",
  })

  fixture.window.emit("unresponsive")
  fixture.window.emit("responsive")
  fixture.window.emit("unresponsive")
  fixture.otherWindow.emit("unresponsive")
  await new Promise((resolve) => setTimeout(resolve, 0))

  const automatic = logs.filter((entry) => entry.message === "LAZERS renderer debugger capture")
  expect(automatic).toHaveLength(1)
  expect(automatic[0]?.data?.windowID).toBe(18)
  expect(fixture.transport?.calls.filter((method) => method === "attach")).toHaveLength(1)
  expect(fixture.transport?.calls.filter((method) => method === "Profiler.enable")).toHaveLength(1)
  for (const fn of fixture.cleanup.reverse()) fn()
  if (typeof fixture.stop === "function") await fixture.stop()
})
