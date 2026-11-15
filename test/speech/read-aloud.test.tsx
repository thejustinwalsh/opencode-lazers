import { expect, test } from "bun:test"
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
  rows?: readonly { run?: () => void }[]
  run?: () => void
}
type NativePill = { show(input: unknown): PillView | undefined }
type NativeCommand = { run?: () => void }

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

function setup(audioPlan?: PlaybackPlan, audioRoute: "liquid" | "runntime" = "liquid") {
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
  const [currentSession] = createSignal(session)
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
      enabled: async () => audioPlan !== undefined,
      takePlaybackPlan: async () => audioPlan ?? null,
      observe: async ({ event }: { event: AudioObservationEvent }) => {
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
    pills,
    session,
  }
}

function required<T>(value: T | undefined): T {
  expect(value).toBeDefined()
  if (value === undefined) throw new Error("Expected registered control")
  return value
}

test("registered speaker replays the last completed reply during new work and Stop cancels it", async () => {
  const original = globalThis.AudioContext
  globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext
  const harness = setup()
  try {
    const speaker = required(harness.pills.get("read-aloud"))
    const input = { session: harness.session, screen: {} }
    const view = required(speaker.show(input))
    expect(view.title).toContain("read latest completed response")
    view.run?.()
    await audioStarted.promise
    expect(harness.calls.map((call) => call.text)).toEqual(["The last completed answer."])
    expect(harness.calls[0]?.route).toBe("liquid")

    required(speaker.show(input)).run?.()
    expect(harness.calls[0]?.signal.aborted).toBe(true)
    expect(sourceStops).toBe(1)
    expect(required(speaker.show(input)).title).toContain("read latest completed response")
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

test("native menu and command enable final-only auto speech, deduplicate parts, and stop playback", async () => {
  const original = globalThis.AudioContext
  globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext
  const harness = setup()
  try {
    const autoPill = required(harness.pills.get("auto-speech"))
    const input = { session: harness.session, screen: {} }
    expect(required(autoPill.show(input)).label).toBe("Auto off")
    required(autoPill.show(input)).rows?.[0]?.run?.()
    expect(required(autoPill.show(input)).label).toBe("Auto on")
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
    expect(required(autoPill.show(input)).label).toBe("Auto off")
  } finally {
    harness.abort.abort()
    harness.dispose()
    globalThis.AudioContext = original
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
