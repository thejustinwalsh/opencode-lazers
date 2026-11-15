import tgpu, { type TgpuRoot } from "typegpu"
import { createD1Decider, createLfm3Omni, initRunntime, models } from "runntime/zoo"
import type { Lfm3Omni, RangeSource, WeightCache } from "runntime/zoo"
import { cachedRange } from "./files-fetch.ts"
import {
  DECISION_FILES,
  MODEL_FILES,
  LFM3_TOKENIZER_REVISION,
  LFM3_TOKENIZER_URL,
} from "./manifest.ts"
import { CleanupUncertainError } from "./lifecycle.ts"

export type ModelFileID = (typeof MODEL_FILES)[number]["id"]
export type ModelFileRead = (
  id: string,
  offset: number,
  length: number,
  signal?: AbortSignal,
) => Promise<string>

/** Adapts the renderer's verified, lease-protected cache to ruNNtime's public half-open ranges. */
export function cachedModelRangeSource(
  id: ModelFileID | (typeof DECISION_FILES)[number]["id"],
  read: ModelFileRead,
  signal: AbortSignal,
): RangeSource {
  return {
    async read(begin, end) {
      if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end < begin)
        throw new Error("Invalid ruNNtime model byte range")
      signal.throwIfAborted()
      const expected = end - begin
      let bytes: Uint8Array | undefined
      let offset = 0
      for await (const chunk of cachedRange(read, id, begin, end - 1, signal)) {
        if (!bytes && chunk.byteLength === expected) bytes = chunk
        else {
          bytes ??= new Uint8Array(expected)
          bytes.set(chunk, offset)
        }
        offset += chunk.byteLength
      }
      signal.throwIfAborted()
      if (offset !== expected)
        throw new Error(`Verified model cache returned ${offset} of ${expected} requested bytes`)
      return bytes ?? new Uint8Array()
    },
  }
}

type LoadOptions = {
  read: ModelFileRead
  signal: AbortSignal
  onProgress?: (name: string, done: number, total: number) => void
}

const TOKENIZER_CACHE_ID = `lazers/lfm3-tokenizer/${LFM3_TOKENIZER_REVISION}`

/** Keeps only the fixed, non-weight tokenizer JSON in memory; GGUF ranges always stream from disk. */
class PinnedTokenizerCache implements WeightCache {
  #key: string | undefined
  #bytes: ArrayBuffer | undefined
  #loading: Promise<ArrayBuffer> | undefined

  async get(key: string): Promise<ArrayBuffer | undefined> {
    if (key !== this.#key || !this.#bytes) return undefined
    return this.#bytes.slice(0)
  }

  async getOrCompute(key: string, compute: () => Promise<ArrayBufferView>): Promise<ArrayBuffer> {
    if (!key.startsWith(`json/${TOKENIZER_CACHE_ID}`)) {
      const value = await compute()
      return value.buffer.slice(
        value.byteOffset,
        value.byteOffset + value.byteLength,
      ) as ArrayBuffer
    }
    if (this.#key === key && this.#bytes) return this.#bytes.slice(0)
    if (this.#loading) return (await this.#loading).slice(0)
    this.#key = key
    this.#loading = compute()
      .then(
        (value) =>
          value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer,
      )
      .then((bytes) => {
        this.#bytes = bytes
        return bytes
      })
      .finally(() => {
        this.#loading = undefined
      })
    return (await this.#loading).slice(0)
  }

  async deletePrefix(prefix: string): Promise<void> {
    if (this.#key?.startsWith(prefix)) this.#clear()
  }

  async clear(): Promise<void> {
    this.#clear()
  }

  #clear() {
    this.#key = undefined
    this.#bytes = undefined
    this.#loading = undefined
  }
}

const tokenizerCache = new PinnedTokenizerCache()

type OwnedRunntime<T extends { dispose(): Promise<void> }> = {
  engine: T
  lost: Promise<GPUDeviceLostInfo>
  dispose(): Promise<void>
  loseDevice(): void
}

function destroyAfterFailedLoad(root: TgpuRoot, cause: unknown): never {
  try {
    root.destroy()
  } catch (cleanupError) {
    throw new CleanupUncertainError({ dispose: async () => root.destroy() }, cleanupError, cause)
  }
  throw cause
}

async function initializeRoot(signal: AbortSignal): Promise<TgpuRoot> {
  signal.throwIfAborted()
  const root = await tgpu.init({ device: { optionalFeatures: ["shader-f16"] } })
  try {
    signal.throwIfAborted()
    initRunntime(root)
    return root
  } catch (error) {
    return destroyAfterFailedLoad(root, error)
  }
}

function owned<T extends { dispose(): Promise<void> }>(
  root: TgpuRoot,
  engine: T,
): OwnedRunntime<T> {
  let disposal: Promise<void> | undefined
  return {
    engine,
    lost: root.device.lost,
    loseDevice: () => root.device.destroy(),
    dispose: () => {
      if (disposal) return disposal
      disposal = Promise.resolve()
        .then(() => engine.dispose())
        .finally(() => root.destroy())
      return disposal
    },
  }
}

export async function loadRunntimeOmni({ read, signal, onProgress }: LoadOptions) {
  const root = await initializeRoot(signal)
  const ranges = new AbortController()
  const cancelLoad = () => ranges.abort(signal.reason)
  signal.addEventListener("abort", cancelLoad, { once: true })
  try {
    signal.throwIfAborted()
    const engine = await createLfm3Omni(
      {
        modelPath: cachedModelRangeSource("model", read, ranges.signal),
        projectorPath: cachedModelRangeSource("projector", read, signal),
        tokenizerPath: LFM3_TOKENIZER_URL,
        format: "gguf",
      },
      { signal, onProgress, cache: tokenizerCache, cacheId: TOKENIZER_CACHE_ID },
    )
    const result = owned(root, engine) satisfies OwnedRunntime<Lfm3Omni>
    return {
      ...result,
      dispose() {
        ranges.abort()
        return result.dispose()
      },
    }
  } catch (error) {
    ranges.abort()
    return destroyAfterFailedLoad(root, error)
  } finally {
    signal.removeEventListener("abort", cancelLoad)
  }
}

export async function loadRunntimeDecision({ read, signal, onProgress }: LoadOptions) {
  const root = await initializeRoot(signal)
  let tokenizerURL: string | undefined
  try {
    const tokenizer = await cachedModelRangeSource("tokenizer", read, signal).read(
      0,
      DECISION_FILES[1].bytes,
    )
    tokenizerURL = URL.createObjectURL(
      new Blob([new Uint8Array(tokenizer)], { type: "application/json" }),
    )
    const engine = await createD1Decider(
      {
        ...models.d1.D1_OMNI_600M.Q8,
        modelPath: cachedModelRangeSource("weights", read, signal),
        tokenizerPath: tokenizerURL,
      },
      { signal, onProgress },
    )
    return owned(root, engine)
  } catch (error) {
    return destroyAfterFailedLoad(root, error)
  } finally {
    if (tokenizerURL) URL.revokeObjectURL(tokenizerURL)
  }
}
