import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { dirname, join, resolve } from "node:path"
import {
  NATIVE_VERIFICATION_BASE_ENV,
  NativeInteraction,
  type NativeActionResult,
  type NativeBinding,
  nativeKeyUsesModifiers,
  type NativeOperation,
  type NativeInteractionCapabilities,
  type NativeWindowReference,
} from "./native-interaction-contract.ts"
import type { AudioObservationEvent } from "./audio-fixture-contract.ts"

const HOST_FRESH_MS = 2_000
const MAX_REQUESTS = 256

type NativeRequest = {
  requestID: string
  operation: NativeOperation
}

type RecordState = "queued" | "delivered" | "completed"

type RequestRecord = {
  bindingKey: string
  request: NativeRequest
  state: RecordState
  result?: NativeActionResult
}

type HostRecord = {
  binding: NativeBinding
  adapterID: string
  windows: NativeWindowReference[]
  capabilities: { modifiedKeys: boolean }
  lastSeen: number
}

type AudioRecord = {
  requestID: string
  sessionID: string
  window: NativeWindowReference
  kind: "dictation" | "playback"
  fixtureID?: "quick-brown-fox" | "turn-left-next-street"
  route?: "runntime"
  expectedTextHash?: string
  segmentHashes?: string[]
  events: Array<{ at: number; event: AudioObservationEvent }>
  appCompleted: boolean
  activeSegment?: number
  intelligibility?: "pass" | "fail" | "unknown"
  terminal: boolean
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "undefined"
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(object[key])}`)
    .join(",")}}`
}

function same(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right)
}

export class NativeInteractionBroker {
  private host?: HostRecord
  private readonly requests = new Map<string, RequestRecord>()
  private readonly audio = new Map<string, AudioRecord>()
  private activeRequest?: string
  private ambiguous = false

  constructor(
    private readonly expected: {
      root: string
      verificationBase: string
      servicePID: number
      version: string
    },
    private readonly now: () => number = Date.now,
  ) {}

  attach(input: {
    binding: NativeBinding
    adapterID: string
    windows: ReadonlyArray<NativeWindowReference>
    capabilities?: NativeInteractionCapabilities
  }): void {
    this.assertBinding(input.binding)
    const current = this.host
    if (current !== undefined && current.adapterID !== input.adapterID) {
      throw new Error("A different native adapter generation still owns this trial")
    }
    if (current !== undefined && !same(current.binding, input.binding)) {
      throw new Error("Native adapter binding changed during this trial")
    }
    this.host = {
      binding: input.binding,
      adapterID: input.adapterID,
      windows: this.validateWindows(input.windows),
      capabilities: { modifiedKeys: input.capabilities?.modifiedKeys === true },
      lastSeen: this.now(),
    }
  }

  status(binding: NativeBinding) {
    this.assertBinding(binding)
    const host = this.host
    if (host === undefined || !same(host.binding, binding)) {
      return {
        ready: false,
        blocked: this.ambiguous,
        windows: [] as NativeWindowReference[],
      }
    }
    const fresh = this.now() - host.lastSeen <= HOST_FRESH_MS
    return {
      ready: fresh,
      blocked: this.ambiguous,
      windows: fresh ? host.windows : [],
      ...(fresh ? { adapterID: host.adapterID, capabilities: host.capabilities } : {}),
    }
  }

  enqueue(input: { binding: NativeBinding; requestID: string; operation: NativeOperation }) {
    this.assertBinding(input.binding)
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(input.requestID)) {
      throw new Error("Native request ID is invalid")
    }
    const duplicate = this.requests.get(input.requestID)
    if (duplicate !== undefined) {
      if (
        duplicate.bindingKey !== stable(input.binding) ||
        !same(duplicate.request.operation, input.operation)
      ) {
        throw new Error("Native request ID was already used for a different operation")
      }
      return { state: "existing" as const }
    }
    const host = this.requireFreshHost(input.binding)
    if (this.ambiguous) throw new Error("An ambiguous native action blocks further interaction")
    if (this.activeRequest !== undefined) {
      throw new Error("A native interaction is already pending; inspect it without replay")
    }
    if (this.requests.size >= MAX_REQUESTS) {
      throw new Error("Native interaction history is full; start a new owned trial")
    }
    if (
      input.operation.kind === "key" &&
      nativeKeyUsesModifiers(input.operation.key) &&
      !host.capabilities.modifiedKeys
    ) {
      this.requests.set(input.requestID, {
        bindingKey: stable(input.binding),
        request: { requestID: input.requestID, operation: input.operation },
        state: "completed",
        result: {
          delivery: "not-delivered",
          message: "Owned native adapter does not support modified key shortcuts",
        },
      })
      return { state: "completed" as const }
    }
    const currentWindow = host.windows.find(
      (window) => window.windowID === input.operation.window.windowID,
    )
    const rejection =
      currentWindow === undefined || !same(currentWindow, input.operation.window)
        ? "Native window reference is stale; take a fresh snapshot"
        : !currentWindow.visible
          ? "Native target window is not visible"
          : !["snapshot", "capture", "focus"].includes(input.operation.kind) &&
              !currentWindow.focused
            ? "Focus the owned Desktop window before native input"
            : undefined
    if (rejection !== undefined) {
      // Retain a conclusive negative receipt even if the enqueue response is lost.
      // The adapter never receives this operation.
      this.requests.set(input.requestID, {
        bindingKey: stable(input.binding),
        request: { requestID: input.requestID, operation: input.operation },
        state: "completed",
        result: { delivery: "not-delivered", message: rejection },
      })
      return { state: "completed" as const }
    }
    this.requests.set(input.requestID, {
      bindingKey: stable(input.binding),
      request: { requestID: input.requestID, operation: input.operation },
      state: "queued",
    })
    if (input.operation.kind === "dictation-fixture") {
      this.audio.set(input.requestID, {
        requestID: input.requestID,
        sessionID: input.operation.sessionID,
        window: { ...input.operation.window },
        kind: "dictation",
        fixtureID: input.operation.fixtureID,
        events: [],
        appCompleted: false,
        terminal: false,
      })
    } else if (input.operation.kind === "playback-plan") {
      this.audio.set(input.requestID, {
        requestID: input.requestID,
        sessionID: input.operation.sessionID,
        window: { ...input.operation.window },
        kind: "playback",
        expectedTextHash: input.operation.expectedTextHash,
        segmentHashes: [...input.operation.segmentHashes],
        events: [],
        appCompleted: false,
        terminal: false,
      })
    }
    this.activeRequest = input.requestID
    return { state: "queued" as const }
  }

  poll(input: {
    binding: NativeBinding
    adapterID: string
    windows: ReadonlyArray<NativeWindowReference>
    capabilities?: NativeInteractionCapabilities
  }): NativeRequest | null {
    this.attach(input)
    if (this.ambiguous || this.activeRequest === undefined) return null
    const record = this.requests.get(this.activeRequest)
    if (record === undefined || record.state !== "queued") return null
    const host = this.host
    if (
      host === undefined ||
      (record.request.operation.kind === "key" &&
        nativeKeyUsesModifiers(record.request.operation.key) &&
        !host.capabilities.modifiedKeys)
    ) {
      record.state = "completed"
      record.result = {
        delivery: "not-delivered",
        message: "Owned native adapter does not support modified key shortcuts",
      }
      this.activeRequest = undefined
      return null
    }
    record.state = "delivered"
    return record.request
  }

  complete(input: {
    binding: NativeBinding
    adapterID: string
    requestID: string
    result: NativeActionResult
  }): void {
    this.assertBinding(input.binding)
    const host = this.host
    if (
      host === undefined ||
      !same(host.binding, input.binding) ||
      host.adapterID !== input.adapterID
    ) {
      throw new Error("Native completion came from a stale adapter generation")
    }
    const record = this.requests.get(input.requestID)
    if (
      record === undefined ||
      record.state !== "delivered" ||
      this.activeRequest !== input.requestID
    ) {
      throw new Error("Native completion does not match the delivered request")
    }
    record.state = "completed"
    record.result = input.result
    this.activeRequest = undefined
    if (input.result.delivery === "ambiguous") this.ambiguous = true
  }

  result(binding: NativeBinding, requestID: string) {
    this.assertBinding(binding)
    const record = this.requests.get(requestID)
    if (record === undefined) return { state: "unknown" as const }
    if (record.bindingKey !== stable(binding)) {
      throw new Error("Native request belongs to a different owned trial")
    }
    return {
      state: record.state,
      ...(record.result === undefined ? {} : { result: record.result }),
    }
  }

  observeAudio(input: {
    binding: NativeBinding
    adapterID: string
    observation: {
      requestID: string
      sessionID: string
      window: NativeWindowReference
      event: AudioObservationEvent
    }
  }): void {
    this.assertBinding(input.binding)
    const host = this.requireFreshHost(input.binding)
    if (host.adapterID !== input.adapterID) throw new Error("Audio observation adapter is stale")
    const record = this.audio.get(input.observation.requestID)
    if (
      !record ||
      (record.terminal && input.observation.event.kind !== "intelligibility") ||
      record.sessionID !== input.observation.sessionID ||
      !same(record.window, input.observation.window)
    ) {
      throw new Error("Audio observation has an unknown or stale request target")
    }
    const current = host.windows.find((window) => window.windowID === record.window.windowID)
    if (!current || !same(current, record.window))
      throw new Error("Audio observation window generation is stale")
    if (record.events.length >= 100) throw new Error("Audio observation history is full")
    this.validateAudioEvent(record, input.observation.event)
    record.events.push({ at: this.now(), event: input.observation.event })
  }

  audioResult(binding: NativeBinding, requestID: string) {
    this.assertBinding(binding)
    const record = this.audio.get(requestID)
    if (!record) return null
    const { activeSegment: _activeSegment, terminal: _terminal, ...result } = record
    return structuredClone(result)
  }

  detach(binding: NativeBinding, adapterID: string): void {
    const host = this.requireFreshHost(binding)
    if (host.adapterID !== adapterID) throw new Error("Native adapter generation is stale")
    const active =
      this.activeRequest === undefined ? undefined : this.requests.get(this.activeRequest)
    if (active?.state === "queued") {
      active.state = "completed"
      active.result = {
        delivery: "not-delivered",
        message: "Desktop adapter stopped before dispatch",
      }
      this.activeRequest = undefined
    } else if (active?.state === "delivered") {
      active.state = "completed"
      active.result = { delivery: "ambiguous", message: "Desktop adapter stopped after dispatch" }
      this.activeRequest = undefined
      this.ambiguous = true
    }
    this.host = undefined
  }

  private assertBinding(binding: NativeBinding): void {
    let endpoint: URL | undefined
    try {
      endpoint = new URL(binding.service.url)
    } catch {
      throw new Error("Native interaction service endpoint is malformed")
    }
    const portMatch = /(?:^|\s)--port(?:=|\s+)(\d+)(?:\s|$)/.exec(binding.service.process.command)
    if (
      binding.root !== this.expected.root ||
      binding.verificationBase !== this.expected.verificationBase ||
      dirname(resolve(binding.root)) !== this.expected.verificationBase ||
      binding.service.process.pid !== this.expected.servicePID ||
      binding.service.version !== this.expected.version ||
      binding.target.cliVersion !== this.expected.version ||
      binding.target.effectiveStateHome !== join(this.expected.root, "state") ||
      binding.candidate.workspace !== binding.target.workspace ||
      !/^[a-f0-9]{40,64}$/.test(binding.candidate.revision) ||
      binding.candidate.pluginEntry !==
        join(resolve(binding.candidate.workspace), "src", "index.ts") ||
      binding.candidate.guiEntry !==
        join(resolve(binding.candidate.workspace), "dist", "gui-experimental.cjs") ||
      !binding.target.desktopBundle.endsWith(".app") ||
      !binding.desktop.command.includes(
        join(binding.target.desktopBundle, "Contents", "MacOS", "OpenCode"),
      ) ||
      binding.desktop.pid === binding.service.process.pid ||
      binding.desktop.pid <= 0 ||
      binding.desktop.startedAt.length === 0 ||
      binding.service.process.startedAt.length === 0 ||
      binding.target.bundleID.length === 0 ||
      binding.target.version.length === 0 ||
      binding.target.cliPath.length === 0 ||
      binding.target.serviceRegistrationPath !==
        join(this.expected.root, "state", "opencode", "service.json") ||
      endpoint.protocol !== "http:" ||
      endpoint.hostname !== "127.0.0.1" ||
      endpoint.username !== "" ||
      endpoint.password !== "" ||
      endpoint.pathname !== "/" ||
      endpoint.search !== "" ||
      endpoint.hash !== "" ||
      endpoint.port.length === 0 ||
      Number(endpoint.port) === 49374 ||
      portMatch === null ||
      Number(portMatch[1]) !== Number(endpoint.port) ||
      binding.service.id.length === 0 ||
      binding.service.url.length === 0
    ) {
      throw new Error("Native interaction binding does not match the owned sidecar")
    }
  }

  private requireFreshHost(binding: NativeBinding): HostRecord {
    this.assertBinding(binding)
    const host = this.host
    if (
      host === undefined ||
      !same(host.binding, binding) ||
      this.now() - host.lastSeen > HOST_FRESH_MS
    ) {
      throw new Error("Owned Desktop native adapter is not freshly attached")
    }
    return host
  }

  private validateWindows(windows: ReadonlyArray<NativeWindowReference>): NativeWindowReference[] {
    if (
      windows.length > 32 ||
      new Set(windows.map((window) => window.windowID)).size !== windows.length
    ) {
      throw new Error("Owned Desktop window inventory is malformed")
    }
    return windows.map((window) => ({ ...window }))
  }

  private validateAudioEvent(record: AudioRecord, event: AudioObservationEvent): void {
    if (record.kind === "dictation") {
      if (event.kind === "dictation-start") {
        if (record.events.length !== 0 || event.fixtureID !== record.fixtureID)
          throw new Error("Dictation fixture start does not match its armed request")
        record.route = event.route
        return
      }
      if (
        event.kind === "dictation-complete" &&
        record.events.length === 1 &&
        record.events[0]?.event.kind === "dictation-start" &&
        event.fixtureID === record.fixtureID
      ) {
        record.appCompleted = event.matchesExpected && event.insertedExactlyOnce && !event.submitted
        record.terminal = true
        return
      }
      if (
        (event.kind === "dictation-cancelled" || event.kind === "dictation-failed") &&
        (record.events.length === 0 || record.events[0]?.event.kind === "dictation-start") &&
        event.fixtureID === record.fixtureID
      ) {
        record.terminal = true
        return
      }
      throw new Error("Dictation observation is out of order or belongs to another clip")
    }

    if (event.kind === "playback-start") {
      if (
        record.events.length !== 0 ||
        event.route !== "runntime" ||
        event.expectedTextHash !== record.expectedTextHash ||
        !same(event.segmentHashes, record.segmentHashes)
      )
        throw new Error("Playback start does not match its armed content plan")
      record.route = event.route
      return
    }
    if (event.kind === "playback-segment-start") {
      const started = record.events.filter(
        (item) => item.event.kind === "playback-segment-end",
      ).length
      if (
        record.events.length === 0 ||
        record.events[0]?.event.kind !== "playback-start" ||
        record.activeSegment !== undefined ||
        event.segmentIndex !== started ||
        event.textHash !== record.segmentHashes?.[started] ||
        event.sampleRate !== 24_000
      )
        throw new Error("Playback segment start is missing, repeated, or out of order")
      record.activeSegment = event.segmentIndex
      return
    }
    if (event.kind === "playback-segment-end") {
      const prior = record.events.at(-1)?.event
      if (
        record.activeSegment !== event.segmentIndex ||
        prior?.kind !== "playback-segment-start" ||
        prior.segmentIndex !== event.segmentIndex ||
        prior.textHash !== event.textHash ||
        prior.frames !== event.frames ||
        prior.sampleRate !== event.sampleRate ||
        prior.durationMs !== event.durationMs
      )
        throw new Error("Playback segment did not end naturally after its matching start")
      record.activeSegment = undefined
      return
    }
    if (event.kind === "playback-complete") {
      const completed = record.events.filter(
        (item) => item.event.kind === "playback-segment-end",
      ).length
      if (
        record.events[0]?.event.kind !== "playback-start" ||
        record.activeSegment !== undefined ||
        completed !== record.segmentHashes?.length
      )
        throw new Error("Playback completion arrived before every expected segment ended")
      record.appCompleted = true
      record.terminal = true
      return
    }
    if (event.kind === "playback-cancelled" || event.kind === "playback-failed") {
      record.terminal = true
      return
    }
    if (event.kind === "intelligibility") {
      if (
        record.kind !== "playback" ||
        !record.appCompleted ||
        record.intelligibility !== undefined
      )
        throw new Error("Intelligibility must be recorded once, separately after app completion")
      record.intelligibility = event.value
      return
    }
    throw new Error("Audio observation event does not match a playback request")
  }
}

export function registerNativeInteraction(ctx: Pick<Plugin.Context, "rpc" | "app">) {
  const root = process.env.OPENCODE_DESKTOP_TEST_ROOT
  if (root === undefined || root.length === 0) return Effect.void
  const verificationBase = process.env[NATIVE_VERIFICATION_BASE_ENV]
  if (verificationBase === undefined || dirname(resolve(root)) !== resolve(verificationBase)) {
    return Effect.die(new Error("Owned native verification base identity is unavailable"))
  }
  const broker = new NativeInteractionBroker({
    root,
    verificationBase: resolve(verificationBase),
    servicePID: process.pid,
    version: ctx.app.version,
  })
  return Effect.gen(function* () {
    yield* ctx.rpc.register(NativeInteraction, {
      attach: (input) =>
        Effect.sync(() => {
          broker.attach(input)
          return {}
        }),
      status: (input) => Effect.sync(() => broker.status(input.binding)),
      enqueue: (input) => Effect.sync(() => broker.enqueue(input)),
      poll: (input) => Effect.sync(() => broker.poll(input)),
      complete: (input) =>
        Effect.sync(() => {
          broker.complete(input)
          return {}
        }),
      result: (input) => Effect.sync(() => broker.result(input.binding, input.requestID)),
      audioObserve: (input) =>
        Effect.sync(() => {
          broker.observeAudio(input)
          return {}
        }),
      audioResult: (input) => Effect.sync(() => broker.audioResult(input.binding, input.requestID)),
      detach: (input) =>
        Effect.sync(() => {
          broker.detach(input.binding, input.adapterID)
          return {}
        }),
    })
  })
}
