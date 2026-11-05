import { expect, test } from "bun:test"
import type { SamplingProfile } from "bun:jsc"
import { captureServiceCPU, summarizeServiceProfile } from "./service-cpu-profile.ts"
import { ServiceCPUProfileOutput } from "./contract.ts"

const leaf = {
  sourceID: 1,
  name: "leaf",
  location: "bytecode",
  sourceURL: "/src/work.ts",
  line: 12,
  column: 3,
  category: "DFG",
  flags: 0,
}
const parent = { ...leaf, name: "caller", line: 20 }
const fixture = {
  functions: "unused report",
  bytecodes: "unused report",
  stackTraces: {
    interval: 0.001,
    sources: [{ sourceID: 1, url: "/src/work.ts", sourceText: "PRIVATE_BODY_CANARY" }],
    traces: [
      { timestamp: 1, frames: [leaf, parent, parent] },
      { timestamp: 2, frames: [leaf, parent, parent] },
      { timestamp: 3, frames: [parent] },
    ],
  },
} as unknown as SamplingProfile

test("service profile reports sampled metadata and counted stacks without source bodies", () => {
  const result = summarizeServiceProfile(fixture)
  expect(result.sampleCount).toBe(3)
  expect(
    result.frames.map(({ name, selfSamples, totalSamples }) => ({
      name,
      selfSamples,
      totalSamples,
    })),
  ).toEqual([
    { name: "leaf", selfSamples: 2, totalSamples: 2 },
    { name: "caller", selfSamples: 1, totalSamples: 3 },
  ])
  expect(result.stacks).toEqual([
    { frames: [0, 1, 1], samples: 2 },
    { frames: [1], samples: 1 },
  ])
  expect(JSON.stringify(result)).not.toContain("PRIVATE_BODY_CANARY")
  const legacy = {
    ...fixture,
    stackTraces: JSON.stringify(fixture.stackTraces),
  } as unknown as SamplingProfile
  expect(summarizeServiceProfile(legacy)).toEqual(result)
})

test("one service capture owns the profiler until abort cleanup finishes, then permits another", async () => {
  const controller = new AbortController()
  let started = 0
  let stopped = 0
  const dependencies = {
    sample: async (callback: () => Promise<void>, interval: number) => {
      expect(interval).toBe(1000)
      started++
      try {
        await callback()
        return fixture
      } finally {
        stopped++
      }
    },
    wait: (signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      }),
  }
  const capture = captureServiceCPU(controller.signal, dependencies)
  await expect(captureServiceCPU(new AbortController().signal, dependencies)).rejects.toThrow(
    "already active",
  )
  expect(started).toBe(1)
  controller.abort(new Error("registration disposed"))
  await expect(capture).rejects.toThrow("registration disposed")
  expect(stopped).toBe(1)
  const next = await captureServiceCPU(new AbortController().signal, {
    ...dependencies,
    wait: async () => {},
  })
  expect(ServiceCPUProfileOutput.safeParse(next).success).toBe(true)
  expect(next.requestedDurationMs).toBe(10000)
  expect(next.sampleCount).toBe(3)
  expect(started).toBe(2)
  expect(stopped).toBe(2)
})

test("profiler start failure releases its guard and pre-aborted capture never starts", async () => {
  let starts = 0
  const dependencies = {
    sample: async () => {
      starts++
      throw new Error("profile unavailable")
    },
    wait: async () => {},
  }
  await expect(captureServiceCPU(new AbortController().signal, dependencies)).rejects.toThrow(
    "profile unavailable",
  )
  const controller = new AbortController()
  controller.abort(new Error("request cancelled"))
  await expect(captureServiceCPU(controller.signal, dependencies)).rejects.toThrow(
    "request cancelled",
  )
  expect(starts).toBe(1)
  const next = await captureServiceCPU(new AbortController().signal, {
    sample: async () => fixture,
    wait: async () => {},
  })
  expect(next.sampleCount).toBe(3)
})
