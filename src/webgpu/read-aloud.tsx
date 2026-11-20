import { Command, ComposerPill, Style } from "@opencode/plugin/gui"
import type { Plugin } from "@opencode/plugin/gui"
import { createEffect, createSignal } from "solid-js"
import type { InferenceRuntime } from "./runtime.ts"
import { createSpeechEventCoordinator, type SpeechEvent } from "./speech-events.ts"
import { latestCompletedResponse, speechSegments } from "./speech.ts"
import { playSpeech } from "./speech-playback.ts"
import { modifierTracker } from "./modifier-keys.ts"
import { sha256Text } from "../verification/opencode/audio-fixture-contract.ts"
import { NativeAudioFixture } from "../verification/opencode/audio-fixture-ipc.ts"
import type {
  AudioObservationEvent,
  PlaybackPlan,
} from "../verification/opencode/audio-fixture-contract.ts"
import { validateSpeechWav } from "./audio.ts"
import type { ChatRoute } from "./inference-route.ts"

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
  audioPlan?: PlaybackPlan
  segmentIndex: number
  route: ChatRoute
}

export function validateSpeechBuffer(buffer: AudioBuffer): void {
  if (
    !Number.isInteger(buffer.sampleRate) ||
    buffer.sampleRate !== 24_000 ||
    !Number.isInteger(buffer.length) ||
    buffer.length < 1 ||
    buffer.length > 24_000 * 30 ||
    !Number.isInteger(buffer.numberOfChannels) ||
    buffer.numberOfChannels < 1 ||
    buffer.numberOfChannels > 2 ||
    !Number.isFinite(buffer.duration) ||
    buffer.duration <= 0
  ) {
    throw new Error("The local model returned empty or non-24 kHz speech")
  }
  let hasSpeechSamples = false
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel)
    if (samples.length !== buffer.length)
      throw new Error("The local model returned malformed speech")
    for (const sample of samples) {
      if (!Number.isFinite(sample)) throw new Error("The local model returned non-finite speech")
      if (Math.abs(sample) > 0.00001) hasSpeechSamples = true
    }
  }
  if (!hasSpeechSamples) throw new Error("The local model returned silent speech")
}

export function registerReadAloud(ctx: Parameters<Plugin.Setup>[0], runtime: InferenceRuntime) {
  const audioFixture = ctx.main(NativeAudioFixture)
  const monitorOwnership = (controller: AbortController, plan: PlaybackPlan): (() => void) => {
    let checking = false
    const timer = setInterval(() => {
      if (checking || controller.signal.aborted) return
      checking = true
      void audioFixture
        .enabled(
          { requestID: plan.requestID, sessionID: plan.sessionID },
          { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3_000)]) },
        )
        .then((enabled) => {
          if (!enabled) controller.abort(new Error("Owned audio verification was lost"))
        })
        .catch((error: unknown) => controller.abort(error))
        .finally(() => {
          checking = false
        })
    }, 1_000)
    return () => clearInterval(timer)
  }
  const [state, setState] = createSignal<"idle" | "loading" | "playing">("idle")
  const [automatic, setAutomatic] = createSignal(false)
  let operation: Playback | undefined
  let manualPreflight: { controller: AbortController; visit: object } | undefined
  let coordinator: ReturnType<typeof createSpeechEventCoordinator> | undefined
  let automaticAudio: AudioContext | undefined
  let activeEvents:
    | { visit: object; controller: AbortController; coordinator: NonNullable<typeof coordinator> }
    | undefined

  const cancelPreflight = () => {
    const pending = manualPreflight
    if (!pending) return
    manualPreflight = undefined
    pending.controller.abort(new DOMException("Playback preflight was cancelled", "AbortError"))
    if (!operation) setState("idle")
  }

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

  const observeAudio = async (
    plan: PlaybackPlan,
    event: AudioObservationEvent,
    signal: AbortSignal = ctx.signal,
  ) => {
    await audioFixture.observe(
      { requestID: plan.requestID, sessionID: plan.sessionID, event },
      { signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]) },
    )
  }

  const begin = (
    segments: readonly string[],
    kind: Playback["kind"],
    visit: object,
    audioPlan?: PlaybackPlan,
    route: ChatRoute = runtime.audioRoute(),
  ) => {
    if (
      !segments.length ||
      !runtime.enabled("readAloud") ||
      ctx.signal.aborted ||
      ctx.sessions.current()?.visit !== visit
    )
      return false
    if (operation?.kind === "auto" && kind === "auto" && operation.visit === visit) {
      operation.queue.push(...segments)
      return true
    }
    if (operation) stop()
    const current: Playback = {
      controller: new AbortController(),
      visit,
      kind,
      queue: [...segments],
      ...(audioPlan === undefined ? {} : { audioPlan }),
      segmentIndex: 0,
      route,
    }
    operation = current
    const stopOwnershipMonitor = audioPlan
      ? monitorOwnership(current.controller, audioPlan)
      : undefined
    setState("loading")
    void (async () => {
      try {
        const playback =
          kind === "auto"
            ? (automaticAudio ??= new AudioContext({ sampleRate: 24_000 }))
            : new AudioContext({ sampleRate: 24_000 })
        current.audio = playback
        await playback.resume()
        current.controller.signal.throwIfAborted()
        if (audioPlan) {
          await observeAudio(
            audioPlan,
            {
              kind: "playback-start",
              route: "runntime",
              expectedTextHash: audioPlan.expectedTextHash,
              segmentHashes: audioPlan.segmentHashes,
            },
            current.controller.signal,
          )
        }
        while (operation === current && current.queue.length) {
          const batch = current.queue.splice(0)
          await playSpeech(batch, {
            signal: current.controller.signal,
            waiting: () => setState("loading"),
            async prepare(segment, signal) {
              const result = await runtime.speak(segment, signal, current.route)
              signal.throwIfAborted()
              if (!result.ok || !result.audioBase64)
                throw new Error(result.error || "The local model returned no speech")
              const bytes = Uint8Array.from(atob(result.audioBase64), (c) => c.charCodeAt(0))
              validateSpeechWav(bytes)
              const buffer = await playback.decodeAudioData(bytes.buffer)
              validateSpeechBuffer(buffer)
              return buffer
            },
            async play(buffer, signal) {
              signal.throwIfAborted()
              const segmentIndex = current.segmentIndex++
              const textHash = audioPlan?.segmentHashes[segmentIndex]
              if (audioPlan && textHash === undefined)
                throw new Error("Playback produced more speech segments than its armed plan")
              const details = {
                segmentIndex,
                textHash: textHash ?? "0".repeat(64),
                sampleRate: 24_000 as const,
                frames: buffer.length,
                durationMs: Math.max(1, Math.round(buffer.duration * 1_000)),
              }
              const source = playback.createBufferSource()
              source.buffer = buffer
              source.connect(playback.destination)
              setState("playing")
              const ended = Promise.withResolvers<void>()
              void ended.promise.catch(() => undefined)
              let settled = false
              const cleanup = () => {
                signal.removeEventListener("abort", abort)
                source.disconnect()
              }
              const abort = () => {
                if (settled) return
                settled = true
                try {
                  source.stop()
                } catch {
                  // The source can already be stopped while cancellation is dispatched.
                }
                cleanup()
                ended.reject(signal.reason)
              }
              source.onended = () => {
                if (settled) return
                settled = true
                cleanup()
                ended.resolve()
              }
              signal.addEventListener("abort", abort, { once: true })
              try {
                source.start()
              } catch (error) {
                settled = true
                cleanup()
                throw error
              }
              if (audioPlan) {
                await observeAudio(
                  audioPlan,
                  { kind: "playback-segment-start", ...details },
                  current.controller.signal,
                )
              }
              await ended.promise
              signal.throwIfAborted()
              if (audioPlan) {
                await observeAudio(
                  audioPlan,
                  { kind: "playback-segment-end", ...details },
                  current.controller.signal,
                )
              }
            },
          })
        }
        if (audioPlan) {
          if (current.segmentIndex !== audioPlan.segmentHashes.length)
            throw new Error("Playback ended without every expected speech segment")
          await observeAudio(audioPlan, { kind: "playback-complete" }, current.controller.signal)
        }
      } catch (error) {
        const cancelled = current.controller.signal.aborted || ctx.signal.aborted
        if (!cancelled) current.controller.abort(error)
        if (audioPlan) {
          await observeAudio(
            audioPlan,
            {
              kind: cancelled ? "playback-cancelled" : "playback-failed",
            },
            AbortSignal.timeout(2_000),
          ).catch(() => {})
        }
        if (!cancelled)
          ctx.toast.show({
            title: "Read aloud failed",
            description: String(error),
            variant: "error",
          })
      } finally {
        stopOwnershipMonitor?.()
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
    return true
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
        automaticAudio ??= new AudioContext({ sampleRate: 24_000 })
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

  const modifiers = modifierTracker(ctx)
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
    if (!enabled && manualPreflight) cancelPreflight()
    if (!enabled && operation) stop()
    if (!enabled) closeAutomaticAudio()
    if (!auto && operation?.kind === "auto") stop(true)
    if (operation && operation.visit !== session?.visit) stop()
    if (manualPreflight && manualPreflight.visit !== session?.visit) cancelPreflight()
    syncAutoEvents()
  })

  ctx.signal.addEventListener(
    "abort",
    () => {
      cancelPreflight()
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
      const phase = state()
      const active =
        operation?.visit === input.session.visit || manualPreflight?.visit === input.session.visit
      const response = latestCompletedResponse(
        input.session.server.data.session.message.list(input.session.id),
      )
      const hasResponse = speechSegments(response).length > 0
      const auto = automatic()
      const status = active
        ? phase === "loading"
          ? "preparing speech; click to stop"
          : phase === "playing"
            ? "reading response; click to stop"
            : "stop speech"
        : hasResponse
          ? "read the last response"
          : "no response to read yet"
      return {
        label: "",
        // Host icon for the automatic state: waveform bars beside the speaker. Shape, not colour
        // alone, tells idle, automatic and speaking apart (speaking swaps the speaker for a stop square).
        ...(auto ? { icon: "waveform" as const, tone: "success" as const } : {}),
        title: `LAZERS speaker: ${status}. Shift-click: automatic read aloud is ${auto ? "on" : "off"}.`,
        run() {
          if (!runtime.enabled("readAloud")) return
          if (modifiers.shift()) {
            toggleAutomatic()
            return
          }
          if (operation) {
            stop(true)
            return
          }
          if (manualPreflight) {
            cancelPreflight()
            return
          }
          const text = latestCompletedResponse(
            input.session.server.data.session.message.list(input.session.id),
          )
          const segments = speechSegments(text)
          if (!segments.length) return
          const route = runtime.audioRoute()
          const visit = input.session.visit
          const pending = { controller: new AbortController(), visit }
          manualPreflight = pending
          setState("loading")
          const signal = AbortSignal.any([ctx.signal, pending.controller.signal])
          const isCurrent = () => {
            const currentSession = ctx.sessions.current()
            return (
              !signal.aborted &&
              runtime.enabled("readAloud") &&
              currentSession?.id === input.session.id &&
              currentSession.visit === visit &&
              input.session.visit === visit
            )
          }
          const cancelStale = () => {
            if (isCurrent()) return
            if (!pending.controller.signal.aborted)
              pending.controller.abort(new DOMException("Playback session changed", "AbortError"))
            throw pending.controller.signal.reason
          }
          void (async () => {
            let plan: PlaybackPlan | null = null
            try {
              const fixtureMode = await audioFixture.enabled({}, { signal })
              cancelStale()
              if (fixtureMode) {
                plan = await audioFixture.takePlaybackPlan(
                  { sessionID: input.session.id },
                  { signal: AbortSignal.timeout(2_000) },
                )
                cancelStale()
              }
              if (plan) {
                if (route !== "runntime")
                  throw new Error(
                    "Select ruNNtime Omni for this session before playback verification",
                  )
                const segmentHashes = await Promise.all(segments.map(sha256Text))
                const expectedTextHash = await sha256Text(segments.join("\n"))
                cancelStale()
                if (
                  plan.expectedTextHash !== expectedTextHash ||
                  plan.segmentHashes.length !== segmentHashes.length ||
                  plan.segmentHashes.some((hash, index) => hash !== segmentHashes[index])
                ) {
                  throw new Error("The armed playback plan does not match this completed response")
                }
              }
              cancelStale()
              if (!begin(segments, "manual", visit, plan ?? undefined, route))
                throw new DOMException("Playback session changed", "AbortError")
              manualPreflight = undefined
            } catch (error) {
              const cancelled = signal.aborted || !isCurrent()
              if (plan) {
                await observeAudio(
                  plan,
                  { kind: cancelled ? "playback-cancelled" : "playback-failed" },
                  AbortSignal.timeout(2_000),
                ).catch(() => {})
              }
              if (!cancelled)
                ctx.toast.show({
                  title: "Read aloud failed",
                  description: String(error),
                  variant: "error",
                })
            } finally {
              if (manualPreflight === pending) {
                manualPreflight = undefined
                if (!operation) setState("idle")
              }
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
    [data-composer-pill][aria-label^="LAZERS speaker:"] { display:inline-flex; align-items:center; justify-content:center; min-width:28px; min-height:28px; height:28px; padding:5px 6px; gap:4px; border-radius:14px; }
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
    // A lost text boundary can hide an opening fence. Resume speech on the next
    // known execution start; the completed reply remains available for manual replay.
    coordinator.suppressCurrent()
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
