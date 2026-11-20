import { expect, test } from "bun:test"
import { Window } from "happy-dom"
import type { OpenCodeEvent } from "@opencode/client"
import { createRoot, createSignal } from "solid-js"
import { Command, ComposerPill } from "@opencode/plugin/gui"
import { registerReadAloud, validateSpeechBuffer } from "../../src/webgpu/read-aloud.tsx"
import type { InferenceRuntime } from "../../src/webgpu/runtime.ts"
import { speechSegments } from "../../src/webgpu/speech.ts"
import { wavBase64 } from "../../src/webgpu/audio.ts"
import { sha256Text } from "../../src/verification/opencode/audio-fixture-contract.ts"
import type {
  AudioObservationEvent,
  PlaybackPlan,
} from "../../src/verification/opencode/audio-fixture-contract.ts"

type EventPayload = { resolve(value: IteratorResult<OpenCodeEvent>): void; signal: AbortSignal }
type PillView = {
  label: string
  title: string
  icon?: string
  tone?: string
  rows?: readonly { run?: () => void }[]
  run?: () => void
}
type NativePill = { show(input: unknown): PillView | undefined }
type NativeCommand = { run?: () => void }
type ReadAloudHarnessOptions = {
  takePlaybackPlan?: () => Promise<PlaybackPlan | null>
  observe?: (event: AudioObservationEvent, signal?: AbortSignal) => Promise<void>
}

class EventChannel {
  private events: OpenCodeEvent[] = []
  private waiters: EventPayload[] = []
  private closed = false
  private subscriptions = 0
  private subscriptionWaiters: Array<{ count: number; ready: PromiseWithResolvers<void> }> = []

  subscribe = ({ signal }: { signal: AbortSignal }): AsyncIterable<OpenCodeEvent> => {
    this.subscriptions++
    this.closed = false
    this.subscriptionWaiters = this.subscriptionWaiters.filter((waiter) => {
      if (waiter.count > this.subscriptions) return true
      waiter.ready.resolve()
      return false
    })
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const event = this.events.shift()
          if (event) return Promise.resolve({ done: false, value: event })
          if (signal.aborted || this.closed)
            return Promise.resolve({ done: true, value: undefined })
          return new Promise<IteratorResult<OpenCodeEvent>>((resolve) => {
            const waiter = { resolve, signal }
            this.waiters.push(waiter)
            signal.addEventListener(
              "abort",
              () => {
                this.waiters = this.waiters.filter((item) => item !== waiter)
                resolve({ done: true, value: undefined })
              },
              { once: true },
            )
          })
        },
        return: async () => ({ done: true, value: undefined }),
      }),
    }
  }

  waitForSubscription(count: number): Promise<void> {
    if (this.subscriptions >= count) return Promise.resolve()
    const ready = Promise.withResolvers<void>()
    this.subscriptionWaiters.push({ count, ready })
    return ready.promise
  }

  endStream() {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined })
  }

  publish(event: OpenCodeEvent) {
    while (this.waiters.length) {
      const waiter = this.waiters.shift()!
      if (waiter.signal.aborted) continue
      waiter.resolve({ done: false, value: event })
      return
    }
    this.events.push(event)
  }
}

let audioStarted: PromiseWithResolvers<void>
let sourceStops = 0
let naturalEnd = false

class FakeAudioContext {
  readonly destination = {} as AudioDestinationNode
  async resume() {}
  async suspend() {}
  async close() {}
  async decodeAudioData() {
    return {
      sampleRate: 24_000,
      length: 4_800,
      duration: 0.2,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(4_800).fill(0.1),
    } as AudioBuffer
  }
  createBufferSource() {
    const source: {
      buffer: AudioBuffer | null
      onended: ((event: Event) => void) | null
      connect(): void
      disconnect(): void
      start(): void
      stop(): void
    } = {
      buffer: null as AudioBuffer | null,
      onended: null as ((event: Event) => void) | null,
      connect() {},
      disconnect() {},
      start() {
        audioStarted.resolve()
        if (naturalEnd) queueMicrotask(() => source.onended?.(new Event("ended")))
      },
      stop() {
        sourceStops++
      },
    }
    return source as unknown as AudioBufferSourceNode
  }
}

let eventSequence = 0
function event(type: string, data: Record<string, unknown>): OpenCodeEvent {
  const sequence = ++eventSequence
  return {
    id: `${type}-${sequence}`,
    created: 1,
    type,
    durable: { aggregateID: "session", seq: sequence, version: 1 },
    data: { sessionID: "session", ...data },
  } as unknown as OpenCodeEvent
}

function setup(
  audioPlan?: PlaybackPlan,
  audioRoute: "liquid" | "runntime" = "liquid",
  options: ReadAloudHarnessOptions = {},
) {
  audioStarted = Promise.withResolvers<void>()
  sourceStops = 0
  naturalEnd = false
  const audioObservations: AudioObservationEvent[] = []
  const messages: unknown[] = [
    {
      type: "assistant",
      finish: "stop",
      time: { created: 1, completed: 2 },
      content: [{ type: "text", text: "The last completed answer." }],
    },
    { type: "idle", outcome: "succeeded", time: { created: 3 } },
    { type: "user", text: "A newer request is running.", time: { created: 4 } },
  ]
  const channel = new EventChannel()
  const session = {
    id: "session",
    key: "server\nsession",
    visit: {},
    server: {
      data: { session: { message: { list: () => messages } } },
      client: { event: { subscribe: channel.subscribe } },
    },
  }
  const [currentSession, setCurrentSession] = createSignal(session)
  const abort = new AbortController()
  const pills = new Map<string, NativePill>()
  let autoCommand: NativeCommand | undefined
  const ctx = {
    id: "lazers",
    signal: abort.signal,
    sessions: { current: currentSession },
    keybinds: { keybind: () => ["ctrl", "shift", "alt", "s"] },
    toast: { show() {} },
    main: () => ({
      enabled: async () => audioPlan !== undefined || options.takePlaybackPlan !== undefined,
      takePlaybackPlan: async () =>
        options.takePlaybackPlan ? options.takePlaybackPlan() : (audioPlan ?? null),
      observe: async (
        { event }: { event: AudioObservationEvent },
        { signal }: { signal?: AbortSignal },
      ) => {
        await options.observe?.(event, signal)
        audioObservations.push(event)
      },
    }),
    add(registry: unknown, item: unknown) {
      const contribution = item as { id: string } & NativePill & NativeCommand
      if (registry === ComposerPill) pills.set(contribution.id, contribution)
      if (registry === Command) autoCommand = contribution
    },
  }
  const calls: Array<{ text: string; signal: AbortSignal; route?: string }> = []
  const runtime = {
    enabled: () => true,
    audioRoute: () => audioRoute,
    speak: async (text: string, signal: AbortSignal, route?: string) => {
      calls.push({ text, signal, route })
      return {
        ok: true,
        audioBase64: wavBase64(new Float32Array([0.1, -0.1])),
        error: "",
        text: "",
        promptTokens: 0,
        completionTokens: 0,
      }
    },
  } as unknown as InferenceRuntime
  const dispose = createRoot((rootDispose) => {
    registerReadAloud(ctx as never, runtime)
    return rootDispose
  })
  return {
    abort,
    audioObservations,
    autoCommand,
    calls,
    channel,
    dispose,
    messages,
    navigate: () => setCurrentSession({ ...session, visit: {} }),
    pills,
    session,
  }
}

function installWindow() {
  const window = new Window()
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window")
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
  Object.defineProperty(globalThis, "window", { configurable: true, value: window })
  Object.defineProperty(globalThis, "document", { configurable: true, value: window.document })
  return {
    window,
    key(type: "keydown" | "keyup", shiftKey: boolean) {
      window.dispatchEvent(new window.KeyboardEvent(type, { key: "Shift", shiftKey }))
    },
    restore() {
      for (const [name, old] of [
        ["window", previous],
        ["document", previousDocument],
      ] as const) {
        if (old) Object.defineProperty(globalThis, name, old)
        else Reflect.deleteProperty(globalThis, name)
      }
    },
  }
}

function shiftClick(dom: ReturnType<typeof installWindow>, view: PillView) {
  dom.key("keydown", true)
  view.run?.()
  dom.key("keyup", false)
}

function required<T>(value: T | undefined): T {
  expect(value).toBeDefined()
  if (value === undefined) throw new Error("Expected registered control")
  return value
}

async function planFor(requestID: string): Promise<PlaybackPlan> {
  const segments = speechSegments("The last completed answer.")
  return {
    requestID,
    sessionID: "session",
    expectedTextHash: await sha256Text(segments.join("\n")),
    segmentHashes: await Promise.all(segments.map(sha256Text)),
  }
}

test("registered speaker replays the last completed reply during new work and Stop cancels it", async () => {
  const original = globalThis.AudioContext
  globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext
  const harness = setup()
  try {
    const speaker = required(harness.pills.get("read-aloud"))
    const input = { session: harness.session, screen: {} }
    const view = required(speaker.show(input))
    expect(view.title).toContain("read the last response")
    view.run?.()
    await audioStarted.promise
    expect(harness.calls.map((call) => call.text)).toEqual(["The last completed answer."])
    expect(harness.calls[0]?.route).toBe("liquid")

    required(speaker.show(input)).run?.()
    expect(harness.calls[0]?.signal.aborted).toBe(true)
    expect(sourceStops).toBe(1)
    expect(required(speaker.show(input)).title).toContain("read the last response")
  } finally {
    harness.abort.abort()
    harness.dispose()
    globalThis.AudioContext = original
  }
})

test("speech playback rejects silent, non-finite, empty, or wrong-rate audio buffers", () => {
  const buffer = {
    sampleRate: 24_000,
    length: 4,
    duration: 4 / 24_000,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array([0, 0.1, 0, 0]),
  } as AudioBuffer
  expect(() => validateSpeechBuffer(buffer)).not.toThrow()
  expect(() =>
    validateSpeechBuffer({ ...buffer, getChannelData: () => new Float32Array(4) } as AudioBuffer),
  ).toThrow("silent")
  expect(() =>
    validateSpeechBuffer({
      ...buffer,
      getChannelData: () => new Float32Array([0, Number.NaN, 0, 0]),
    } as AudioBuffer),
  ).toThrow("non-finite")
  expect(() => validateSpeechBuffer({ ...buffer, sampleRate: 16_000 } as AudioBuffer)).toThrow(
    "non-24 kHz",
  )
})

test("owned playback evidence follows actual 24 kHz AudioBuffer starts and natural ends", async () => {
  const original = globalThis.AudioContext
  globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext
  const segments = speechSegments("The last completed answer.")
  const plan: PlaybackPlan = {
    requestID: "playback-request-1",
    sessionID: "session",
    expectedTextHash: await sha256Text(segments.join("\n")),
    segmentHashes: await Promise.all(segments.map(sha256Text)),
  }
  const harness = setup(plan, "runntime")
  naturalEnd = true
  try {
    const speaker = required(harness.pills.get("read-aloud"))
    required(speaker.show({ session: harness.session, screen: {} })).run?.()
    await audioStarted.promise
    await waitFor(() => harness.audioObservations.some((item) => item.kind === "playback-complete"))
    expect(harness.audioObservations.map((item) => item.kind)).toEqual([
      "playback-start",
      "playback-segment-start",
      "playback-segment-end",
      "playback-complete",
    ])
    expect(harness.audioObservations[1]).toMatchObject({
      kind: "playback-segment-start",
      segmentIndex: 0,
      sampleRate: 24_000,
      frames: 4_800,
      durationMs: 200,
    })
    expect(harness.audioObservations[0]).toMatchObject({
      kind: "playback-start",
      route: "runntime",
    })
    expect(harness.audioObservations[2]).toEqual(
      harness.audioObservations[1] && {
        ...harness.audioObservations[1],
        kind: "playback-segment-end",
      },
    )
  } finally {
    harness.abort.abort()
    harness.dispose()
    globalThis.AudioContext = original
  }
})

test("owned playback cancellation stops active output without reporting completion", async () => {
  const original = globalThis.AudioContext
  globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext
  const segments = speechSegments("The last completed answer.")
  const plan: PlaybackPlan = {
    requestID: "playback-cancel-request",
    sessionID: "session",
    expectedTextHash: await sha256Text(segments.join("\n")),
    segmentHashes: await Promise.all(segments.map(sha256Text)),
  }
  const harness = setup(plan, "runntime")
  try {
    const speaker = required(harness.pills.get("read-aloud"))
    speaker.show({ session: harness.session, screen: {} })?.run?.()
    await audioStarted.promise
    speaker.show({ session: harness.session, screen: {} })?.run?.()
    await waitFor(() =>
      harness.audioObservations.some((item) => item.kind === "playback-cancelled"),
    )
    expect(harness.audioObservations.map((item) => item.kind)).toEqual([
      "playback-start",
      "playback-segment-start",
      "playback-cancelled",
    ])
    expect(harness.audioObservations.some((item) => item.kind === "playback-complete")).toBe(false)
    expect(sourceStops).toBe(1)
    expect(harness.calls[0]?.signal.aborted).toBe(true)
  } finally {
    harness.abort.abort()
    harness.dispose()
    globalThis.AudioContext = original
  }
})

test("manual playback preflight cannot start speech after session navigation", async () => {
  const plan = await planFor("playback-navigation-request")
  const pendingPlan = Promise.withResolvers<PlaybackPlan | null>()
  const planRequested = Promise.withResolvers<void>()
  const harness = setup(undefined, "runntime", {
    takePlaybackPlan: () => {
      planRequested.resolve()
      return pendingPlan.promise
    },
  })
  try {
    const speaker = required(harness.pills.get("read-aloud"))
    const input = { session: harness.session, screen: {} }
    speaker.show(input)?.run?.()
    await planRequested.promise
    expect(speaker.show(input)?.title).toContain("preparing speech; click to stop")
    harness.navigate()
    pendingPlan.resolve(plan)
    await waitFor(() =>
      harness.audioObservations.some((item) => item.kind === "playback-cancelled"),
    )
    expect(harness.calls).toEqual([])
    expect(harness.audioObservations).toEqual([{ kind: "playback-cancelled" }])
  } finally {
    harness.abort.abort()
    harness.dispose()
  }
})

test("manual playback preflight settles its armed plan when the plugin aborts", async () => {
  const plan = await planFor("playback-abort-request")
  const pendingPlan = Promise.withResolvers<PlaybackPlan | null>()
  const planRequested = Promise.withResolvers<void>()
  const harness = setup(undefined, "runntime", {
    takePlaybackPlan: () => {
      planRequested.resolve()
      return pendingPlan.promise
    },
  })
  try {
    const speaker = required(harness.pills.get("read-aloud"))
    speaker.show({ session: harness.session, screen: {} })?.run?.()
    await planRequested.promise
    harness.abort.abort()
    pendingPlan.resolve(plan)
    await waitFor(() =>
      harness.audioObservations.some((item) => item.kind === "playback-cancelled"),
    )
    expect(harness.calls).toEqual([])
    expect(harness.audioObservations).toEqual([{ kind: "playback-cancelled" }])
  } finally {
    harness.abort.abort()
    harness.dispose()
  }
})

test("cancellation during a pending playback observation handles the ended rejection", async () => {
  const original = globalThis.AudioContext
  globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext
  const plan = await planFor("playback-observe-cancel-request")
  const waitingObservation = Promise.withResolvers<void>()
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  const harness = setup(plan, "runntime", {
    observe: async (event, signal) => {
      if (event.kind !== "playback-segment-start") return
      waitingObservation.resolve()
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
        if (!signal || signal.aborted) abort()
        else {
          signal.addEventListener("abort", abort, { once: true })
        }
      })
    },
  })
  try {
    const speaker = required(harness.pills.get("read-aloud"))
    speaker.show({ session: harness.session, screen: {} })?.run?.()
    await audioStarted.promise
    await waitingObservation.promise
    speaker.show({ session: harness.session, screen: {} })?.run?.()
    await waitFor(() =>
      harness.audioObservations.some((item) => item.kind === "playback-cancelled"),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.audioObservations.map((item) => item.kind)).toEqual([
      "playback-start",
      "playback-cancelled",
    ])
    expect(sourceStops).toBe(1)
    expect(unhandled).toEqual([])
  } finally {
    process.off("unhandledRejection", onUnhandled)
    harness.abort.abort()
    harness.dispose()
    globalThis.AudioContext = original
  }
})

test("a rejected playback observation aborts output and a fresh request succeeds", async () => {
  const original = globalThis.AudioContext
  globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext
  const firstPlan = await planFor("playback-observe-failure-request")
  const retryPlan = await planFor("playback-retry-request")
  let activePlan = firstPlan
  let rejectSegmentObservation = true
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  const harness = setup(undefined, "runntime", {
    takePlaybackPlan: async () => activePlan,
    observe: async (event) => {
      if (event.kind === "playback-segment-start" && rejectSegmentObservation) {
        rejectSegmentObservation = false
        throw new Error("Fixture observation failed")
      }
    },
  })
  try {
    const speaker = required(harness.pills.get("read-aloud"))
    const input = { session: harness.session, screen: {} }
    speaker.show(input)?.run?.()
    await audioStarted.promise
    await waitFor(() => harness.audioObservations.some((item) => item.kind === "playback-failed"))
    await waitFor(() => speaker.show(input)?.title.includes("read the last response") === true)
    expect(sourceStops).toBe(1)
    activePlan = retryPlan
    naturalEnd = true
    speaker.show(input)?.run?.()
    await waitFor(() => harness.audioObservations.some((item) => item.kind === "playback-complete"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.audioObservations.map((item) => item.kind)).toEqual([
      "playback-start",
      "playback-failed",
      "playback-start",
      "playback-segment-start",
      "playback-segment-end",
      "playback-complete",
    ])
    expect(harness.calls).toHaveLength(2)
    expect(unhandled).toEqual([])
  } finally {
    process.off("unhandledRejection", onUnhandled)
    harness.abort.abort()
    harness.dispose()
    globalThis.AudioContext = original
  }
})

test("native menu and command enable final-only auto speech, deduplicate parts, and stop playback", async () => {
  const original = globalThis.AudioContext
  globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext
  const dom = installWindow()
  const harness = setup()
  try {
    const autoPill = required(harness.pills.get("read-aloud"))
    const input = { session: harness.session, screen: {} }
    expect(harness.pills.has("auto-speech")).toBe(false)
    expect(required(autoPill.show(input)).title).toContain("automatic read aloud is off")
    shiftClick(dom, required(autoPill.show(input)))
    expect(required(autoPill.show(input)).title).toContain("automatic read aloud is on")
    await harness.channel.waitForSubscription(1)

    harness.channel.publish(event("session.execution.started", {}))
    harness.channel.publish(
      event("session.text.delta", {
        assistantMessageID: "new-message",
        ordinal: 0,
        delta: "RAW DELTA CANARY",
      }),
    )
    harness.channel.publish(
      event("session.text.ended", {
        assistantMessageID: "new-message",
        ordinal: 0,
        text: "COMMENTARY CANARY",
        native: { phase: "commentary" },
      }),
    )
    harness.channel.publish(
      event("session.step.ended", { assistantMessageID: "new-message", finish: "stop" }),
    )
    harness.channel.publish(event("session.execution.succeeded", {}))
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.calls).toEqual([])

    harness.channel.publish(event("session.execution.started", {}))
    const finalPart = event("session.text.ended", {
      assistantMessageID: "final-message",
      ordinal: 0,
      text: "This is the final answer.\n",
      native: { phase: "final_answer" },
    })
    harness.channel.publish(finalPart)
    await audioStarted.promise
    harness.channel.publish(
      event("session.step.ended", { assistantMessageID: "final-message", finish: "stop" }),
    )
    harness.channel.publish(event("session.execution.succeeded", {}))
    harness.channel.endStream()
    await harness.channel.waitForSubscription(2)
    harness.channel.publish(finalPart)
    await Promise.resolve()
    expect(harness.calls.map((call) => call.text)).toEqual(["This is the final answer."])

    required(required(harness.pills.get("read-aloud")).show(input)).run?.()
    expect(harness.calls[0]?.signal.aborted).toBe(true)
    expect(sourceStops).toBe(1)

    required(harness.autoCommand).run?.()
    expect(required(autoPill.show(input)).title).toContain("automatic read aloud is off")
  } finally {
    harness.abort.abort()
    harness.dispose()
    globalThis.AudioContext = original
    dom.restore()
  }
})

test("a disconnected text stream cannot speak an unseen code tail", async () => {
  const original = globalThis.AudioContext
  globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext
  const harness = setup()
  try {
    required(harness.autoCommand).run?.()
    await harness.channel.waitForSubscription(1)
    harness.channel.publish(event("session.execution.started", {}))
    harness.channel.endStream()
    await harness.channel.waitForSubscription(2)
    harness.channel.publish(
      event("session.text.ended", {
        assistantMessageID: "lost-opening-fence",
        ordinal: 1,
        text: "CODE_TAIL_CANARY\n",
        native: { phase: "final_answer" },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.calls).toEqual([])
    harness.channel.publish(event("session.execution.started", {}))
    harness.channel.publish(
      event("session.text.ended", {
        assistantMessageID: "next-execution",
        ordinal: 0,
        text: "Safe new answer.\n",
        native: { phase: "final_answer" },
      }),
    )
    await audioStarted.promise
    expect(harness.calls.map((call) => call.text)).toEqual(["Safe new answer."])
  } finally {
    harness.abort.abort()
    harness.dispose()
    globalThis.AudioContext = original
  }
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("Timed out waiting for owned playback completion")
}

test("shift tracks the click: shift-click toggles automatic read aloud, a plain click speaks, blur resets", async () => {
  const original = globalThis.AudioContext
  globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext
  const dom = installWindow()
  const harness = setup()
  try {
    const pill = required(harness.pills.get("read-aloud"))
    const input = { session: harness.session, screen: {} }
    const view = () => required(pill.show(input))
    expect(view().title).toContain("automatic read aloud is off")

    dom.key("keydown", true)
    view().run?.()
    expect(view().title).toContain("automatic read aloud is on")
    expect(harness.calls).toEqual([])
    dom.key("keyup", false)

    // Shift up: a click reads the response instead of toggling.
    view().run?.()
    await audioStarted.promise
    expect(view().title).toContain("automatic read aloud is on")
    expect(harness.calls.map((call) => call.text)).toEqual(["The last completed answer."])
    view().run?.()

    // A window that loses focus while Shift is down must not leave Shift stuck.
    dom.key("keydown", true)
    dom.window.dispatchEvent(new dom.window.Event("blur"))
    view().run?.()
    expect(view().title).toContain("automatic read aloud is on")
    dom.key("keydown", true)
    Object.defineProperty(dom.window.document, "visibilityState", {
      configurable: true,
      value: "hidden",
    })
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"))
    view().run?.()
    expect(view().title).toContain("automatic read aloud is on")
  } finally {
    harness.abort.abort()
    harness.dispose()
    globalThis.AudioContext = original
    dom.restore()
  }
})

test("the speaker pill shows idle, automatic and speaking states with icon, tone and title", async () => {
  const original = globalThis.AudioContext
  globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext
  const dom = installWindow()
  const harness = setup()
  try {
    const pill = required(harness.pills.get("read-aloud"))
    const input = { session: harness.session, screen: {} }
    const idle = required(pill.show(input))
    expect(idle.icon).toBeUndefined()
    expect(idle.tone).toBeUndefined()
    expect(idle.title).toBe(
      "LAZERS speaker: read the last response. Shift-click: automatic read aloud is off.",
    )

    shiftClick(dom, idle)
    const auto = required(pill.show(input))
    expect(auto.icon).toBe("waveform")
    expect(auto.tone).toBe("success")
    expect(auto.title).toBe(
      "LAZERS speaker: read the last response. Shift-click: automatic read aloud is on.",
    )

    required(pill.show(input)).run?.()
    await audioStarted.promise
    const speaking = required(pill.show(input))
    expect(speaking.title).toMatch(
      /^LAZERS speaker: (preparing speech|reading response); click to stop\./,
    )
    expect(speaking.title).toContain("automatic read aloud is on")
    expect(speaking.icon).toBe("waveform")
    speaking.run?.()
  } finally {
    harness.abort.abort()
    harness.dispose()
    globalThis.AudioContext = original
    dom.restore()
  }
})
