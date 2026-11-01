import { expect, test } from "bun:test"
import {
  InferenceTraceBuffer,
  classifyInferenceError,
  startInferenceTrace,
} from "./inference-trace.ts"

test("records bounded stage timing and execution metadata without inference content", () => {
  let time = 10
  const buffer = new InferenceTraceBuffer()
  const trace = startInferenceTrace(
    {
      requestID: "request-1",
      jobID: "job-1",
      mode: "text",
      feature: "questions",
      configuredEP: "webgpu",
      configuredMaxTokens: 128,
    },
    (event) => buffer.record(event),
    () => time,
  )
  time += 4
  trace.mark("polled", { queueDepth: 0, active: true })
  time += 12
  trace.mark("prefill", { actualInputTokens: 42, inputShape: [1, 42], observedEP: "unknown" })
  time += 7
  trace.finish({ outputGeneratedTokens: 9, outputShape: [1, 9] })

  const events = buffer.snapshot()
  expect(events.map((event) => event.stage)).toEqual(["queued", "polled", "prefill", "complete"])
  expect(events[2]).toMatchObject({ elapsedMs: 16, deltaMs: 12, actualInputTokens: 42 })
  expect(events[3]).toMatchObject({ elapsedMs: 23, deltaMs: 7, outputGeneratedTokens: 9 })
  expect(events.every((event) => event.configuredEP === "webgpu")).toBe(true)
  expect(events.every((event) => event.observedEP === "unknown")).toBe(true)
  expect(JSON.stringify(events)).not.toContain("prompt")
  expect(JSON.stringify(events)).not.toContain("secret")
})

test("classifies context overflow while retaining only numeric capacity metadata", () => {
  const error = Object.assign(new Error("prompt text must never be retained"), {
    name: "ContextOverflowError",
    required: 5_000,
    capacity: 4_096,
  })
  expect(classifyInferenceError(error)).toEqual({
    kind: "context-overflow",
    name: "ContextOverflowError",
    requiredTokens: 5_000,
    capacityTokens: 4_096,
  })
  expect(JSON.stringify(classifyInferenceError(error))).not.toContain("prompt text")
})

test("keeps the trace ring bounded and clamps shapes and counters", () => {
  const buffer = new InferenceTraceBuffer(2)
  const trace = startInferenceTrace(
    { requestID: "request" },
    (event) => buffer.record(event),
    () => 0,
  )
  trace.mark("prefill", {
    actualInputTokens: Number.MAX_SAFE_INTEGER,
    inputShape: Array.from({ length: 12 }, () => Number.MAX_SAFE_INTEGER),
  })
  trace.finish({ outputGeneratedTokens: Number.MAX_SAFE_INTEGER })
  const events = buffer.snapshot()
  expect(events).toHaveLength(2)
  expect(events[0]!.inputShape).toEqual(Array.from({ length: 8 }, () => 1_000_000_000))
  expect(events[0]!.actualInputTokens).toBe(10_000_000)
  expect(events[1]!.outputGeneratedTokens).toBe(10_000_000)
})

test("supports a clocked runtime trace without inventing a request-stage event", () => {
  let time = 1_000
  const events: ReturnType<InferenceTraceBuffer["snapshot"]>[number][] = []
  const trace = startInferenceTrace(
    {
      requestID: "renderer:test",
      configuredEP: "unknown",
      observedEP: "unknown",
    },
    (event) => events.push(event),
    () => time,
    null,
  )

  time += 5_000
  trace.mark("renderer-lag", { rendererLagMs: 4_500, active: false })

  expect(events).toEqual([
    {
      requestID: "renderer:test",
      stage: "renderer-lag",
      elapsedMs: 5_000,
      deltaMs: 5_000,
      configuredEP: "unknown",
      observedEP: "unknown",
      rendererLagMs: 4_500,
      active: false,
    },
  ])
})
