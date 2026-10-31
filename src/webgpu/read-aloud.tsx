import { ComposerPill, Style } from "@opencode/plugin/gui"
import type { Plugin } from "@opencode/plugin/gui"
import { createEffect, createSignal } from "solid-js"
import type { InferenceRuntime } from "./runtime.ts"
import { latestResponse, speechSegments } from "./speech.ts"
import { playSpeech } from "./speech-playback.ts"

export function registerReadAloud(ctx: Parameters<Plugin.Setup>[0], runtime: InferenceRuntime) {
  const [state, setState] = createSignal<"idle" | "loading" | "playing">("idle")
  let operation: AbortController | undefined
  let visit: object | undefined
  let audio: AudioContext | undefined
  const stop = () => {
    operation?.abort()
    operation = undefined
    void audio?.close().catch(() => {})
    audio = undefined
    setState("idle")
  }
  createEffect(() => {
    if (!runtime.enabled("readAloud")) stop()
    if (operation && visit !== ctx.sessions.current()?.visit) stop()
  })
  ctx.signal.addEventListener("abort", stop, { once: true })
  ctx.add(ComposerPill, {
    id: "read-aloud",
    order: 21,
    show(input) {
      if (!runtime.enabled("readAloud")) return
      const response = latestResponse(
        input.session.server.data.session.message.list(input.session.id),
      )
      if (!speechSegments(response).length && !operation) return
      return {
        label: "",
        title: `LAZERS speaker: ${state() === "loading" ? "preparing speech; click to stop" : state() === "playing" ? "reading response; click to stop" : "read latest response"}`,
        run() {
          if (!runtime.enabled("readAloud")) return
          if (operation) {
            stop()
            return
          }
          const session = ctx.sessions.current()
          if (!session) return
          const text = latestResponse(session.server.data.session.message.list(session.id))
          const segments = speechSegments(text)
          if (!segments.length) return
          operation = new AbortController()
          const controller = operation
          visit = session.visit
          // Unlock playback during the user's gesture, before waiting for local inference.
          setState("loading")
          void (async () => {
            try {
              const playback = new AudioContext()
              audio = playback
              await playback.resume()
              await playSpeech(segments, {
                signal: controller.signal,
                waiting: () => setState("loading"),
                async prepare(segment, signal) {
                  const result = await runtime.speak(segment, signal)
                  signal.throwIfAborted()
                  if (!result.ok || !result.audioBase64)
                    throw new Error(result.error || "The local model returned no speech")
                  const bytes = Uint8Array.from(atob(result.audioBase64), (c) => c.charCodeAt(0))
                  return playback.decodeAudioData(bytes.buffer)
                },
                async play(buffer, signal) {
                  signal.throwIfAborted()
                  const source = playback.createBufferSource()
                  source.buffer = buffer
                  source.connect(playback.destination)
                  setState("playing")
                  await new Promise<void>((resolve, reject) => {
                    const abort = () => {
                      try {
                        source.stop()
                      } catch {
                        // The source may already have ended while cancellation was dispatched.
                      } finally {
                        source.disconnect()
                        signal.removeEventListener("abort", abort)
                        reject(signal.reason)
                      }
                    }
                    source.onended = () => {
                      source.disconnect()
                      signal.removeEventListener("abort", abort)
                      resolve()
                    }
                    signal.addEventListener("abort", abort, { once: true })
                    try {
                      source.start()
                    } catch (error) {
                      signal.removeEventListener("abort", abort)
                      source.disconnect()
                      reject(error)
                    }
                  })
                },
              })
            } catch (error) {
              if (!controller.signal.aborted)
                ctx.toast.show({
                  title: "Read aloud failed",
                  description: String(error),
                  variant: "error",
                })
            } finally {
              if (operation === controller) stop()
            }
          })()
        },
      }
    },
  })
  const svg = (body: string) =>
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`,
    )
  const speaker = svg('<path d="M11 5 6 9H3v6h3l5 4V5ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>')
  const square = svg('<rect x="7" y="7" width="10" height="10" rx="2" fill="black" stroke="none"/>')
  const spinner = svg('<path d="M12 4a8 8 0 1 1-8 8"/>')
  ctx.add(
    Style,
    `
    [data-composer-pill][aria-label^="LAZERS speaker:"] { display:inline-flex; align-items:center; justify-content:center; min-width:28px; min-height:28px; height:28px; padding:5px 6px; border-radius:14px; }
    [data-composer-pill][aria-label^="LAZERS speaker:"] > span:empty { display:none; }
    [data-composer-pill][aria-label^="LAZERS speaker:"]::before { content:""; display:block; width:15px; height:15px; background:currentColor; mask:url("${speaker}") center/contain no-repeat; }
    [data-composer-pill][aria-label^="LAZERS speaker: reading"]::before { mask-image:url("${square}"); }
    [data-composer-pill][aria-label^="LAZERS speaker: preparing"]::before { mask-image:url("${spinner}"); animation:lazers-speaker-spin 1s linear infinite; }
    @keyframes lazers-speaker-spin { to { transform:rotate(360deg); } }
    @media(prefers-reduced-motion:reduce) { [data-composer-pill][aria-label^="LAZERS speaker:"]::before { animation:none; } }
  `,
  )
}
