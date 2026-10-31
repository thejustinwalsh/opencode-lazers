import { expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode/client"
import { createRoot, createSignal } from "solid-js"
import { Command, ComposerPill } from "@opencode/plugin/gui"
import { registerReadAloud } from "../../src/webgpu/read-aloud.tsx"
import type { InferenceRuntime } from "../../src/webgpu/runtime.ts"

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

class FakeAudioContext {
  readonly destination = {} as AudioDestinationNode
  async resume() {}
  async suspend() {}
  async close() {}
  async decodeAudioData() {
    return {} as AudioBuffer
  }
  createBufferSource() {
    const source = {
      buffer: null as AudioBuffer | null,
      onended: null as ((event: Event) => void) | null,
      connect() {},
      disconnect() {},
      start() {
        audioStarted.resolve()
      },
      stop() {
        sourceStops++
      },
    }
    return source as unknown as AudioBufferSourceNode
  }
}

function event(type: string, data: Record<string, unknown>): OpenCodeEvent {
  return {
    id: `${type}-event`,
    created: 1,
    type,
    durable: { aggregateID: "session", seq: 1, version: 1 },
    data: { sessionID: "session", ...data },
  } as unknown as OpenCodeEvent
}

function setup() {
  audioStarted = Promise.withResolvers<void>()
  sourceStops = 0
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
    add(registry: unknown, item: unknown) {
      const contribution = item as { id: string } & NativePill & NativeCommand
      if (registry === ComposerPill) pills.set(contribution.id, contribution)
      if (registry === Command) autoCommand = contribution
    },
  }
  const calls: Array<{ text: string; signal: AbortSignal }> = []
  const runtime = {
    enabled: () => true,
    speak: async (text: string, signal: AbortSignal) => {
      calls.push({ text, signal })
      return {
        ok: true,
        audioBase64: "AQ==",
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
  return { abort, autoCommand, calls, channel, dispose, messages, pills, session }
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
