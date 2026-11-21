/**
 * Main-thread side of the live chat, loaded only when the visitor first acts. It owns the worker,
 * speech playback (Web Audio) and microphone capture, performs the state machine's effects and
 * reports results back as events. No page text, audio or transcript is ever posted anywhere but
 * the worker on this same page.
 */
import { closeAudio, playbackContext, SPEECH_RATE } from "./audio-context"
import type { ChatEvent, Effect } from "./machine"
import type { FromWorker, ToWorker } from "./protocol"

export type Meter = { bars: string; seconds: number } | null
export type Controller = ReturnType<typeof createController>

const PCM_RATE = 16_000
const MAX_RECORD_SECONDS = 30
const BARS = "▁▂▃▄▅▆▇█"
import { FLAT_METER } from "./meter"

/** A quiet recording is dropped instead of sent to the model. */
const SILENCE_RMS = 0.0015

export function createController(
  emit: (event: ChatEvent) => void,
  onMeter: (meter: Meter) => void,
) {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })
  const post = (message: ToWorker, transfer: Transferable[] = []) =>
    worker.postMessage(message, transfer)

  /* ----- speech playback: gapless scheduling on one AudioContext ----- */
  let playhead = 0
  let speechID = -1
  let speechEnded = false
  let started = false
  const sources = new Set<AudioBufferSourceNode>()

  const context = playbackContext
  const stopPlayback = () => {
    for (const source of sources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // Already stopped.
      }
      source.disconnect()
    }
    sources.clear()
    speechID = -1
    started = false
    speechEnded = false
  }
  const finishIfDrained = () => {
    if (speechEnded && sources.size === 0) {
      speechID = -1
      emit({ t: "speechDone" })
    }
  }
  const playChunk = (samples: Float32Array) => {
    const ctx = context()
    const buffer = ctx.createBuffer(1, samples.length, SPEECH_RATE)
    buffer.copyToChannel(new Float32Array(samples), 0)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    playhead = Math.max(playhead, ctx.currentTime + 0.05)
    source.start(playhead)
    playhead += buffer.duration
    sources.add(source)
    source.onended = () => {
      sources.delete(source)
      source.disconnect()
      finishIfDrained()
    }
    if (!started) {
      started = true
      emit({ t: "speechPlaying" })
    }
  }

  /* ----- microphone ----- */
  type Capture = {
    stream?: MediaStream
    recorder?: MediaRecorder
    meter?: AudioContext
    timer?: ReturnType<typeof setInterval>
    cancelled: boolean
    chunks: Blob[]
    peak: number
  }
  let capture: Capture | undefined
  let audioId = 0
  const recordings = new Map<number, Float32Array>()

  const releaseCapture = () => {
    const current = capture
    if (!current) return
    clearInterval(current.timer)
    current.stream?.getTracks().forEach((track) => track.stop())
    void current.meter?.close().catch(() => undefined)
    capture = undefined
    onMeter(null)
  }

  async function record() {
    const current: Capture = (capture = { cancelled: false, chunks: [], peak: 0 })
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true },
        video: false,
      })
      current.stream = stream
      if (current.cancelled) return releaseCapture()
      const meter = (current.meter = new AudioContext())
      await meter.resume()
      const analyser = meter.createAnalyser()
      analyser.fftSize = 256
      meter.createMediaStreamSource(stream).connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      const recorder = (current.recorder = new MediaRecorder(stream))
      recorder.ondataavailable = (event) => current.chunks.push(event.data)
      recorder.onstop = () => void finishRecording(current)
      let bars = FLAT_METER
      const begin = performance.now()
      current.timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples)
        const rms = Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length)
        current.peak = Math.max(current.peak, rms)
        bars = bars.slice(1) + BARS[Math.min(7, Math.floor(rms * 84))]
        const seconds = (performance.now() - begin) / 1000
        onMeter({ bars, seconds: Math.floor(seconds) })
        if (seconds >= MAX_RECORD_SECONDS) recorder.state === "recording" && recorder.stop()
      }, 80)
      recorder.start(250)
      emit({ t: "recording" })
    } catch (error) {
      releaseCapture()
      if (current.cancelled) return
      const name = error instanceof DOMException ? error.name : ""
      if (name === "NotAllowedError" || name === "SecurityError")
        emit({ t: "micDenied", message: "permission denied" })
      else if (name === "NotFoundError") emit({ t: "micDenied", message: "no microphone found" })
      else emit({ t: "recordFailed", message: `Microphone recording failed: ${String(error)}` })
    }
  }

  async function finishRecording(current: NonNullable<typeof capture>) {
    const blob = new Blob(current.chunks, { type: current.recorder?.mimeType })
    const peak = current.peak
    const cancelled = current.cancelled
    releaseCapture()
    if (cancelled) return
    if (peak < SILENCE_RMS) return emit({ t: "recorded", audioId: -1, silent: true })
    try {
      const pcm = await decodeTo16k(blob)
      const id = ++audioId
      recordings.set(id, pcm)
      emit({ t: "recorded", audioId: id, silent: false })
    } catch (error) {
      emit({ t: "recordFailed", message: `The recording could not be decoded: ${String(error)}` })
    }
  }

  /* ----- worker events ----- */
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const m = event.data
    switch (m.t) {
      case "download":
        return emit({ t: "download", files: m.files })
      case "loading":
        return emit({ t: "loading", fromCache: m.fromCache })
      case "loaded":
        return emit({ t: "loaded", fromCache: m.fromCache })
      case "loadFailed":
        return m.reason === "unsupported"
          ? emit({
              t: "unsupported",
              message: `${m.message} The recorded session below shows what it does.`,
            })
          : emit({ t: "loadFailed", reason: m.reason, message: m.message })
      case "token":
        return emit({ t: "token", id: m.id, text: m.text })
      case "genDone":
        return emit({ t: "genDone", id: m.id, text: m.text })
      case "genFailed":
        return emit({ t: "genFailed", id: m.id, message: m.message })
      case "speechChunk":
        if (m.id === speechID) playChunk(m.samples)
        return
      case "speechEnd":
        if (m.id !== speechID) return
        speechEnded = true
        return finishIfDrained()
      case "speechFailed":
        if (m.id !== speechID) return
        stopPlayback()
        return emit({ t: "speechFailed", message: m.message })
      case "transcribed":
        return emit({ t: "transcribed", text: m.text })
      case "transcribeFailed":
        return emit({ t: "transcribeFailed", message: m.message })
      case "deviceLost":
        stopPlayback()
        return emit({ t: "deviceLost", message: m.message })
      case "unloaded":
        return emit({ t: "unloaded" })
    }
  }
  worker.onerror = (event) =>
    emit({
      t: "loadFailed",
      reason: "error",
      message: event.message || "The model worker failed to start.",
    })

  return {
    perform(effect: Effect) {
      switch (effect.t) {
        case "load":
          return post({ t: "load" })
        case "cancelLoad":
          return post({ t: "cancelLoad" })
        case "generate":
          return post({ t: "generate", id: effect.id, history: effect.history })
        case "cancelJob":
          return post({ t: "cancelJob" })
        case "speak":
          stopPlayback()
          speechID = effect.id
          return post({ t: "speak", id: effect.id, text: effect.text })
        case "stopSpeech":
          stopPlayback()
          return post({ t: "stopSpeech" })
        case "record":
          return void record()
        case "stopRecording":
          return capture?.recorder?.state === "recording" ? capture.recorder.stop() : undefined
        case "cancelRecording":
          if (capture) capture.cancelled = true
          if (capture?.recorder?.state === "recording") capture.recorder.stop()
          else releaseCapture()
          return
        case "transcribe": {
          const pcm = recordings.get(effect.audioId)
          recordings.delete(effect.audioId)
          if (!pcm) return emit({ t: "transcribeFailed", message: "The recording was lost." })
          return post({ t: "transcribe", pcm }, [pcm.buffer])
        }
        case "unload":
          stopPlayback()
          return post({ t: "unload" })
        case "focusComposer":
          return
      }
    },
    dispose() {
      stopPlayback()
      releaseCapture()
      worker.terminate()
      closeAudio()
    },
  }
}

/** Mono 16 kHz PCM for the model, resampled by an offline audio context (as the product does). */
async function decodeTo16k(blob: Blob): Promise<Float32Array> {
  const ctx = new AudioContext()
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer())
    const seconds = Math.min(decoded.duration, MAX_RECORD_SECONDS)
    const offline = new OfflineAudioContext(1, Math.ceil(seconds * PCM_RATE), PCM_RATE)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    return (await offline.startRendering()).getChannelData(0)
  } finally {
    await ctx.close()
  }
}
