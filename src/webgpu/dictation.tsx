import { Command, ComposerPill, Style } from "@opencode/plugin/gui"
import type { Plugin } from "@opencode/plugin/gui"
import { createEffect, createSignal } from "solid-js"
import { audioFilePCM16, MAX_AUDIO_SECONDS } from "./audio.ts"
import type { InferenceRuntime } from "./runtime.ts"
import { monitorAudioOwnership } from "./audio-ownership.ts"
import { CaptureResources } from "./capture.ts"
import { modifierTracker } from "./modifier-keys.ts"
import { MICROPHONE_PREFIX, pillSelector, pillTooltipCss } from "./pill-tooltip.ts"
import { normalizeASR } from "../verification/opencode/audio-fixture-contract.ts"
import { NativeAudioFixture } from "../verification/opencode/audio-fixture-ipc.ts"

export function registerDictation(ctx: Parameters<Plugin.Setup>[0], runtime: InferenceRuntime) {
  const audioFixture = ctx.main(NativeAudioFixture)
  const monitorOwnership = (
    controller: AbortController,
    requestID: string,
    sessionID: string,
  ): (() => void) => monitorAudioOwnership(audioFixture, controller, requestID, sessionID)
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
    const audioRoute = runtime.audioRoute()
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
      let fixture: Awaited<ReturnType<typeof audioFixture.takeDictation>> | null = null
      let fixtureReported = false
      let stopOwnershipMonitor: (() => void) | undefined
      const report = async (event: Parameters<typeof audioFixture.observe>[0]["event"]) => {
        if (!fixture) return
        await audioFixture.observe(
          { requestID: fixture.requestID, sessionID: session.id, event },
          { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(2_000)]) },
        )
      }
      try {
        let peakRMS = 0
        let blob: Blob
        const fixtureMode = await audioFixture.enabled({}, { signal: controller.signal })
        if (fixtureMode) {
          fixture = await audioFixture.takeDictation(
            { sessionID: session.id },
            { signal: controller.signal },
          )
        }
        if (fixture)
          stopOwnershipMonitor = monitorOwnership(controller, fixture.requestID, session.id)
        if (controller.signal.aborted || !current()) {
          if (fixture) {
            await report({ kind: "dictation-cancelled", fixtureID: fixture.fixtureID }).catch(
              () => {},
            )
            fixtureReported = true
          }
          return
        }
        if (fixtureMode && fixture === null) {
          throw new Error("No clean-clip dictation is armed; refusing microphone recording")
        }

        if (fixture) {
          if (audioRoute !== "runntime")
            throw new Error("Select ruNNtime Omni for this session before clean-clip dictation")
          await report({
            kind: "dictation-start",
            fixtureID: fixture.fixtureID,
            route: "runntime",
          })
          const bytes = Uint8Array.from(atob(fixture.audioBase64), (character) =>
            character.charCodeAt(0),
          )
          setSeconds(0)
          setMeterText("▆▆▆▆▆▆▆▆▆")
          blob = await new Promise<Blob>((resolve) => {
            const start = performance.now()
            resources.fixtureStop = () => {
              resources.fixtureStop = undefined
              resolve(new Blob([bytes], { type: "audio/wav" }))
            }
            resources.timer = setInterval(() => {
              const captureElapsed = performance.now() - start
              const displayElapsed = Math.min(captureElapsed, fixture!.durationMs)
              setSeconds(Math.floor(displayElapsed / 1_000))
              if (
                captureElapsed >= fixture!.durationMs ||
                captureElapsed >= MAX_AUDIO_SECONDS * 1_000 ||
                !current()
              )
                resources.stop()
            }, 80)
            setState("recording")
            if (!current()) resources.stop()
          })
          peakRMS = 1
        } else {
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
          const recording = new MediaRecorder(media)
          resources.recorder = recording
          const chunks: Blob[] = []
          let bytes = 0
          blob = await new Promise<Blob>((resolve, reject) => {
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
        }
        release(resources)
        controller.signal.throwIfAborted()
        if (!current()) return
        if (!fixture && peakRMS < 0.0015) {
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
        let insertionCalls = 0
        const insert = (text: string) => {
          if (!text || !current()) return
          screen.composer.insert(text)
          inserted += text
          insertionCalls++
        }
        const result = await runtime.transcribe(
          pcm,
          (text) => insert(text),
          controller.signal,
          audioRoute,
        )
        if (!current()) return
        if (!result.ok) throw new Error(result.error)
        if (result.text.startsWith(inserted)) insert(result.text.slice(inserted.length))
        else if (!inserted) insert(result.text)
        if (fixture) {
          await report({
            kind: "dictation-complete",
            fixtureID: fixture.fixtureID,
            matchesExpected: normalizeASR(result.text) === normalizeASR(fixture.transcript),
            insertedExactlyOnce: normalizeASR(inserted) === normalizeASR(fixture.transcript),
            insertionCalls,
            insertedChars: inserted.length,
            submitted: false,
          })
          fixtureReported = true
        }
      } catch (error) {
        if (fixture && !fixtureReported) {
          await report({
            kind: controller.signal.aborted ? "dictation-cancelled" : "dictation-failed",
            fixtureID: fixture.fixtureID,
          }).catch(() => {})
          fixtureReported = true
        }
        if (!controller.signal.aborted) {
          ctx.toast.show({
            title: "Local dictation failed",
            description: String(error),
            variant: "error",
          })
        }
      } finally {
        stopOwnershipMonitor?.()
        if (fixture && !fixtureReported) {
          await report({
            kind:
              controller.signal.aborted || !current() ? "dictation-cancelled" : "dictation-failed",
            fixtureID: fixture.fixtureID,
          }).catch(() => {})
        }
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
  const modifiers = modifierTracker(ctx)
  modifiers.onKeyDown((event) => {
    if (!runtime.enabled("dictation")) return
    if (event.key === "Escape" && operation) {
      event.preventDefault()
      event.stopPropagation()
      cancel()
      return
    }
    if (!event.repeat && !event.isComposing && ctx.keybinds.matches(commandID, event))
      heldKey = event.code
  })
  modifiers.onKeyUp((event) => {
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
  })
  modifiers.onBlur(() => {
    if (operation) cancel()
  })
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
        title: `${MICROPHONE_PREFIX} ${state() === "recording" ? `recording ${seconds()}s; click to stop` : state() === "transcribing" ? "transcribing; click to cancel" : state() === "permission" ? "requesting access; click to cancel" : "start dictation"}. Hold ${shortcut} to talk; Escape cancels.`,
        run: toggle,
      }
    },
  })
  // The selector identifies only our public contribution by its own accessible name.
  // It does not move, inspect, or mutate the host's DOM.
  ctx.add(
    Style,
    `
    ${pillSelector(MICROPHONE_PREFIX)} { display:inline-flex; align-items:center; justify-content:center; min-width:28px; min-height:28px; height:28px; padding:5px 6px; gap:5px; border-radius:14px; }
    ${pillSelector(MICROPHONE_PREFIX)}::before { content:""; display:block; flex:none; width:15px; height:15px; background:currentColor; mask:url("${microphone}") center/contain no-repeat; }
    ${pillSelector(MICROPHONE_PREFIX)} > span { font:12px/18px var(--font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace); font-variant-numeric:tabular-nums; letter-spacing:.3px; white-space:pre; }
    ${pillSelector(MICROPHONE_PREFIX)} > span:empty { display:none; }
    ${pillSelector(`${MICROPHONE_PREFIX} recording`)} { color:var(--icon-critical-base,#dc6666); }
    ${pillSelector(`${MICROPHONE_PREFIX} recording`)}::before { mask-image:url("${stopIcon}"); }
    ${pillSelector(`${MICROPHONE_PREFIX} transcribing`)}::before,
    ${pillSelector(`${MICROPHONE_PREFIX} requesting`)}::before { mask-image:url("${spinner}"); animation:lazers-mic-spin 1s linear infinite; }
    @keyframes lazers-mic-spin { to { transform:rotate(360deg); } }
    @media(prefers-reduced-motion:reduce) { ${pillSelector(MICROPHONE_PREFIX)}::before { animation:none; } }
    ${pillTooltipCss(MICROPHONE_PREFIX)}
  `,
  )
}
