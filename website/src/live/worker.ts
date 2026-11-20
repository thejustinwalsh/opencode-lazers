/// <reference lib="webworker" />
/**
 * The inference worker: ruNNtime on WebGPU, off the main thread. The only network use is the
 * one-time weight download from Hugging Face in `weights.ts` plus the pinned tokenizer JSON
 * (cached in OPFS after the first visit). Prompts, answers, audio and transcripts never leave
 * this worker and the page.
 */
import tgpu from "typegpu"
import { createLfm3Omni, createOpfsCache, initRunntime, isRunntimeError } from "runntime/zoo"
import type { Lfm3Omni, WeightCache } from "runntime/zoo"
import { LFM3_TOKENIZER_REVISION, LFM3_TOKENIZER_URL } from "../../../src/webgpu/manifest"
import type { FromWorker, ToWorker } from "./protocol"
import { SYSTEM_PROMPT, MAX_NEW_TOKENS } from "./prompt"
import { speechSegments } from "./segments"
import { DownloadError, ensureWeights, isAbort, opfsRangeSource, weightsCached } from "./weights"

const post = (message: FromWorker, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer)

type Loaded = { engine: Lfm3Omni; root: Awaited<ReturnType<typeof tgpu.init>> }
let loaded: Loaded | undefined
let loading: AbortController | undefined
let job: AbortController | undefined
let speech: AbortController | undefined
/** Speech and generation share one GPU queue in the engine; this keeps their order explicit. */
let chain: Promise<unknown> = Promise.resolve()
const enqueue = <T>(run: () => Promise<T>) => {
  const next = chain.then(run, run)
  chain = next.catch(() => undefined)
  return next
}

const TOKENIZER_KEY = `json/lazers/lfm3-tokenizer/${LFM3_TOKENIZER_REVISION}`

/** Persists only the tokenizer JSON; the GGUF weights stream from OPFS ranges and are never cached
 *  a second time (same rule as the product's `PinnedTokenizerCache`). */
class TokenizerOnlyCache implements WeightCache {
  constructor(private readonly inner: WeightCache | undefined) {}
  #memory = new Map<string, ArrayBuffer>()
  private mine = (key: string) => key.startsWith(TOKENIZER_KEY)
  async get(key: string) {
    if (!this.mine(key)) return undefined
    return this.inner ? this.inner.get(key) : this.#memory.get(key)?.slice(0)
  }
  async getOrCompute(key: string, compute: () => Promise<ArrayBufferView>) {
    if (this.mine(key) && this.inner) return this.inner.getOrCompute(key, compute)
    const view = await compute()
    const bytes = view.buffer.slice(
      view.byteOffset,
      view.byteOffset + view.byteLength,
    ) as ArrayBuffer
    if (this.mine(key)) this.#memory.set(key, bytes)
    return bytes.slice(0)
  }
  async deletePrefix(prefix: string) {
    await this.inner?.deletePrefix(prefix)
    for (const key of this.#memory.keys()) if (key.startsWith(prefix)) this.#memory.delete(key)
  }
  async clear() {
    await this.inner?.clear()
    this.#memory.clear()
  }
}

const gpuMessage = (error: unknown) => {
  const text = error instanceof Error ? error.message : String(error)
  return /memory|allocate|buffer size|maxBufferSize|OOM/i.test(text)
    ? `This GPU ran out of memory for the model (${text}). Close other GPU-heavy tabs and retry; a GPU with about 3 GB free is needed.`
    : text
}

async function load() {
  if (loaded) {
    post({ t: "loaded", fromCache: true, ms: 0 })
    return
  }
  const controller = new AbortController()
  loading = controller
  const { signal } = controller
  const started = performance.now()
  try {
    if (!navigator.gpu) {
      post({ t: "loadFailed", reason: "unsupported", message: "WebGPU is not available." })
      return
    }
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) {
      post({
        t: "loadFailed",
        reason: "unsupported",
        message: "WebGPU is present but this browser found no usable graphics adapter.",
      })
      return
    }
    if (!navigator.storage?.getDirectory) {
      post({
        t: "loadFailed",
        reason: "storage",
        message: "This browser has no origin private file system, so the model cannot be stored.",
      })
      return
    }
    const cached = await weightsCached()
    if (!cached) await ensureWeights(signal, (files) => post({ t: "download", files }))
    signal.throwIfAborted()
    post({ t: "loading", fromCache: cached })
    const root = await tgpu.init({ device: { optionalFeatures: ["shader-f16"] } })
    try {
      initRunntime(root)
      const inner = await createOpfsCache("lazers-live-tokenizer").catch(() => undefined)
      const engine = await createLfm3Omni(
        {
          modelPath: opfsRangeSource("LFM3-Omni-2B-Q4_K_M.gguf"),
          projectorPath: opfsRangeSource("mmproj-LFM3-Omni-2B-Q8_0.gguf"),
          tokenizerPath: LFM3_TOKENIZER_URL,
          format: "gguf",
        },
        { signal, cache: new TokenizerOnlyCache(inner), cacheId: "lazers/lfm3-tokenizer" },
      )
      loaded = { engine, root }
      void root.device.lost.then((info) => {
        if (loaded?.root !== root) return
        loaded = undefined
        post({
          t: "deviceLost",
          message: `The GPU device was lost (${info.reason}): ${info.message}`,
        })
      })
      post({ t: "loaded", fromCache: cached, ms: Math.round(performance.now() - started) })
    } catch (error) {
      root.destroy()
      throw error
    }
  } catch (error) {
    if (isAbort(error) || signal.aborted || isRunntimeError(error, "LOAD_ABORTED")) {
      post({ t: "loadFailed", reason: "cancelled", message: "Stopped." })
    } else if (error instanceof DownloadError) {
      post({ t: "loadFailed", reason: error.reason, message: error.message })
    } else if (error instanceof DOMException && error.name === "QuotaExceededError") {
      post({
        t: "loadFailed",
        reason: "storage",
        message: "The browser ran out of storage space for this site.",
      })
    } else if (isRunntimeError(error, "UNSUPPORTED_DEVICE")) {
      post({ t: "loadFailed", reason: "unsupported", message: error.message })
    } else {
      post({ t: "loadFailed", reason: "gpu", message: gpuMessage(error) })
    }
  } finally {
    if (loading === controller) loading = undefined
  }
}

async function unload() {
  loading?.abort()
  job?.abort()
  speech?.abort()
  const current = loaded
  loaded = undefined
  await chain.catch(() => undefined)
  if (current) {
    await current.engine.dispose().catch(() => undefined)
    current.root.destroy()
  }
  post({ t: "unloaded" })
}

function generate(id: number, history: { role: "user" | "assistant"; content: string }[]) {
  return enqueue(async () => {
    const engine = loaded?.engine
    if (!engine) return post({ t: "genFailed", id, message: "The model is not loaded." })
    const controller = (job = new AbortController())
    const started = performance.now()
    try {
      const generation = engine.generate([{ role: "system", content: SYSTEM_PROMPT }, ...history], {
        maxNewTokens: MAX_NEW_TOKENS,
        signal: controller.signal,
      })
      for await (const text of generation) {
        controller.signal.throwIfAborted()
        post({ t: "token", id, text })
      }
      const result = await generation.result
      controller.signal.throwIfAborted()
      post({
        t: "genDone",
        id,
        text: result.text,
        ms: Math.round(performance.now() - started),
        tokens: result.completionTokens,
      })
    } catch (error) {
      if (!controller.signal.aborted) post({ t: "genFailed", id, message: gpuMessage(error) })
    } finally {
      if (job === controller) job = undefined
    }
  })
}

function speak(id: number, text: string) {
  const controller = (speech = new AbortController())
  return enqueue(async () => {
    const engine = loaded?.engine
    try {
      if (!engine) throw new Error("The model is not loaded.")
      for (const segment of speechSegments(text)) {
        controller.signal.throwIfAborted()
        const generation = engine.speak(segment, {
          temperature: 0.4,
          maxAudioFrames: 256,
          voice: { language: "American English", gender: "female" },
          signal: controller.signal,
        })
        for await (const samples of generation) {
          controller.signal.throwIfAborted()
          // Copy: the engine may reuse the chunk's buffer.
          const copy = new Float32Array(samples)
          post({ t: "speechChunk", id, samples: copy }, [copy.buffer])
        }
        await generation.result
      }
      controller.signal.throwIfAborted()
      post({ t: "speechEnd", id })
    } catch (error) {
      if (!controller.signal.aborted) post({ t: "speechFailed", id, message: gpuMessage(error) })
    } finally {
      if (speech === controller) speech = undefined
    }
  })
}

function transcribe(pcm: Float32Array) {
  return enqueue(async () => {
    const engine = loaded?.engine
    const controller = (job = new AbortController())
    try {
      if (!engine) throw new Error("The model is not loaded.")
      const text = await engine.transcribe(pcm, { maxNewTokens: 256, signal: controller.signal })
      controller.signal.throwIfAborted()
      post({ t: "transcribed", text: text.trim() })
    } catch (error) {
      if (!controller.signal.aborted) post({ t: "transcribeFailed", message: gpuMessage(error) })
    } finally {
      if (job === controller) job = undefined
    }
  })
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data
  switch (message.t) {
    case "load":
      void load()
      break
    case "cancelLoad":
      loading?.abort()
      break
    case "generate":
      void generate(message.id, message.history)
      break
    case "speak":
      void speak(message.id, message.text)
      break
    case "transcribe":
      void transcribe(message.pcm)
      break
    case "cancelJob":
      job?.abort()
      break
    case "stopSpeech":
      speech?.abort()
      break
    case "unload":
      void unload()
      break
  }
}
