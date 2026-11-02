import type { OpenCodeClient } from "@opencode/client/promise"
import { RendererInference } from "../rpc.ts"
import type { RelayCompletion, RelayRequestEnvelope } from "./protocol.ts"
import { InferenceRelay } from "./protocol.ts"

const RESYNC_INTERVAL_MS = 2_000
const CLIENT_CHECK_INTERVAL_MS = 250
const RPC_TIMEOUT_MS = 2_000
const MAX_RESYNC_LOCATIONS = 32
const MAX_DISCOVERY_CONCURRENCY = 8
const MAX_IN_FLIGHT = 8

type RelayEvent = {
  type: string
  location: { directory: string }
  data: { requestID: string }
}

type ActiveRequest = {
  key: string
  directory: string
  requestID: string
  claimToken: string
  controller: AbortController
  phase: "claiming" | "delivering"
  working: boolean
  workerStarted: boolean
  client?: OpenCodeClient
  settled: boolean
}

type MainRelayOptions = {
  now?: () => number
}

const isRelayEvent = (event: unknown): event is RelayEvent => {
  if (typeof event !== "object" || event === null) return false
  if (!("type" in event) || typeof event.type !== "string") return false
  if (!("location" in event) || typeof event.location !== "object" || event.location === null)
    return false
  if (!("directory" in event.location) || typeof event.location.directory !== "string") return false
  if (!("data" in event) || typeof event.data !== "object" || event.data === null) return false
  return "requestID" in event.data && typeof event.data.requestID === "string"
}

const eventID = (event: RelayEvent) => event.data.requestID
const requestKey = (directory: string, id: string) => `${directory}\0${id}`

const timeoutSignal = (signal: AbortSignal, timeoutMs = RPC_TIMEOUT_MS) =>
  AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])

function adjustedInput(request: RelayRequestEnvelope, remainingMs: number) {
  if (request.method === "settings" || request.method === "configure") return request.input
  if (remainingMs < 1_000) throw new Error("Local inference deadline exceeded before delivery")
  if (typeof request.input !== "object" || request.input === null || Array.isArray(request.input))
    throw new Error("Invalid relayed inference request")
  const input = request.input as Record<string, unknown>
  return { ...input, timeoutMs: Math.min(120_000, Math.floor(remainingMs)) }
}

async function forward(
  client: OpenCodeClient,
  request: RelayRequestEnvelope,
  input: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const worker = client.rpc(RendererInference)
  const options = { signal }
  switch (request.method) {
    case "settings":
      return worker.settings({}, options)
    case "configure":
      return worker.configure(input as Parameters<typeof worker.configure>[0], options)
    case "review":
      return worker.review(input as Parameters<typeof worker.review>[0], options)
    case "ask":
      return worker.ask(input as Parameters<typeof worker.ask>[0], options)
    case "speak":
      return worker.speak(input as Parameters<typeof worker.speak>[0], options)
    case "decide":
      return worker.decide(input as Parameters<typeof worker.decide>[0], options)
    case "transcribe":
      return worker.transcribe(input as Parameters<typeof worker.transcribe>[0], options)
    case "systemOne":
      return worker.systemOne(input as Parameters<typeof worker.systemOne>[0], options)
  }
}

/** Main-process bridge from location-owned public RPCs to the default renderer mailbox. */
export class DesktopInferenceRelay {
  private readonly now: () => number
  private readonly active = new Map<string, ActiveRequest>()
  private readonly scanning = new Map<string, OpenCodeClient>()
  private readonly rescanRequested = new Set<string>()
  private client: OpenCodeClient | undefined
  private watchController: AbortController | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private scanTimer: ReturnType<typeof setInterval> | undefined
  private locationCursor = 0
  private resyncing = false
  private closed = false

  constructor(
    private readonly getClient: () => OpenCodeClient | undefined,
    private readonly signal: AbortSignal,
    options: MainRelayOptions = {},
  ) {
    this.now = options.now ?? Date.now
  }

  start() {
    if (this.closed || this.timer) return
    if (this.signal.aborted) {
      void this.close()
      return
    }
    this.observeClient()
    this.timer = setInterval(() => this.observeClient(), CLIENT_CHECK_INTERVAL_MS)
    this.scanTimer = setInterval(() => void this.resync(), RESYNC_INTERVAL_MS)
    this.signal.addEventListener("abort", this.onAbort, { once: true })
    void this.resync()
  }

  refreshConnection() {
    this.observeClient()
  }

  async handleEvent(value: unknown) {
    if (!isRelayEvent(value)) {
      if (
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        value.type === "server.connected"
      )
        await this.resync()
      return
    }
    const current = this.currentClient()
    if (!current) return
    const requestID = eventID(value)
    const key = requestKey(value.location.directory, requestID)
    if (value.type === `rpc.${InferenceRelay.id}.cancelled`) {
      const active = this.active.get(key)
      if (active) active.controller.abort(new Error("Inference cancelled by its location"))
    }
    await this.scanLocation(value.location.directory)
  }

  async resync() {
    if (this.closed || this.resyncing) return
    const client = this.currentClient()
    if (!client) return
    this.resyncing = true
    const controller = this.watchController
    try {
      const signal = timeoutSignal(controller?.signal ?? this.signal)
      const locations = await client.debug.location.list({ signal })
      if (this.currentClient() !== client || this.closed) return
      const directories = locations.map((location) => location.directory).filter(Boolean)
      if (!directories.length) return
      const start = this.locationCursor % directories.length
      const count = Math.min(directories.length, MAX_RESYNC_LOCATIONS)
      const batch = Array.from(
        { length: count },
        (_, index) => directories[(start + index) % directories.length]!,
      )
      this.locationCursor = (start + count) % directories.length
      for (let offset = 0; offset < batch.length; offset += MAX_DISCOVERY_CONCURRENCY) {
        await Promise.all(
          batch
            .slice(offset, offset + MAX_DISCOVERY_CONCURRENCY)
            .map((directory) => this.scanLocation(directory)),
        )
      }
    } catch {
      // Discovery is a bounded recovery path; the next event or interval retries it.
    } finally {
      this.resyncing = false
    }
  }

  async close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
    clearInterval(this.scanTimer)
    this.timer = undefined
    this.scanTimer = undefined
    this.signal.removeEventListener("abort", this.onAbort)
    this.watchController?.abort()
    const cleanup = [...this.active.values()].map(async (entry) => {
      entry.controller.abort(new Error("Desktop inference relay stopped"))
      if (entry.workerStarted) {
        await this.settle(entry, {
          status: "error",
          uncertain: true,
          error:
            "Desktop relay stopped after forwarding; inference completion is uncertain and the request was not replayed",
        })
      } else {
        await this.recover(entry)
      }
    })
    await Promise.allSettled(cleanup)
  }

  private readonly onAbort = () => {
    void this.close()
  }

  private currentClient() {
    try {
      return this.getClient()
    } catch {
      return undefined
    }
  }

  private observeClient() {
    const current = this.currentClient()
    if (current === this.client) return
    this.client = current
    this.watchController?.abort()
    this.scanning.clear()
    if (this.closed) return
    for (const entry of this.active.values()) {
      if (entry.workerStarted && entry.client !== current) {
        entry.controller.abort(new Error("Desktop connection changed after forwarding"))
        void this.settle(entry, {
          status: "error",
          uncertain: true,
          error: current
            ? "Desktop connection changed after forwarding; inference completion is uncertain and the request was not replayed"
            : "Desktop connection disconnected after forwarding; inference completion is uncertain and the request was not replayed",
        })
      }
    }
    if (!current) return
    const controller = new AbortController()
    this.watchController = controller
    void this.watchEvents(current, controller.signal)
    void this.resync()
  }

  private async watchEvents(client: OpenCodeClient, signal: AbortSignal) {
    while (!signal.aborted && !this.closed) {
      try {
        for await (const event of client.event.subscribe({ signal })) {
          if (signal.aborted || this.closed) return
          if (this.currentClient() !== client) return
          await this.handleEvent(event)
        }
      } catch {
        // Event streams are live-only. Reconnect and resync rather than assuming replay.
      }
      if (signal.aborted || this.closed) return
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500)
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true },
        )
      })
    }
  }

  private async scanLocation(directory: string) {
    if (this.closed) return
    const actualClient = this.currentClient()
    if (!actualClient) return
    if (this.scanning.get(directory) === actualClient) {
      this.rescanRequested.add(directory)
      return
    }
    this.scanning.set(directory, actualClient)
    try {
      const signal = timeoutSignal(this.watchController?.signal ?? this.signal)
      const relay = actualClient.rpc(InferenceRelay)
      const result = await relay.discover({}, { location: { directory }, signal })
      if (this.currentClient() !== actualClient || this.closed) return
      for (const request of result.requests)
        this.observeRequest(directory, request.requestID, request.state)
    } catch {
      // A location may unload between enumeration and RPC; its caller retains its own deadline.
    } finally {
      if (this.scanning.get(directory) === actualClient) this.scanning.delete(directory)
      if (this.rescanRequested.delete(directory) && !this.closed) void this.scanLocation(directory)
    }
  }

  private observeRequest(
    directory: string,
    requestID: string,
    state: "pending" | "claimed" | "delivered" | "cancelled",
  ) {
    const key = requestKey(directory, requestID)
    const active = this.active.get(key)
    if (state === "cancelled") {
      if (active) active.controller.abort(new Error("Inference cancelled by its location"))
      void this.acknowledge(directory, requestID)
      return
    }
    if (state === "pending") {
      if (active) {
        if (active.phase === "claiming") void this.claimAndDeliver(active)
      } else this.claimAndDeliver(this.makeActive(directory, requestID))
      return
    }
    if (active) {
      if (state === "claimed" && active.phase === "claiming") void this.claimAndDeliver(active)
      return
    }
    void this.recoverOrphan(directory, requestID)
  }

  private makeActive(directory: string, requestID: string) {
    const entry: ActiveRequest = {
      key: requestKey(directory, requestID),
      directory,
      requestID,
      claimToken: crypto.randomUUID(),
      controller: new AbortController(),
      phase: "claiming",
      working: false,
      workerStarted: false,
      settled: false,
    }
    if (this.active.size >= MAX_IN_FLIGHT) return undefined
    this.active.set(entry.key, entry)
    return entry
  }

  private claimAndDeliver(entry: ActiveRequest | undefined) {
    if (!entry || entry.working || entry.settled || this.closed) return
    entry.working = true
    void this.run(entry).finally(() => {
      entry.working = false
    })
  }

  private async run(entry: ActiveRequest) {
    try {
      const claimClient = this.currentClient()
      if (!claimClient) return
      const claimSignal = timeoutSignal(this.watchController?.signal ?? this.signal)
      const relay = claimClient.rpc(InferenceRelay)
      const request = await relay.claim(
        { requestID: entry.requestID, claimToken: entry.claimToken },
        { location: { directory: entry.directory }, signal: claimSignal },
      )
      if (entry.settled || this.closed) return
      if (!request) {
        this.active.delete(entry.key)
        return
      }
      entry.phase = "claiming"
      const beginClient = this.currentClient()
      if (!beginClient) return
      const begun = await beginClient.rpc(InferenceRelay).begin(
        { requestID: entry.requestID, claimToken: entry.claimToken },
        {
          location: { directory: entry.directory },
          signal: timeoutSignal(this.watchController?.signal ?? this.signal),
        },
      )
      if (entry.settled || this.closed) return
      if (!begun) {
        this.active.delete(entry.key)
        return
      }

      const remaining =
        begun.deadlineAt === null ? Number.POSITIVE_INFINITY : begun.deadlineAt - this.now()
      if (
        remaining <= 0 ||
        (begun.method !== "settings" && begun.method !== "configure" && remaining < 1_000)
      ) {
        await this.settle(entry, {
          status: "error",
          uncertain: false,
          error: "Local inference deadline exceeded before delivery",
        })
        return
      }

      const current = this.currentClient()
      if (!current) {
        await this.settle(entry, {
          status: "error",
          uncertain: false,
          error: "The authenticated Desktop connection is unavailable before inference delivery",
        })
        return
      }
      entry.phase = "delivering"
      entry.client = current
      const input = adjustedInput(begun, remaining)
      const signal = AbortSignal.any([
        this.signal,
        entry.controller.signal,
        ...(Number.isFinite(remaining) ? [AbortSignal.timeout(remaining)] : []),
      ])
      entry.workerStarted = true
      const result = await forward(current, begun, input, signal)
      if (entry.settled) return
      if (entry.controller.signal.aborted) {
        await this.acknowledge(entry.directory, entry.requestID)
        this.active.delete(entry.key)
        entry.settled = true
        return
      }
      if (this.currentClient() !== current) {
        await this.settle(entry, {
          status: "error",
          uncertain: true,
          error:
            "Desktop connection changed after forwarding; inference completion is uncertain and the request was not replayed",
        })
        return
      }
      await this.settle(entry, { status: "result", value: result })
    } catch (error) {
      if (entry.settled) return
      if (entry.controller.signal.aborted && !entry.workerStarted) {
        await this.recover(entry)
        return
      }
      const replaced = entry.workerStarted && this.currentClient() !== entry.client
      const uncertain = entry.workerStarted
      const reason = replaced
        ? "Desktop connection changed after forwarding; inference completion is uncertain and the request was not replayed"
        : uncertain
          ? `Desktop inference transport failed after forwarding; completion is uncertain and the request was not replayed: ${String(error)}`
          : `Desktop inference relay failed before delivery: ${String(error)}`
      await this.settle(entry, { status: "error", uncertain, error: reason })
    }
  }

  private async settle(entry: ActiveRequest, completion: RelayCompletion) {
    if (entry.settled) return
    entry.settled = true
    entry.controller.abort()
    this.active.delete(entry.key)
    const client = this.currentClient()
    if (!client) return
    try {
      await client.rpc(InferenceRelay).complete(
        { requestID: entry.requestID, claimToken: entry.claimToken, completion },
        {
          location: { directory: entry.directory },
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        },
      )
    } catch {
      // The caller's existing deadline remains authoritative; this request is never replayed.
    }
  }

  private async recover(entry: ActiveRequest) {
    if (entry.settled) return
    entry.settled = true
    entry.controller.abort()
    this.active.delete(entry.key)
    const client = this.currentClient()
    if (!client) return
    try {
      await client.rpc(InferenceRelay).recover(
        { requestID: entry.requestID },
        {
          location: { directory: entry.directory },
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        },
      )
    } catch {
      // An unreachable source will settle its own pending request at its deadline.
    }
  }

  private async recoverOrphan(directory: string, requestID: string) {
    const key = requestKey(directory, requestID)
    if (this.active.has(key) || this.closed) return
    const client = this.currentClient()
    if (!client) return
    try {
      await client
        .rpc(InferenceRelay)
        .recover(
          { requestID },
          { location: { directory }, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) },
        )
    } catch {
      // Retain explicit source-side deadlines when the authenticated connection is unavailable.
    }
  }

  private async acknowledge(directory: string, requestID: string) {
    const client = this.currentClient()
    if (!client) return
    try {
      await client
        .rpc(InferenceRelay)
        .acknowledge(
          { requestID },
          { location: { directory }, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) },
        )
    } catch {
      // Cancellation tombstones are bounded and contain no inference payload.
    }
  }
}
