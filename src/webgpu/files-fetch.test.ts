import { expect, test } from "bun:test"
import { cachedModelFetch, cachedRange } from "./files-fetch.ts"
import { MODEL_FILES, modelURL } from "./manifest.ts"

test("engine fetch reads pinned ranges through the cache and cannot fall back to the network", async () => {
  const calls: unknown[] = []
  const cached = cachedModelFetch(async (id, offset, length) => {
    calls.push({ id, offset, length })
    return Buffer.alloc(length, 42).toString("base64")
  })
  const url = modelURL(MODEL_FILES[0].name)
  const head = await cached(url, { method: "HEAD" })
  expect(head.headers.get("content-length")).toBe(String(MODEL_FILES[0].bytes))
  const response = await cached(url, { headers: { Range: "bytes=5-9" } })
  expect(response.status).toBe(206)
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([42, 42, 42, 42, 42]))
  expect(calls).toEqual([{ id: "model", offset: 5, length: 5 }])
  await expect(cached("https://example.com/arbitrary-file")).rejects.toThrow("unpinned")
  await expect(cached(url, { headers: { Range: "bytes=-10" } })).rejects.toThrow("range")
})

test("cancelling a cached response aborts all pending IPC reads without waiting for their data", async () => {
  let aborted = 0
  const started = Promise.withResolvers<void>()
  const cached = cachedModelFetch(async (_id, _offset, _length, signal) => {
    started.resolve()
    return new Promise((_, reject) =>
      signal!.addEventListener(
        "abort",
        () => {
          aborted++
          reject(signal!.reason)
        },
        { once: true },
      ),
    )
  })
  const response = await cached(modelURL(MODEL_FILES[0].name))
  await started.promise
  await response.body!.cancel()
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
