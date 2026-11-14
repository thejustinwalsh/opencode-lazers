import tgpu, { type TgpuRoot } from "typegpu"
import { createLfm3Audio, createLfm3Chat, initRunntime } from "runntime/zoo"
import type { Lfm3Audio, Lfm3ChatSession, RangeSource, WeightCache } from "runntime/zoo"
import { cachedRange } from "./files-fetch.ts"
import { MODEL_FILES, LFM3_TOKENIZER_REVISION, LFM3_TOKENIZER_URL } from "./manifest.ts"
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
  id: ModelFileID,
  read: ModelFileRead,
  signal: AbortSignal,
): RangeSource {
  return {
    async read(begin, end) {
      if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end < begin)
        throw new Error("Invalid ruNNtime model byte range")
      signal.throwIfAborted()
      const expected = end - begin
      const chunks: Uint8Array[] = []
      let received = 0
      for await (const chunk of cachedRange(read, id, begin, end - 1, signal)) {
        received += chunk.byteLength
        chunks.push(chunk)
      }
      signal.throwIfAborted()
      if (received !== expected)
        throw new Error(`Verified model cache returned ${received} of ${expected} requested bytes`)
      const bytes = new Uint8Array(expected)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return bytes
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

export async function loadRunntimeChat({ read, signal, onProgress }: LoadOptions) {
  const root = await initializeRoot(signal)
  try {
    const engine = await createLfm3Chat(
      {
        modelPath: cachedModelRangeSource("model", read, signal),
        tokenizerPath: LFM3_TOKENIZER_URL,
        format: "gguf",
      },
      { signal, onProgress, cache: tokenizerCache, cacheId: TOKENIZER_CACHE_ID },
    )
    return owned(root, engine) satisfies OwnedRunntime<Lfm3ChatSession>
  } catch (error) {
    return destroyAfterFailedLoad(root, error)
  }
}

export async function loadRunntimeAudio({ read, signal, onProgress }: LoadOptions) {
  const root = await initializeRoot(signal)
  try {
    const engine = await createLfm3Audio(
      {
        modelPath: cachedModelRangeSource("model", read, signal),
        projectorPath: cachedModelRangeSource("projector", read, signal),
        tokenizerPath: LFM3_TOKENIZER_URL,
        format: "gguf",
      },
      { signal, onProgress, cache: tokenizerCache, cacheId: TOKENIZER_CACHE_ID },
    )
    return owned(root, engine) satisfies OwnedRunntime<Lfm3Audio>
  } catch (error) {
    return destroyAfterFailedLoad(root, error)
  }
}
