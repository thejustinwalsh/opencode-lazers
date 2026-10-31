import { MAX_READ_BYTES, MODEL_FILES, modelURL } from "./manifest.ts"

type Read = (id: string, offset: number, length: number, signal?: AbortSignal) => Promise<string>

/** Four bounded reads in flight hide IPC latency; at most 8 MiB is prefetched. */
export async function* cachedRange(
  read: Read,
  id: string,
  start: number,
  end: number,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const controller = new AbortController()
  signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  signal.throwIfAborted()
  let offset = start
  const pending: Promise<{ value: Uint8Array } | { error: unknown }>[] = []
  const enqueue = () => {
    if (offset > end) return
    const at = offset
    const length = Math.min(MAX_READ_BYTES, end - offset + 1)
    offset += length
    pending.push(
      read(id, at, length, signal)
        .then((encoded) => {
          const decoded =
            typeof Uint8Array.fromBase64 === "function"
              ? Uint8Array.fromBase64(encoded)
              : Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
          if (decoded.byteLength !== length) throw new Error("Incomplete cache read")
          return { value: decoded }
        })
        .catch((error: unknown) => ({ error })),
    )
  }
  try {
    for (let i = 0; i < 4; i++) enqueue()
    while (pending.length) {
      signal?.throwIfAborted()
      const result = await pending.shift()!
      signal?.throwIfAborted()
      if ("error" in result) throw result.error
      yield result.value
      enqueue()
    }
  } finally {
    controller.abort()
  }
}

/** Adapt the engine's HTTP range reads to the plugin's verified on-disk cache. No renderer network fallback. */
export function cachedModelFetch(
  read: Read,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const request = new Request(input, init)
    request.signal.throwIfAborted()
    const lifetime = new AbortController()
    const signal = AbortSignal.any([request.signal, lifetime.signal])
    const file = MODEL_FILES.find((candidate) => modelURL(candidate.name) === request.url)
    if (!file) throw new Error("The WebGPU engine requested an unpinned resource")
    const headers = new Headers({
      "content-length": String(file.bytes),
      "accept-ranges": "bytes",
      etag: `"${file.sha256}"`,
    })
    if (request.method === "HEAD") return new Response(null, { headers })
    if (request.method !== "GET") throw new Error("Unsupported cached model operation")
    const range = request.headers.get("range")
    const match = range?.match(/^bytes=(\d+)-(\d+)$/)
    if (range && !match) throw new Error("Invalid cached model range")
    const start = match ? Number(match[1]) : 0
    const end = match ? Number(match[2]) : file.bytes - 1
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end >= file.bytes
    )
      return new Response(null, { status: 416 })
    headers.set("content-length", String(end - start + 1))
    if (match) headers.set("content-range", `bytes ${start}-${end}/${file.bytes}`)
    const chunks = cachedRange(read, file.id, start, end, signal)
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          request.signal.throwIfAborted()
          const chunk = await chunks.next()
          if (chunk.done) controller.close()
          else controller.enqueue(chunk.value)
        } catch (error) {
          lifetime.abort(error)
          controller.error(error)
        }
      },
      cancel: async () => {
        lifetime.abort()
        await chunks.return(undefined)
      },
    })
    return new Response(body, { headers, status: match ? 206 : 200 })
  }
}
