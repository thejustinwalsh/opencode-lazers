import { expect, test } from "bun:test"
import type { InferenceTraceEvent } from "./inference-trace.ts"
import { RendererArmedCaptureManager } from "./renderer-armed-capture.ts"
import type { RendererDebugger } from "./renderer-debug.ts"

const validProfile = {
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
  startTime: 100,
  endTime: 10_100,
}

class FakeDebugger implements RendererDebugger {
  attached = false
  readonly calls: string[] = []
  readonly detachListeners = new Set<(event: unknown, reason: string) => void>()
  stopResponse: unknown = { profile: structuredClone(validProfile) }
  rejectMethod = ""
  holdStop = false
  resolveStop?: (result: unknown) => void

  isAttached() {
    return this.attached
  }

  attach() {
    this.calls.push("attach")
    if (this.attached) throw new Error("another debugger owns this renderer")
    this.attached = true
  }

  detach() {
    this.calls.push("detach")
    this.attached = false
  }

  on(_event: "detach", listener: (event: unknown, reason: string) => void) {
    this.detachListeners.add(listener)
    return this
  }

  removeListener(_event: "detach", listener: (event: unknown, reason: string) => void) {
    this.detachListeners.delete(listener)
    return this
  }

  externalDetach() {
    this.attached = false
    for (const listener of this.detachListeners) listener({}, "canceled_by_user")
  }

  async sendCommand(method: string, params?: Readonly<Record<string, unknown>>) {
    this.calls.push(method)
    if (method === "Profiler.setSamplingInterval") expect(params).toEqual({ interval: 10_000 })
    if (method === this.rejectMethod) throw new Error(`${method} refused`)
    if (method === "Profiler.stop") {
      if (this.holdStop) return new Promise((resolve) => (this.resolveStop = resolve))
      return this.stopResponse
    }
    return {}
  }
}

const trace = (overrides: Partial<InferenceTraceEvent> = {}) =>
  ({
    requestID: "request-1",
    jobID: "job-1",
    mode: "systemone",
    feature: "decisions",
    stage: "queued",
    elapsedMs: 0,
    deltaMs: 0,
    configuredEP: "webgpu",
    observedEP: "unknown",
    ...overrides,
  }) as InferenceTraceEvent

const fixture = (overrides: Record<string, unknown> = {}) => {
  const writes: { path: string; data: string }[] = []
  const manager = new RendererArmedCaptureManager({
    directory: "/diagnostics",
    makeDirectory: async () => {},
    write: async (path, data) => {
      writes.push({ path, data })
    },
    nextJobMs: 60_000,
    recordingMs: 60_000,
    ...overrides,
  })
  return { manager, writes }
}

const correlation = {
  windowID: 1,
  rendererPID: 4242,
  lastStage: "run",
  lastRequestID: "old-request",
  lastJobID: "old-job",
}

test("arms only after acknowledged start and freezes the next caller-window job correlation", async () => {
  const { manager, writes } = fixture()
  const transport = new FakeDebugger()
  manager.trace(1, trace({ requestID: "old-request", jobID: "old-job", stage: "queued" }))

  const armed = await manager.arm(1, { debugger: transport }, correlation)
  expect(armed.state).toBe("waiting")
  expect(armed.lastJobID).toBeUndefined()
  expect(transport.calls).toEqual([
    "attach",
    "Profiler.enable",
    "Profiler.setSamplingInterval",
    "Profiler.start",
  ])

  manager.trace(1, trace({ requestID: "runtime-only", jobID: undefined, stage: "run" }))
  manager.trace(2, trace({ requestID: "other-window", jobID: "job-other", stage: "queued" }))
  manager.trace(1, trace({ requestID: "old-request", jobID: "old-job", stage: "run" }))
  expect(manager.status(1).state).toBe("waiting")

  manager.trace(1, trace({ requestID: "request-next", jobID: "job-next", stage: "queued" }))
  expect(manager.status(1)).toMatchObject({
    state: "recording",
    lastRequestID: "request-next",
    lastJobID: "job-next",
  })
  manager.trace(1, trace({ requestID: "request-later", jobID: "job-later", stage: "queued" }))
  manager.trace(
    1,
    trace({
      requestID: "request-next",
      jobID: "job-next",
      stage: "run",
      elapsedMs: 40,
      deltaMs: 35,
    }),
  )
  manager.trace(
    1,
    trace({
      requestID: "request-next",
      jobID: "job-next",
      stage: "complete",
      elapsedMs: 90,
      deltaMs: 50,
    }),
  )
  const result = await manager.stop(1)

  expect(result).toMatchObject({
    state: "complete",
    captured: true,
    lastRequestID: "request-next",
    lastJobID: "job-next",
    lastStage: "complete",
    stopTrigger: "terminal",
    outcome: "captured",
    stageCount: 3,
  })
  expect(transport.calls).toEqual([
    "attach",
    "Profiler.enable",
    "Profiler.setSamplingInterval",
    "Profiler.start",
    "Profiler.stop",
    "detach",
  ])
  const metadata = JSON.parse(writes.find((write) => write.path.endsWith(".json"))!.data)
  expect(metadata).toMatchObject({
    windowID: 1,
    rendererPID: 4242,
    lastRequestID: "request-next",
    lastJobID: "job-next",
    lastStage: "complete",
    captured: true,
    profilePath: expect.stringContaining(".cpuprofile"),
    armedCapture: {
      stopTrigger: "terminal",
      outcome: "captured",
      targetRequestID: "request-next",
      targetJobID: "job-next",
      targetMode: "systemone",
      targetFeature: "decisions",
      stageHistory: [
        { stage: "queued", elapsedMs: 0, deltaMs: 0 },
        { stage: "run", elapsedMs: 40, deltaMs: 35 },
        { stage: "complete", elapsedMs: 90, deltaMs: 50 },
      ],
    },
  })
  expect(writes.some((write) => write.path.endsWith(".cpuprofile"))).toBe(true)
  await manager.shutdown()
})

test("a job that starts during profiler preparation is recorded as a failure, not a full capture", async () => {
  const { manager, writes } = fixture()
  const transport = new FakeDebugger()
  let resolveEnable!: () => void
  let reachedEnable!: () => void
  const enableReached = new Promise<void>((resolve) => (reachedEnable = resolve))
  transport.sendCommand = async (method) => {
    transport.calls.push(method)
    if (method === "Profiler.enable") {
      reachedEnable()
      await new Promise<void>((resolve) => (resolveEnable = resolve))
    }
    if (method === "Profiler.stop") return { profile: structuredClone(validProfile) }
    return {}
  }

  const arming = manager.arm(1, { debugger: transport }, correlation)
  await enableReached
  manager.trace(1, trace({ requestID: "race-request", jobID: "race-job", stage: "queued" }))
  resolveEnable()
  const result = await arming

  expect(result).toMatchObject({
    state: "complete",
    captured: false,
    reason: "job-started-during-arming",
    stopTrigger: "preparation-race",
    outcome: "failed",
    lastRequestID: "race-request",
    lastJobID: "race-job",
  })
  expect(writes.some((write) => write.path.endsWith(".cpuprofile"))).toBe(false)
  expect(
    JSON.parse(writes.find((write) => write.path.endsWith(".json"))!.data).armedCapture,
  ).toMatchObject({
    stopTrigger: "preparation-race",
    outcome: "failed",
    stageHistory: [{ stage: "queued" }],
  })
  expect(transport.calls.filter((method) => method === "Profiler.stop")).toHaveLength(1)
  expect(transport.calls.filter((method) => method === "detach")).toHaveLength(1)
})

test("refused profiler setup is meaningful and never detaches a pre-existing owner", async () => {
  const { manager, writes } = fixture()
  const transport = new FakeDebugger()
  transport.attached = true
  const result = await manager.arm(1, { debugger: transport }, correlation)
  expect(result).toMatchObject({
    state: "complete",
    captured: false,
    reason: "debugger-attached",
    failure: "attach",
    stopTrigger: "arming-failure",
    outcome: "failed",
  })
  expect(transport.calls).toEqual([])
  expect(transport.attached).toBe(true)
  expect(JSON.parse(writes[0]!.data)).toMatchObject({
    captured: false,
    reason: "debugger-attached",
  })
})

test("profiler-enable timeout is surfaced and a late setup reply cannot touch a new owner", async () => {
  const { manager, writes } = fixture({ prepareTimeoutMs: 100 })
  const transport = new FakeDebugger()
  let resolveEnable!: () => void
  transport.sendCommand = async (method) => {
    transport.calls.push(method)
    if (method === "Profiler.enable")
      await new Promise<void>((resolve) => (resolveEnable = resolve))
    return {}
  }

  const result = await manager.arm(9, { debugger: transport }, { ...correlation, windowID: 9 })
  expect(result).toMatchObject({
    captured: false,
    reason: "timeout",
    failure: "profiler-enable",
    stopTrigger: "arming-failure",
  })
  expect(transport.calls.filter((method) => method === "Profiler.start")).toHaveLength(0)
  expect(transport.calls.filter((method) => method === "detach")).toHaveLength(1)
  transport.attached = true
  resolveEnable()
  await Promise.resolve()
  expect(transport.attached).toBe(true)
  expect(transport.calls.filter((method) => method === "detach")).toHaveLength(1)
  expect(JSON.parse(writes[0]!.data)).toMatchObject({ captured: false, failure: "profiler-enable" })
})

test("late stop replies after timeout cannot repeat detach or turn failure into success", async () => {
  const { manager, writes } = fixture({ stopTimeoutMs: 20 })
  const transport = new FakeDebugger()
  transport.holdStop = true
  await manager.arm(1, { debugger: transport }, correlation)
  manager.trace(1, trace({ requestID: "target", jobID: "target-job", stage: "queued" }))

  const stopped = await manager.stop(1)
  expect(stopped).toMatchObject({
    state: "complete",
    captured: false,
    reason: "timeout",
    failure: "profiler-stop",
    stopTrigger: "manual-stop",
    lastRequestID: "target",
    lastJobID: "target-job",
  })
  expect(transport.calls.filter((method) => method === "Profiler.stop")).toHaveLength(1)
  expect(transport.calls.filter((method) => method === "detach")).toHaveLength(1)
  transport.attached = true // Another owner attaches after the capture has released its debugger.
  transport.resolveStop!({ profile: structuredClone(validProfile) })
  await Promise.resolve()
  expect(manager.status(1).captured).toBe(false)
  expect(transport.attached).toBe(true)
  expect(transport.calls.filter((method) => method === "detach")).toHaveLength(1)
  expect(JSON.parse(writes.find((write) => write.path.endsWith(".json"))!.data)).toMatchObject({
    captured: false,
    failure: "profiler-stop",
  })
})

test("an external debugger detach finalizes without detaching a subsequent owner", async () => {
  const { manager } = fixture()
  const transport = new FakeDebugger()
  await manager.arm(8, { debugger: transport }, { ...correlation, windowID: 8 })
  manager.trace(8, trace({ requestID: "owner-loss", jobID: "owner-loss-job", stage: "queued" }))
  transport.externalDetach()
  transport.attached = true // Simulate a new DevTools owner after Electron's detach event.
  await Promise.resolve()

  const result = await manager.stop(8)
  expect(result).toMatchObject({
    captured: false,
    reason: "lifecycle-lost",
    failure: "lifecycle",
    stopTrigger: "lifecycle-loss",
    lastRequestID: "owner-loss",
    lastJobID: "owner-loss-job",
  })
  expect(transport.attached).toBe(true)
  expect(transport.calls.filter((method) => method === "Profiler.stop")).toHaveLength(0)
  expect(transport.calls.filter((method) => method === "detach")).toHaveLength(0)
})

test("renderer close finalizes owned profiling and releases per-window state", async () => {
  const { manager, writes } = fixture()
  const transport = new FakeDebugger()
  await manager.arm(11, { debugger: transport }, { ...correlation, windowID: 11 })
  await manager.close(11)

  expect(manager.status(11)).toMatchObject({ state: "idle", stageCount: 0 })
  expect(transport.attached).toBe(false)
  expect(transport.calls.filter((method) => method === "Profiler.stop")).toHaveLength(1)
  expect(transport.calls.filter((method) => method === "detach")).toHaveLength(1)
  expect(JSON.parse(writes[0]!.data)).toMatchObject({
    captured: false,
    reason: "lifecycle-lost",
    failure: "lifecycle",
    armedCapture: { stopTrigger: "lifecycle-loss", outcome: "failed" },
  })
})

test("deadlines, manual disarm, and profile persistence failures remain bounded and truthful", async () => {
  const timed = fixture({ nextJobMs: 15 })
  const timerDebugger = new FakeDebugger()
  await timed.manager.arm(5, { debugger: timerDebugger }, { ...correlation, windowID: 5 })
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(timed.manager.status(5)).toMatchObject({
    captured: false,
    reason: "job-not-seen",
    failure: "job-wait",
    stopTrigger: "next-job-timeout",
  })
  expect(timerDebugger.attached).toBe(false)

  const manual = fixture()
  const manualDebugger = new FakeDebugger()
  await manual.manager.arm(6, { debugger: manualDebugger }, { ...correlation, windowID: 6 })
  expect(await manual.manager.stop(6)).toMatchObject({
    captured: false,
    reason: "manual-stop-before-job",
    stopTrigger: "manual-disarm",
    outcome: "failed",
  })

  const persistence = fixture({
    write: async (path: string) => {
      if (path.endsWith(".cpuprofile")) throw new Error("disk full")
    },
  })
  const persistenceDebugger = new FakeDebugger()
  await persistence.manager.arm(
    7,
    { debugger: persistenceDebugger },
    { ...correlation, windowID: 7 },
  )
  persistence.manager.trace(
    7,
    trace({ requestID: "persist", jobID: "persist-job", stage: "queued" }),
  )
  persistence.manager.trace(
    7,
    trace({ requestID: "persist", jobID: "persist-job", stage: "complete", elapsedMs: 10 }),
  )
  const failedPersistence = await persistence.manager.stop(7)
  expect(failedPersistence).toMatchObject({
    captured: false,
    reason: "error",
    failure: "profile",
    outcome: "failed",
  })
  await Promise.all([
    timed.manager.shutdown(),
    manual.manager.shutdown(),
    persistence.manager.shutdown(),
  ])
})

test("recording deadline can produce a valid profile and stage history remains bounded", async () => {
  const { manager, writes } = fixture({ recordingMs: 15 })
  const transport = new FakeDebugger()
  await manager.arm(10, { debugger: transport }, { ...correlation, windowID: 10 })
  manager.trace(10, trace({ requestID: "bounded", jobID: "bounded-job", stage: "queued" }))
  for (let index = 0; index < 70; index++)
    manager.trace(
      10,
      trace({
        requestID: "bounded",
        jobID: "bounded-job",
        stage: "run",
        elapsedMs: index + 1,
        deltaMs: 1,
      }),
    )
  await new Promise((resolve) => setTimeout(resolve, 30))
  const result = await manager.stop(10)
  expect(result).toMatchObject({
    captured: true,
    stopTrigger: "recording-timeout",
    stageCount: 64,
    stageHistoryDropped: 7,
  })
  const metadata = JSON.parse(writes.find((write) => write.path.endsWith(".json"))!.data)
  expect(metadata.armedCapture.stageHistory).toHaveLength(64)
  expect(metadata.armedCapture.stageHistory[0]).toMatchObject({ stage: "queued" })
  expect(metadata.armedCapture.stageHistoryDropped).toBe(7)
})
