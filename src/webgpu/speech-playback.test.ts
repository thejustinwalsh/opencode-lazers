import { expect, test } from "bun:test"
import { playSpeech } from "./speech-playback.ts"

test("speech prepares exactly one chunk ahead during ordered playback", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const events: string[] = []
  let waits = 0
  const running = playSpeech(["one", "two", "three"], {
    signal: new AbortController().signal,
    waiting: () => {
      waits++
    },
    prepare: async (text) => {
      events.push(`prepare ${text}`)
      return text
    },
    play: async (text) => {
      events.push(`play ${text}`)
      if (text === "one") {
        started.resolve()
        await release.promise
      }
    },
  })
  await started.promise
  expect(events).toEqual(["prepare one", "prepare two", "play one"])
  release.resolve()
  await running
  expect(events).toEqual([
    "prepare one",
    "prepare two",
    "play one",
    "prepare three",
    "play two",
    "play three",
  ])
  expect(waits).toBe(1)
})

test("a prefetched generation failure waits for current speech to finish before surfacing", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const played: string[] = []
  const running = playSpeech(["one", "bad", "never"], {
    signal: new AbortController().signal,
    waiting: () => {},
    prepare: async (text) => {
      if (text === "bad") throw Error("Speech failed")
      return text
    },
    play: async (text) => {
      started.resolve()
      await release.promise
      played.push(text)
    },
  })
  await started.promise
  expect(played).toEqual([])
  release.resolve()
  await expect(running).rejects.toThrow("Speech failed")
  expect(played).toEqual(["one"])
})

test("stop cancels current playback and prefetched inference without starting later chunks", async () => {
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  const prepared: string[] = []
  let cancelled = false
  const untilAbort = (signal: AbortSignal) =>
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
  const running = playSpeech(["one", "two", "never"], {
    signal: controller.signal,
    waiting: () => {},
    prepare: async (text, signal) => {
      prepared.push(text)
      if (text === "two") {
        try {
          await untilAbort(signal)
        } finally {
          cancelled = true
        }
      }
      return text
    },
    play: async (_, signal) => {
      started.resolve()
      await untilAbort(signal)
    },
  })
  await started.promise
  controller.abort(new Error("Stopped"))
  await expect(running).rejects.toThrow("Stopped")
  expect(prepared).toEqual(["one", "two"])
  expect(cancelled).toBe(true)
})
