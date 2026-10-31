import { expect, test } from "bun:test"
import { ExclusiveModels, retryLoad } from "./lifecycle.ts"

test("model switching releases the previous GPU before any next allocation, including concurrent calls", async () => {
  const slots = new ExclusiveModels<{
    chat: { dispose(): Promise<void> }
    decision: { dispose(): Promise<void> }
  }>()
  const log: string[] = []
  let resident = 0
  const load = (name: string) => async () => {
    expect(resident).toBe(0)
    resident++
    log.push(`load ${name}`)
    return {
      dispose: async () => {
        await Promise.resolve()
        log.push(`dispose ${name}`)
        resident--
      },
    }
  }
  const signal = new AbortController().signal
  await slots.ensure("chat", load("chat"), signal)
  await Promise.all([
    slots.ensure("decision", load("decision"), signal),
    slots.ensure("chat", load("chat"), signal),
  ])
  expect(resident).toBe(1)
  expect(log).toEqual([
    "load chat",
    "dispose chat",
    "load decision",
    "dispose decision",
    "load chat",
  ])
  await slots.release()
  expect(resident).toBe(0)
})

test("cleanup failure prevents another allocation; cancellation disposes a newly loaded model", async () => {
  const slots = new ExclusiveModels<{
    a: { dispose(): Promise<void> }
    b: { dispose(): Promise<void> }
  }>()
  const controller = new AbortController()
  await slots.ensure(
    "a",
    async () => ({
      dispose: async () => {
        throw new Error("cleanup failed")
      },
    }),
    controller.signal,
  )
  let allocated = false
  await expect(
    slots.ensure(
      "b",
      async () => {
        allocated = true
        return { dispose: async () => {} }
      },
      controller.signal,
    ),
  ).rejects.toThrow("cleanup failed")
  expect(allocated).toBe(false)
  expect(slots.get("a")).toBeUndefined()
  expect(slots.isTainted()).toBe(true)
  await expect(
    slots.ensure(
      "a",
      async () => {
        allocated = true
        return { dispose: async () => {} }
      },
      controller.signal,
    ),
  ).rejects.toThrow("cleanup failed")
  expect(allocated).toBe(false)
  const fresh = new ExclusiveModels<{ a: { dispose(): Promise<void> } }>()
  let cleaned = false
  await expect(
    fresh.ensure(
      "a",
      async () => {
        controller.abort()
        return {
          dispose: async () => {
            cleaned = true
          },
        }
      },
      controller.signal,
    ),
  ).rejects.toThrow()
  expect(cleaned).toBe(true)
  expect(fresh.current()).toBeUndefined()
})

test("loading retries only a bounded transient error and never retries invalid models", async () => {
  let attempts = 0
  await expect(
    retryLoad(
      async () => {
        attempts++
        throw new Error("Invalid model checksum")
      },
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow("checksum")
  expect(attempts).toBe(1)
  attempts = 0
  await expect(
    retryLoad(
      async () => {
        attempts++
        throw new Error("GPU device lost")
      },
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow("lost")
  expect(attempts).toBe(2)
})
