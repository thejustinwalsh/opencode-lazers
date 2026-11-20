import { expect, test } from "bun:test"
import { Window } from "happy-dom"
import { createRoot } from "solid-js"
import { Command, ComposerPill } from "@opencode/plugin/gui"
import type { InferenceRuntime } from "../../src/webgpu/runtime.ts"
import { MICROPHONE_PREFIX } from "../../src/webgpu/pill-tooltip.ts"
import { registerDictation } from "../../src/webgpu/dictation.tsx"
import { AudioFixtureDelivery } from "../../src/verification/opencode/audio-fixture-contract.ts"
import type { AudioObservationEvent } from "../../src/verification/opencode/audio-fixture-contract.ts"

type PillView = { title: string; run?: () => void }
type Contribution = { id: string; show?: () => PillView | undefined; run?: () => void }

const transcript = "The quick brown fox jumps over the lazy dog."

function fixtureWavBase64(): string {
  const bytes = new Uint8Array(46)
  const view = new DataView(bytes.buffer)
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      bytes[offset + index] = value.charCodeAt(index)
  }
  text(0, "RIFF")
  view.setUint32(4, bytes.length - 8, true)
  text(8, "WAVEfmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16_000, true)
  view.setUint32(28, 32_000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, "data")
  view.setUint32(40, 2, true)
  return btoa(String.fromCharCode(...bytes))
}

const decodedBuffer = {
  duration: 1,
  length: 16_000,
  sampleRate: 16_000,
  getChannelData: () => new Float32Array(16_000).fill(0.01),
} as unknown as AudioBuffer

class FakeAudioContext {
  async decodeAudioData() {
    return decodedBuffer
  }
  async close() {}
}

class FakeOfflineAudioContext {
  readonly destination = {}
  createBufferSource() {
    return { buffer: null, connect() {}, start() {} }
  }
  async startRendering() {
    return decodedBuffer
  }
}

test("composer-click fixture dictation preserves a draft, inserts streamed words once, and never records or sends", async () => {
  const dom = new Window()
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  const oldAudioContext = globalThis.AudioContext
  const oldOfflineAudioContext = globalThis.OfflineAudioContext
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom })
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => void getUserMediaCalls++ } },
  })
  globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext
  globalThis.OfflineAudioContext = FakeOfflineAudioContext as unknown as typeof OfflineAudioContext

  let getUserMediaCalls = 0
  let draft = "Keep this existing draft: "
  const inserted: string[] = []
  const observations: AudioObservationEvent[] = []
  const transcriptionRoutes: string[] = []
  const toastMessages: string[] = []
  let fixtureArmed = true
  let fixtureCount = 0
  let transcriptionMode: "immediate" | "deferred" = "immediate"
  let currentVisit: object = {}
  let lateText: ((text: string) => void) | undefined
  let pendingSignal: AbortSignal | undefined
  let finishPendingTranscription: (() => void) | undefined
  const fixture: typeof AudioFixtureDelivery.Type = {
    requestID: "dictation-request-1",
    fixtureID: "quick-brown-fox",
    transcript,
    sampleRate: 16_000,
    durationMs: 2_671,
    sha256: "0497e70d431e9d827c10bbaff120c9cbabf0834a747107f83cb161dc1f759880",
    audioBase64: fixtureWavBase64(),
  }
  let fixtureDurationMs = fixture.durationMs
  const audioIPC = {
    enabled: async () => true,
    takeDictation: async ({ sessionID }: { sessionID: string }) => {
      expect(sessionID).toBe("owned-session")
      return fixtureArmed
        ? {
            ...fixture,
            durationMs: fixtureDurationMs,
            requestID: `dictation-request-${++fixtureCount}`,
          }
        : null
    },
    observe: async ({ event }: { event: AudioObservationEvent }) => {
      observations.push(event)
    },
  }
  const session = {
    id: "owned-session",
    get visit() {
      return currentVisit
    },
  }
  const screen = {
    composer: {
      insert(text: string) {
        inserted.push(text)
        draft += text
      },
    },
  }
  const abort = new AbortController()
  const contributions = new Map<string, Contribution>()
  const ctx = {
    id: "lazers",
    signal: abort.signal,
    sessions: { current: () => session },
    screen: { current: () => screen },
    main: () => audioIPC,
    keybinds: { keybind: () => ["ctrl", "shift", "space"], matches: () => false },
    toast: {
      show(input: { description?: string }) {
        toastMessages.push(input.description ?? "")
      },
    },
    add(registry: unknown, item: unknown) {
      const contribution = item as Contribution
      if (registry === ComposerPill || registry === Command)
        contributions.set(contribution.id, contribution)
    },
  }
  const runtime = {
    enabled: () => true,
    audioRoute: () => "runntime",
    transcribe: async (
      _pcm: string,
      onText: (text: string) => void,
      signal: AbortSignal,
      route: string,
    ) => {
      transcriptionRoutes.push(route)
      if (transcriptionMode === "deferred") {
        return await new Promise<{ ok: boolean; text: string; error: string }>((resolve) => {
          lateText = onText
          pendingSignal = signal
          finishPendingTranscription = () => resolve({ ok: true, text: transcript, error: "" })
        })
      }
      onText("The quick brown ")
      onText("fox jumps over the lazy dog.")
      return { ok: true, text: transcript, error: "" }
    },
  } as unknown as InferenceRuntime
  const dispose = createRoot((rootDispose) => {
    registerDictation(ctx as never, runtime)
    return rootDispose
  })

  try {
    const pill = contributions.get("local-dictation")!
    const control = () => pill.show?.()
    expect(control()?.title.startsWith(`${MICROPHONE_PREFIX} start dictation`)).toBe(true)
    control()?.run?.()
    await waitFor(() => control()?.title.includes("recording") === true)
    expect(control()?.title.startsWith(`${MICROPHONE_PREFIX} recording`)).toBe(true)
    expect(control()?.title).toContain("click to stop")
    control()?.run?.()
    await waitFor(() => observations.some((event) => event.kind === "dictation-complete"))

    expect(getUserMediaCalls).toBe(0)
    expect(transcriptionRoutes).toEqual(["runntime"])
    expect(inserted).toEqual(["The quick brown ", "fox jumps over the lazy dog."])
    expect(draft).toBe(`Keep this existing draft: ${transcript}`)
    expect(observations).toEqual([
      { kind: "dictation-start", fixtureID: "quick-brown-fox", route: "runntime" },
      {
        kind: "dictation-complete",
        fixtureID: "quick-brown-fox",
        matchesExpected: true,
        insertedExactlyOnce: true,
        insertionCalls: 2,
        insertedChars: transcript.length,
        submitted: false,
      },
    ])

    await waitFor(() => control()?.title.includes("start dictation") === true)
    fixtureArmed = false
    control()?.run?.()
    await waitFor(() => toastMessages.some((message) => message.includes("refusing microphone")))
    expect(getUserMediaCalls).toBe(0)
    expect(draft).toBe(`Keep this existing draft: ${transcript}`)

    await waitFor(() => control()?.title.includes("start dictation") === true)
    fixtureArmed = true
    transcriptionMode = "deferred"
    control()?.run?.()
    await waitFor(() => control()?.title.includes("recording") === true)
    control()?.run?.()
    await waitFor(() => finishPendingTranscription !== undefined)
    currentVisit = {}
    window.dispatchEvent(new dom.Event("blur"))
    expect(pendingSignal?.aborted).toBe(true)
    lateText?.(transcript)
    finishPendingTranscription?.()
    await waitFor(() => observations.some((event) => event.kind === "dictation-cancelled"))
    expect(draft).toBe(`Keep this existing draft: ${transcript}`)

    transcriptionMode = "immediate"
    fixtureDurationMs = 1
    draft = "Fresh retry draft: "
    inserted.length = 0
    control()?.run?.()
    await waitFor(
      () => observations.filter((event) => event.kind === "dictation-complete").length === 2,
    )
    expect(draft).toBe(`Fresh retry draft: ${transcript}`)
    expect(inserted).toEqual(["The quick brown ", "fox jumps over the lazy dog."])
    expect(getUserMediaCalls).toBe(0)
  } finally {
    abort.abort()
    dispose()
    dom.happyDOM.close()
    globalThis.AudioContext = oldAudioContext
    globalThis.OfflineAudioContext = oldOfflineAudioContext
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow)
    else Reflect.deleteProperty(globalThis, "window")
    if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator)
    else Reflect.deleteProperty(globalThis, "navigator")
  }
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("Timed out waiting for dictation state")
}
