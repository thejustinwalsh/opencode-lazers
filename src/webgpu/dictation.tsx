import { Command, ComposerPill, Style } from "@opencode/plugin/gui"
import type { Plugin } from "@opencode/plugin/gui"
import { createEffect, createSignal } from "solid-js"
import { audioFilePCM16, MAX_AUDIO_SECONDS } from "./audio.ts"
import type { InferenceRuntime } from "./runtime.ts"
import { CaptureResources } from "./capture.ts"

export function registerDictation(ctx: Parameters<Plugin.Setup>[0], runtime: InferenceRuntime) {
  const [state, setState] = createSignal<"idle" | "permission" | "recording" | "transcribing">(
    "idle",
  )
  const [seconds, setSeconds] = createSignal(0)
  const [meterText, setMeterText] = createSignal("▁▁▁▁▁▁▁▁▁")
  let operation: AbortController | undefined
  let capture: CaptureResources | undefined
  let recordingVisit: object | undefined
  let heldKey: string | undefined
  const commandID = `${ctx.id}.dictate`
  const release = (resources: CaptureResources | undefined) => {
    resources?.release()
    if (capture !== resources) return
    setMeterText("▁▁▁▁▁▁▁▁▁")
  }
  const stop = () => {
    capture?.stop()
  }
  const cancel = () => {
    operation?.abort()
    stop()
    release(capture)
    capture = undefined
    setState("idle")
    heldKey = undefined
  }
  createEffect(() => {
    if (!runtime.enabled("dictation")) cancel()
    const visit = ctx.sessions.current()?.visit
    if (operation && recordingVisit && recordingVisit !== visit) cancel()
  })
  const toggle = () => {
    if (!runtime.enabled("dictation")) return
    if (state() === "recording") {
      stop()
      return
    }
    if (state() !== "idle") {
      cancel()
      return
    }
    const session = ctx.sessions.current()
    const screen = ctx.screen.current()
    if (!session || !screen) return
    const visit = session.visit
    operation = new AbortController()
    const controller = operation
    const resources = new CaptureResources()
    capture = resources
    recordingVisit = visit
    const current = () =>
      operation === controller &&
      ctx.sessions.current()?.visit === visit &&
      !controller.signal.aborted
    setState("permission")
    void (async () => {
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true },
          video: false,
        })
        if (controller.signal.aborted || !current()) {
          media.getTracks().forEach((track) => track.stop())
          return
        }
        resources.stream = media
        const meter = new AudioContext()
        resources.meter = meter
        await meter.resume()
        controller.signal.throwIfAborted()
        if (!current()) return
        const analyser = meter.createAnalyser()
        analyser.fftSize = 256
        meter.createMediaStreamSource(media).connect(analyser)
        const samples = new Float32Array(analyser.fftSize)
        let peakRMS = 0
        const recording = new MediaRecorder(media)
        resources.recorder = recording
        const chunks: Blob[] = []
        let bytes = 0
        const blob = await new Promise<Blob>((resolve, reject) => {
          recording.ondataavailable = (event) => {
            bytes += event.data.size
            if (bytes > 8_000_000) {
              controller.abort()
              resources.stop()
              reject(new Error("Recording exceeded the memory limit"))
              return
            }
            chunks.push(event.data)
          }
          recording.onerror = () => reject(new Error("Microphone recording failed"))
          recording.onstop = () => resolve(new Blob(chunks, { type: recording.mimeType }))
          setSeconds(0)
          const start = performance.now()
          resources.timer = setInterval(() => {
            analyser.getFloatTimeDomainData(samples)
            const rms = Math.sqrt(
              samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length,
            )
            peakRMS = Math.max(peakRMS, rms)
            const bars = "▁▂▃▄▅▆▇█"
            const level = Math.min(7, Math.floor(rms * 84))
            setMeterText((text) => text.slice(1) + bars[level])
            const elapsed = (performance.now() - start) / 1_000
            setSeconds(Math.floor(elapsed))
            if (elapsed >= MAX_AUDIO_SECONDS || !current()) resources.stop()
          }, 80)
          recording.start(250)
          setState("recording")
        })
        release(resources)
        controller.signal.throwIfAborted()
        if (!current()) return
        if (peakRMS < 0.0015) {
          ctx.toast.show({
            title: "No audio detected",
            description: "Nothing was added to the draft.",
          })
          return
        }
        setState("transcribing")
        const pcm = await audioFilePCM16(blob, true)
        controller.signal.throwIfAborted()
        let inserted = ""
        const result = await runtime.transcribe(
          pcm,
          (text) => {
            if (current()) {
              screen.composer.insert(text)
              inserted += text
            }
          },
          controller.signal,
        )
        if (!current()) return
        if (!result.ok) throw new Error(result.error)
        if (result.text.startsWith(inserted))
          screen.composer.insert(result.text.slice(inserted.length))
        else if (!inserted) screen.composer.insert(result.text)
      } catch (error) {
        if (!controller.signal.aborted) {
          ctx.toast.show({
            title: "Local dictation failed",
            description: String(error),
            variant: "error",
          })
        }
      } finally {
        release(resources)
        if (operation === controller) {
          capture = undefined
          operation = undefined
          setState("idle")
        }
      }
    })()
  }
  ctx.add(Command, {
    id: "dictate",
    title: "Push to talk locally",
    description:
      "Hold the shortcut to record; release to transcribe into the draft. Click the microphone to toggle recording.",
    group: "LAZERS",
    section: "prompt",
    bind: "ctrl+shift+space",
    editable: true,
    get enabled() {
      return runtime.enabled("dictation") && Boolean(ctx.sessions.current() && ctx.screen.current())
    },
    run() {
      if (heldKey && state() !== "idle") return
      toggle()
    },
  })
  window.addEventListener(
    "keydown",
    (event) => {
      if (!runtime.enabled("dictation")) return
      if (event.key === "Escape" && operation) {
        event.preventDefault()
        event.stopPropagation()
        cancel()
        return
      }
      if (!event.repeat && !event.isComposing && ctx.keybinds.matches(commandID, event))
        heldKey = event.code
    },
    { capture: true, signal: ctx.signal },
  )
  window.addEventListener(
    "keyup",
    (event) => {
      // The host can consume keydown before our listener. Match the public effective
      // binding on keyup as well, so hold-to-talk still releases in that case.
      if (
        !ctx.keybinds.matches(commandID, event) &&
        (!heldKey ||
          (event.code !== heldKey && !["Meta", "Control", "Alt", "Shift"].includes(event.key)))
      )
        return
      heldKey = undefined
      if (state() === "recording") stop()
      else if (state() === "permission") cancel()
    },
    { capture: true, signal: ctx.signal },
  )
  window.addEventListener(
    "blur",
    () => {
      if (state() === "recording" || state() === "permission") cancel()
    },
    { signal: ctx.signal },
  )
  ctx.signal.addEventListener("abort", cancel, { once: true })
  const microphone =
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 11v1a6 6 0 0 0 12 0v-1m-6 7v3m-3 0h6"/></svg>`,
    )
  const stopIcon =
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>`,
    )
  const spinner =
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.6"><path d="M12 4a8 8 0 1 1-8 8" stroke-linecap="round"/></svg>`,
    )
  ctx.add(ComposerPill, {
    id: "local-dictation",
    order: 20,
    show() {
      if (!runtime.enabled("dictation")) return
      const shortcut = ctx.keybinds.keybind(commandID).join("+")
      return {
        label:
          state() === "recording" ? `${meterText()} 0:${String(seconds()).padStart(2, "0")}` : "",
        title: `LAZERS microphone: ${state() === "recording" ? `recording ${seconds()}s; click to stop` : state() === "transcribing" ? "transcribing; click to cancel" : state() === "permission" ? "requesting access; click to cancel" : "start dictation"}. Hold ${shortcut} to talk; Escape cancels.`,
        run: toggle,
      }
    },
  })
  // The selector identifies only our public contribution by its own accessible name.
  // It does not move, inspect, or mutate the host's DOM.
  ctx.add(
    Style,
    `
    [data-composer-pill][aria-label^="LAZERS microphone:"] { display:inline-flex; align-items:center; justify-content:center; min-width:28px; min-height:28px; height:28px; padding:5px 6px; gap:5px; border-radius:14px; }
    [data-composer-pill][aria-label^="LAZERS microphone:"]::before { content:""; display:block; flex:none; width:15px; height:15px; background:currentColor; mask:url("${microphone}") center/contain no-repeat; }
    [data-composer-pill][aria-label^="LAZERS microphone:"] > span { font:12px/18px var(--font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace); font-variant-numeric:tabular-nums; letter-spacing:.3px; white-space:pre; }
    [data-composer-pill][aria-label^="LAZERS microphone:"] > span:empty { display:none; }
    [data-composer-pill][aria-label^="LAZERS microphone: recording"] { color:var(--icon-critical-base,#dc6666); }
    [data-composer-pill][aria-label^="LAZERS microphone: recording"]::before { mask-image:url("${stopIcon}"); }
    [data-composer-pill][aria-label^="LAZERS microphone: transcribing"]::before,
    [data-composer-pill][aria-label^="LAZERS microphone: requesting"]::before { mask-image:url("${spinner}"); animation:lazers-mic-spin 1s linear infinite; }
    @keyframes lazers-mic-spin { to { transform:rotate(360deg); } }
    @media(prefers-reduced-motion:reduce) { [data-composer-pill][aria-label^="LAZERS microphone:"]::before { animation:none; } }
  `,
  )
}
