import { Command, ComposerPill, Style } from "@opencode/plugin/gui"
import type { Plugin } from "@opencode/plugin/gui"
import { createEffect, createSignal } from "solid-js"
import type { InferenceRuntime } from "./runtime.ts"
import { createSpeechEventCoordinator, type SpeechEvent } from "./speech-events.ts"
import { latestCompletedResponse, speechSegments } from "./speech.ts"
import { playSpeech } from "./speech-playback.ts"

const AUTO_SPEECH_EVENTS = [
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.step.ended",
  "session.step.failed",
  "session.text.ended",
] as const

type CurrentSession = NonNullable<ReturnType<Parameters<Plugin.Setup>[0]["sessions"]["current"]>>

type Playback = {
  controller: AbortController
  visit: object
  kind: "manual" | "auto"
  queue: string[]
  audio?: AudioContext
}

export function registerReadAloud(ctx: Parameters<Plugin.Setup>[0], runtime: InferenceRuntime) {
  const [state, setState] = createSignal<"idle" | "loading" | "playing">("idle")
  const [automatic, setAutomatic] = createSignal(false)
  let operation: Playback | undefined
  let coordinator: ReturnType<typeof createSpeechEventCoordinator> | undefined
  let automaticAudio: AudioContext | undefined
  let activeEvents:
    | { visit: object; controller: AbortController; coordinator: NonNullable<typeof coordinator> }
    | undefined

  const stop = (suppressAuto = false) => {
    const previous = operation
    if (suppressAuto && previous?.kind === "auto") coordinator?.suppressCurrent()
    operation = undefined
    previous?.controller.abort()
    if (previous?.audio && previous.audio !== automaticAudio) {
      void previous.audio.close().catch(() => {})
    } else if (previous?.audio && !automatic()) {
      closeAutomaticAudio()
    } else if (previous?.audio) {
      void previous.audio.suspend().catch(() => {})
    }
    setState("idle")
  }

  const closeAutomaticAudio = () => {
    const playback = automaticAudio
    automaticAudio = undefined
    void playback?.close().catch(() => {})
  }

  const begin = (segments: readonly string[], kind: Playback["kind"], visit: object) => {
    if (!segments.length || !runtime.enabled("readAloud")) return
    if (operation?.kind === "auto" && kind === "auto" && operation.visit === visit) {
      operation.queue.push(...segments)
      return
    }
    if (operation) stop()
    const current: Playback = {
      controller: new AbortController(),
      visit,
      kind,
      queue: [...segments],
    }
    operation = current
    setState("loading")
    void (async () => {
      try {
        const playback =
          kind === "auto" ? (automaticAudio ??= new AudioContext()) : new AudioContext()
        current.audio = playback
        await playback.resume()
        current.controller.signal.throwIfAborted()
        while (operation === current && current.queue.length) {
          const batch = current.queue.splice(0)
          await playSpeech(batch, {
            signal: current.controller.signal,
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
        }
      } catch (error) {
        if (!current.controller.signal.aborted)
          ctx.toast.show({
            title: "Read aloud failed",
            description: String(error),
            variant: "error",
          })
      } finally {
        const playback = current.audio
        if (operation === current) {
          if (playback && playback === automaticAudio && automatic()) {
            operation = undefined
            setState("idle")
            void playback.suspend().catch(() => {})
          } else stop()
        } else if (playback && playback === automaticAudio) {
          if (automatic()) void playback.suspend().catch(() => {})
          else closeAutomaticAudio()
        } else void playback?.close().catch(() => {})
      }
    })()
  }

  const stopEvents = () => {
    const active = activeEvents
    activeEvents = undefined
    if (!active) return
    active.controller.abort()
    active.coordinator.dispose()
    if (coordinator === active.coordinator) coordinator = undefined
  }

  const syncAutoEvents = () => {
    const session = ctx.sessions.current()
    if (!runtime.enabled("readAloud") || !automatic() || !session) {
      stopEvents()
      return
    }
    if (activeEvents?.visit === session.visit) return
    stopEvents()
    const visit = session.visit
    const subscription = new AbortController()
    const isCurrent = () =>
      !ctx.signal.aborted && ctx.sessions.current()?.visit === visit && runtime.enabled("readAloud")
    const activeCoordinator = createSpeechEventCoordinator({
      sessionID: session.id,
      isCurrent,
      enabled: () => automatic(),
      speak: (segments) => {
        if (isCurrent() && automatic()) begin(segments, "auto", visit)
      },
    })
    activeEvents = { visit, controller: subscription, coordinator: activeCoordinator }
    coordinator = activeCoordinator
    void followSpeechEvents(session, activeCoordinator, subscription.signal)
  }

  const toggleAutomatic = () => {
    if (!runtime.enabled("readAloud")) return
    const next = !automatic()
    setAutomatic(next)
    if (next) {
      try {
        automaticAudio ??= new AudioContext()
        void automaticAudio.resume().catch(() => {})
      } catch {
        // Speech reports an unsupported or unavailable audio context when playback is attempted.
      }
    } else {
      if (operation?.kind === "auto") stop(true)
      closeAutomaticAudio()
    }
    syncAutoEvents()
  }

  const commandID = `${ctx.id}.auto-speech`
  ctx.add(Command, {
    id: "auto-speech",
    title: "Toggle automatic read aloud",
    description: "Speak final assistant prose as it arrives. Toggle to turn automatic speech off.",
    group: "LAZERS",
    section: "session",
    bind: "ctrl+shift+alt+s",
    editable: true,
    get enabled() {
      return runtime.enabled("readAloud")
    },
    run: toggleAutomatic,
  })

  createEffect(() => {
    const session = ctx.sessions.current()
    const enabled = runtime.enabled("readAloud")
    const auto = automatic()
    if (!enabled && operation) stop()
    if (!enabled) closeAutomaticAudio()
    if (!auto && operation?.kind === "auto") stop(true)
    if (operation && operation.visit !== session?.visit) stop()
    syncAutoEvents()
  })

  ctx.signal.addEventListener(
    "abort",
    () => {
      stop()
      stopEvents()
      closeAutomaticAudio()
    },
    { once: true },
  )
  ctx.add(ComposerPill, {
    id: "read-aloud",
    order: 21,
    show(input) {
      if (!runtime.enabled("readAloud")) return
      const active = operation?.visit === input.session.visit
      const response = latestCompletedResponse(
        input.session.server.data.session.message.list(input.session.id),
      )
      if (!speechSegments(response).length && !active) return
      return {
        label: "",
        title: `LAZERS speaker: ${active ? (state() === "loading" ? "preparing speech; click to stop" : state() === "playing" ? "reading response; click to stop" : "stop speech") : "read latest completed response"}`,
        run() {
          if (!runtime.enabled("readAloud")) return
          if (operation) {
            stop(true)
            return
          }
          const text = latestCompletedResponse(
            input.session.server.data.session.message.list(input.session.id),
          )
          begin(speechSegments(text), "manual", input.session.visit)
        },
      }
    },
  })
  ctx.add(ComposerPill, {
    id: "auto-speech",
    order: 22,
    show() {
      if (!runtime.enabled("readAloud")) return
      const shortcut = ctx.keybinds.keybind(commandID).join("+")
      return {
        label: `Auto ${automatic() ? "on" : "off"}`,
        title: `LAZERS automatic read aloud ${automatic() ? "on" : "off"}; shortcut ${shortcut}`,
        rows: [
          {
            id: "toggle",
            label: `Turn automatic read aloud ${automatic() ? "off" : "on"}`,
            run: toggleAutomatic,
          },
        ],
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

async function followSpeechEvents(
  session: CurrentSession,
  coordinator: ReturnType<typeof createSpeechEventCoordinator>,
  signal: AbortSignal,
) {
  let failure = 0
  while (!signal.aborted) {
    try {
      const stream = session.server.client.event.subscribe({ types: AUTO_SPEECH_EVENTS, signal })
      for await (const event of stream) {
        if (signal.aborted) return
        switch (event.type) {
          case "session.execution.started":
          case "session.execution.succeeded":
          case "session.execution.failed":
          case "session.execution.interrupted":
          case "session.step.ended":
          case "session.step.failed":
          case "session.text.ended":
            coordinator.handle(event as SpeechEvent)
            break
          default:
            break
        }
      }
      failure++
    } catch {
      if (signal.aborted) return
      failure++
    }
    await delay(signal, Math.min(250 * 2 ** Math.min(failure, 6), 15_000))
  }
}

function delay(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener("abort", finish, { once: true })
    if (signal.aborted) finish()
  })
}
