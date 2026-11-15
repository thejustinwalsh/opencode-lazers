import { MAX_READ_BYTES } from "./manifest.ts"

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
