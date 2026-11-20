import type { OpenCodeClient } from "@opencode/client/promise"
import { RendererInference } from "../rpc.ts"
import type { RelayCompletion, RelayRequestEnvelope } from "./protocol.ts"
import { InferenceRelay } from "./protocol.ts"

const RESYNC_INTERVAL_MS = 2_000
const CLIENT_CHECK_INTERVAL_MS = 250
const RPC_TIMEOUT_MS = 2_000
const MAX_RESYNC_LOCATIONS = 32
const MAX_DISCOVERY_CONCURRENCY = 8
const MAX_QUEUED_DISCOVERIES = MAX_RESYNC_LOCATIONS
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

type RelayRpcOptions = { location: { directory: string }; signal: AbortSignal }

type MainRelayOptions = {
  now?: () => number
}

const isRelayEvent = (event: unknown): event is RelayEvent => {
  if (typeof event !== "object" || event === null) return false
  if (
    !("type" in event) ||
    (event.type !== `rpc.${InferenceRelay.id}.available` &&
      event.type !== `rpc.${InferenceRelay.id}.cancelled`)
  )
    return false
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
  if (remainingMs <= 0) throw new Error("Local inference deadline exceeded before delivery")
  if (typeof request.input !== "object" || request.input === null || Array.isArray(request.input))
    throw new Error("Invalid relayed inference request")
  return request.input
}

async function boundedRpc<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Desktop inference relay RPC timed out")),
          RPC_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
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

// All relay instances in the Desktop main-process module coordinate ownership.
// A separate instance must not mistake another live instance's claim for an orphan.
const liveRequests = new Map<string, ActiveRequest>()

/** Main-process bridge from location-owned public RPCs to the default renderer mailbox. */
export class DesktopInferenceRelay {
  private readonly now: () => number
  private readonly active = new Map<string, ActiveRequest>()
  private readonly scanning = new Map<string, OpenCodeClient>()
  private readonly rescanRequested = new Set<string>()
  private readonly scanQueue = new Set<string>()
  private client: OpenCodeClient | undefined
  private watchController: AbortController | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private scanTimer: ReturnType<typeof setInterval> | undefined
  private locationCursor = 0
  private activeScans = 0
  private resyncing = false
  private resyncScheduled = false
  private closed = false
  private closing: Promise<void> | undefined

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

  handleEvent(value: unknown) {
    if (!isRelayEvent(value)) {
      if (
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        value.type === "server.connected"
      )
        this.scheduleResync()
      return
    }
    const requestID = eventID(value)
    const key = requestKey(value.location.directory, requestID)
    if (value.type === `rpc.${InferenceRelay.id}.cancelled`) this.cancelActive(key)
    this.scheduleScan(value.location.directory)
  }

  private scheduleResync() {
    if (this.closed || this.resyncScheduled) return
    this.resyncScheduled = true
    queueMicrotask(() => {
      this.resyncScheduled = false
      void this.resync()
    })
  }

  async resync() {
    if (this.closed || this.resyncing) return
    const client = this.currentClient()
    if (!client) return
    this.resyncing = true
    const controller = this.watchController
    try {
      const signal = timeoutSignal(controller?.signal ?? this.signal)
      const locations = await boundedRpc(client.debug.location.list({ signal }))
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
      for (const directory of batch) this.scheduleScan(directory)
    } catch {
      // Discovery is a bounded recovery path; the next event or interval retries it.
    } finally {
      this.resyncing = false
    }
  }

  close() {
    if (this.closing) return this.closing
    if (this.closed) return Promise.resolve()
    this.closed = true
    clearInterval(this.timer)
    clearInterval(this.scanTimer)
    this.timer = undefined
    this.scanTimer = undefined
    this.signal.removeEventListener("abort", this.onAbort)
    this.watchController?.abort()
    this.scanQueue.clear()
    this.rescanRequested.clear()
    const cleanup = [...this.active.values()].map((entry) => {
      entry.controller.abort(new Error("Desktop inference relay stopped"))
      if (entry.workerStarted) {
        return this.settle(entry, {
          status: "error",
          uncertain: true,
          error:
            "Desktop relay stopped after forwarding; inference completion is uncertain and the request was not replayed",
        })
      } else {
        return this.recover(entry)
      }
    })
    this.closing = Promise.allSettled(cleanup).then(() => {})
    return this.closing
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
    this.scanQueue.clear()
    this.rescanRequested.clear()
    if (this.closed) return
    for (const entry of this.active.values()) {
      if (entry.client !== current) {
        const reason = current
          ? "Desktop connection changed after forwarding"
          : "Desktop connection disconnected after forwarding"
        entry.controller.abort(new Error(reason))
        if (entry.workerStarted) {
          void this.settle(entry, {
            status: "error",
            uncertain: true,
            error: `${reason}; inference completion is uncertain and the request was not replayed`,
          })
        } else {
          void this.recover(entry)
        }
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
          this.handleEvent(event)
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

  private scheduleScan(directory: string) {
    if (this.closed) return
    const actualClient = this.currentClient()
    if (!actualClient) return
    if (this.scanning.get(directory) === actualClient) {
      this.rescanRequested.add(directory)
      return
    }
    if (this.scanQueue.has(directory) || this.scanQueue.size >= MAX_QUEUED_DISCOVERIES) return
    this.scanQueue.add(directory)
    this.pumpScans()
  }

  private pumpScans() {
    while (!this.closed && this.activeScans < MAX_DISCOVERY_CONCURRENCY && this.scanQueue.size) {
      const directory = this.scanQueue.values().next().value as string | undefined
      if (directory === undefined) return
      this.scanQueue.delete(directory)
      const client = this.currentClient()
      if (!client) return
      if (this.scanning.get(directory) === client) {
        this.rescanRequested.add(directory)
        continue
      }
      this.activeScans++
      void this.scanLocation(directory, client).finally(() => {
        this.activeScans--
        this.pumpScans()
      })
    }
  }

  private async scanLocation(directory: string, actualClient: OpenCodeClient) {
    if (this.closed || this.currentClient() !== actualClient) return
    this.scanning.set(directory, actualClient)
    try {
      const signal = timeoutSignal(this.watchController?.signal ?? this.signal)
      const relay = actualClient.rpc(InferenceRelay)
      const result = await boundedRpc(relay.discover({}, { location: { directory }, signal }))
      if (this.currentClient() !== actualClient || this.closed) return
      for (const request of result.requests)
        this.observeRequest(directory, request.requestID, request.state)
    } catch {
      // A location may unload between enumeration and RPC; its caller retains its own deadline.
    } finally {
      if (this.scanning.get(directory) === actualClient) this.scanning.delete(directory)
      if (
        this.rescanRequested.delete(directory) &&
        !this.closed &&
        this.currentClient() === actualClient
      )
        this.scheduleScan(directory)
    }
  }

  private cancelActive(key: string) {
    const entry = this.active.get(key)
    if (!entry) return
    entry.controller.abort(new Error("Inference cancelled by its location"))
    if (!entry.workerStarted) {
      entry.settled = true
      this.forget(entry)
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
      this.cancelActive(key)
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
    if (this.active.size >= MAX_IN_FLIGHT || liveRequests.has(entry.key)) return undefined
    this.active.set(entry.key, entry)
    liveRequests.set(entry.key, entry)
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
      const claimClient = await this.claim(entry)
      if (!claimClient) return
      const request = await this.begin(entry, claimClient)
      if (!request) return
      await this.deliver(entry, claimClient, request)
    } catch (error) {
      await this.fail(entry, error)
    }
  }

  private async claim(entry: ActiveRequest) {
    const client = this.currentClient()
    if (!client) {
      await this.recover(entry)
      return
    }
    entry.client = client
    const request = await boundedRpc(this.requestRpc(client, entry, "claim"))
    if (entry.settled || this.closed) return
    if (!request) {
      entry.settled = true
      this.forget(entry)
      return
    }
    return client
  }

  private async begin(entry: ActiveRequest, claimClient: OpenCodeClient) {
    entry.phase = "claiming"
    const client = this.currentClient()
    if (!client || client !== claimClient) {
      await this.recover(entry)
      return
    }
    const request = await boundedRpc(this.requestRpc(client, entry, "begin"))
    if (entry.settled || this.closed) return
    if (!request) {
      entry.settled = true
      this.forget(entry)
      return
    }
    if (this.currentClient() !== client) {
      await this.recover(entry)
      return
    }
    return request
  }

  private requestRpc(client: OpenCodeClient, entry: ActiveRequest, method: "claim" | "begin") {
    const relay = client.rpc(InferenceRelay)
    const input = { requestID: entry.requestID, claimToken: entry.claimToken }
    const options = {
      location: { directory: entry.directory },
      signal: this.requestSignal(entry),
    }
    return method === "claim" ? relay.claim(input, options) : relay.begin(input, options)
  }

  private async deliver(
    entry: ActiveRequest,
    client: OpenCodeClient,
    request: RelayRequestEnvelope,
  ) {
    const remaining =
      request.deadlineAt === null ? Number.POSITIVE_INFINITY : request.deadlineAt - this.now()
    if (remaining <= 0) {
      await this.settle(entry, {
        status: "error",
        uncertain: false,
        error: "Local inference deadline exceeded before delivery",
      })
      return
    }

    entry.phase = "delivering"
    entry.client = client
    const input = adjustedInput(request, remaining)
    const signal = AbortSignal.any([
      this.signal,
      entry.controller.signal,
      ...(Number.isFinite(remaining) ? [AbortSignal.timeout(remaining)] : []),
    ])
    entry.workerStarted = true
    const result = await forward(client, request, input, signal)
    await this.finishDelivery(entry, client, signal, request.deadlineAt, result)
  }

  private async finishDelivery(
    entry: ActiveRequest,
    client: OpenCodeClient,
    signal: AbortSignal,
    deadlineAt: number | null,
    result: unknown,
  ) {
    if (entry.settled) return
    if (entry.controller.signal.aborted) {
      await this.acknowledge(entry.directory, entry.requestID)
      entry.settled = true
      this.forget(entry)
      return
    }
    if (signal.aborted || (deadlineAt !== null && this.now() >= deadlineAt)) {
      await this.settle(entry, {
        status: "error",
        uncertain: true,
        error:
          "Local inference deadline elapsed after forwarding; completion is uncertain and the request was not replayed",
      })
      return
    }
    if (this.currentClient() !== client) {
      await this.settle(entry, {
        status: "error",
        uncertain: true,
        error:
          "Desktop connection changed after forwarding; inference completion is uncertain and the request was not replayed",
      })
      return
    }
    await this.settle(entry, { status: "result", value: result })
  }

  private async fail(entry: ActiveRequest, error: unknown) {
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

  private requestSignal(entry: ActiveRequest) {
    const watchSignal = this.watchController?.signal
    return AbortSignal.any([
      this.signal,
      entry.controller.signal,
      ...(watchSignal ? [watchSignal] : []),
      AbortSignal.timeout(RPC_TIMEOUT_MS),
    ])
  }

  private releaseLocal(entry: ActiveRequest) {
    if (this.active.get(entry.key) === entry) this.active.delete(entry.key)
  }

  private forget(entry: ActiveRequest) {
    this.releaseLocal(entry)
    if (liveRequests.get(entry.key) === entry) liveRequests.delete(entry.key)
  }

  private async sourceRpc<T>(
    directory: string,
    invoke: (client: OpenCodeClient, options: RelayRpcOptions) => Promise<T>,
  ) {
    const client = this.currentClient()
    if (!client) return
    try {
      return await boundedRpc(
        invoke(client, {
          location: { directory },
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        }),
      )
    } catch {
      // The source keeps its deadline and never replays delivered work.
    }
  }

  private settle(entry: ActiveRequest, completion: RelayCompletion) {
    return this.finish(entry, (client, options) =>
      client
        .rpc(InferenceRelay)
        .complete(
          { requestID: entry.requestID, claimToken: entry.claimToken, completion },
          options,
        ),
    )
  }

  private recover(entry: ActiveRequest) {
    return this.finish(entry, (client, options) =>
      client.rpc(InferenceRelay).recover({ requestID: entry.requestID }, options),
    )
  }

  private async finish(
    entry: ActiveRequest,
    invoke: (client: OpenCodeClient, options: RelayRpcOptions) => Promise<unknown>,
  ) {
    if (entry.settled) return
    entry.settled = true
    entry.controller.abort()
    this.releaseLocal(entry)
    try {
      await this.sourceRpc(entry.directory, invoke)
    } finally {
      this.forget(entry)
    }
  }

  private async recoverOrphan(directory: string, requestID: string) {
    const key = requestKey(directory, requestID)
    if (this.active.has(key) || liveRequests.has(key) || this.closed) return
    await this.sourceRpc(directory, (client, options) =>
      client.rpc(InferenceRelay).recover({ requestID }, options),
    )
  }

  private async acknowledge(directory: string, requestID: string) {
    await this.sourceRpc(directory, (client, options) =>
      client.rpc(InferenceRelay).acknowledge({ requestID }, options),
    )
  }
}
