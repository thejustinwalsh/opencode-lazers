import { expect, test } from "bun:test"
import { RuntimeTrace } from "./runtime-trace.ts"
import type { InferenceTraceEvent } from "./inference-trace.ts"

test("separates runtime and request clocks and detaches a terminal request immediately", () => {
  let time = 1_000
  const events: InferenceTraceEvent[] = []
  const trace = new RuntimeTrace(
    (event) => events.push(event),
    () => time,
    "renderer:test",
  )

  trace.mark("session-create")
  time = 5_000
  trace.rendererLag(3_500)

  const request = trace.begin({
    requestID: "request-1",
    jobID: "job-1",
    configuredEP: "webgpu",
    observedEP: "unknown",
  })
  time = 10_000
  request.mark("generate", { active: true })
  time = 20_000
  trace.rendererLag(9_500)
  time = 20_025
  request.finish({ active: false })

  expect(trace.hasActiveRequest).toBe(false)
  time = 30_000
  trace.rendererLag(9_500)

  const second = trace.begin({
    requestID: "request-2",
    jobID: "job-2",
    configuredEP: "webgpu",
    observedEP: "unknown",
  })
  time = 30_004
  second.mark("generate", { active: true })

  const [idleStage, idleLag, queued, generated, activeLag, terminal, postTerminalLag, next] = events
  expect(idleStage).toMatchObject({
    requestID: "renderer:test",
    stage: "session-create",
    elapsedMs: 0,
    deltaMs: 0,
    configuredEP: "webgpu",
    active: false,
  })
  expect(idleLag).toMatchObject({
    requestID: "renderer:test",
    stage: "renderer-lag",
    elapsedMs: 4_000,
    deltaMs: 4_000,
    rendererLagMs: 3_500,
    configuredEP: "unknown",
    observedEP: "unknown",
    active: false,
  })
  expect(queued).toMatchObject({ requestID: "request-1", jobID: "job-1", elapsedMs: 0, deltaMs: 0 })
  expect(generated).toMatchObject({ requestID: "request-1", elapsedMs: 5_000, deltaMs: 5_000 })
  expect(activeLag).toMatchObject({
    requestID: "request-1",
    jobID: "job-1",
    stage: "renderer-lag",
    elapsedMs: 15_000,
    deltaMs: 10_000,
    rendererLagMs: 9_500,
    configuredEP: "webgpu",
    observedEP: "unknown",
    active: true,
  })
  expect(terminal).toMatchObject({
    requestID: "request-1",
    stage: "complete",
    elapsedMs: 15_025,
    deltaMs: 25,
  })
  expect(postTerminalLag).toMatchObject({
    requestID: "renderer:test",
    stage: "renderer-lag",
    elapsedMs: 29_000,
    deltaMs: 25_000,
    rendererLagMs: 9_500,
    active: false,
  })
  expect(next).toMatchObject({
    requestID: "request-2",
    jobID: "job-2",
    stage: "queued",
    elapsedMs: 0,
    deltaMs: 0,
  })
  expect(events.every((event) => event.observedEP === "unknown")).toBe(true)
})
