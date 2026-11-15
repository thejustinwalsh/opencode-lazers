import { expect, test } from "bun:test"
import { cachedRange } from "./files-fetch.ts"

test("cancelling a weight range aborts all prefetched IPC reads", async () => {
  const controller = new AbortController()
  let aborted = 0
  const started = Promise.withResolvers<void>()
  const read = async (_id: string, _offset: number, _length: number, signal?: AbortSignal) => {
    started.resolve()
    return new Promise<string>((_, reject) =>
      signal!.addEventListener(
        "abort",
        () => {
          aborted++
          reject(signal!.reason)
        },
        { once: true },
      ),
    )
  }
  const readRange = cachedRange(read, "model", 0, 10_000_000, controller.signal).next()
  await started.promise
  controller.abort(new Error("model changed"))
  await expect(readRange).rejects.toThrow("model changed")
  expect(aborted).toBe(4)
})

test("a failed cache range aborts prefetched sibling reads and propagates the original failure", async () => {
  let aborted = 0
  const read = async (_id: string, offset: number, _length: number, signal?: AbortSignal) => {
    if (!offset) throw new Error("cache changed")
    return new Promise<string>((_, reject) =>
      signal!.addEventListener(
        "abort",
        () => {
          aborted++
          reject(signal!.reason)
        },
        { once: true },
      ),
    )
  }
  const stream = cachedRange(read, "model", 0, 10_000_000)
  await expect(stream.next()).rejects.toThrow("cache changed")
  expect(aborted).toBe(3)
})
