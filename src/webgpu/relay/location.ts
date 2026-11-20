import type {
  RelayCompletion,
  RelayRequestEnvelope,
  RelayRequestMethod,
  RelayRequestState,
} from "./protocol.ts"

export const MAX_LOCATION_REQUESTS = 8
const CANCELLED_RETENTION_MS = 30_000
const MAX_RELAY_RECORDS = MAX_LOCATION_REQUESTS * 2

type Notify = (event: "available" | "cancelled", requestID: string) => void
type Entry = {
  request: RelayRequestEnvelope | undefined
  state: RelayRequestState
  claimToken: string | undefined
  finish: (completion: RelayCompletion) => void
  cancel: (reason: string) => void
  deadline: ReturnType<typeof setTimeout> | undefined
  retention?: ReturnType<typeof setTimeout>
  removeAbort: () => void
}

function timeoutFor(method: RelayRequestMethod, input: unknown) {
  if (method === "settings" || method === "configure") return undefined
  if (typeof input === "object" && input !== null && "timeoutMs" in input) {
    const timeoutMs = input.timeoutMs
    if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs))
      return Math.max(1_000, Math.min(120_000, Math.trunc(timeoutMs)))
  }
  return undefined
}

export class LocationInferenceRelay {
  private readonly entries = new Map<string, Entry>()
  private closed = false

  constructor(
    private readonly notify: Notify = () => {},
    private readonly now = Date.now,
  ) {}

  forward(method: RelayRequestMethod, input: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Local inference location is unavailable"))
    if (signal.aborted) return Promise.reject(new Error("Inference cancelled before delivery"))
    this.expireDue()
    const active = [...this.entries.values()].filter((entry) => entry.state !== "cancelled").length
    if (active >= MAX_LOCATION_REQUESTS || this.entries.size >= MAX_RELAY_RECORDS)
      return Promise.reject(
        new Error(`Local inference relay is full (${MAX_LOCATION_REQUESTS} requests)`),
      )

    const id = crypto.randomUUID()
    const timeoutMs = timeoutFor(method, input)
    const request: RelayRequestEnvelope = {
      requestID: id,
      method,
      input,
      deadlineAt: timeoutMs === undefined ? null : this.now() + timeoutMs,
    }

    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (completion: RelayCompletion) => {
        if (settled) return
        settled = true
        if (entry.deadline) clearTimeout(entry.deadline)
        if (entry.retention) clearTimeout(entry.retention)
        entry.removeAbort()
        if (completion.status === "result") resolve(completion.value)
        else reject(new Error(completion.error))
      }
      const cancel = (reason: string) => {
        if (settled) return
        const delivered = entry.state === "delivered"
        entry.state = "cancelled"
        entry.request = undefined
        entry.claimToken = undefined
        const message = delivered
          ? `${reason}; delivered inference may still be completing and will not be replayed`
          : `${reason} before inference delivery`
        finish({ status: "error", error: message, uncertain: delivered })
        this.notify("cancelled", id)
        entry.retention = setTimeout(() => this.entries.delete(id), CANCELLED_RETENTION_MS)
      }
      const onAbort = () => cancel("Inference cancelled")
      const removeAbort = () => signal.removeEventListener("abort", onAbort)
      const entry: Entry = {
        request,
        state: "pending",
        claimToken: undefined,
        finish,
        cancel,
        deadline:
          timeoutMs === undefined
            ? undefined
            : setTimeout(() => cancel("Local inference deadline exceeded"), timeoutMs),
        removeAbort,
      }
      this.entries.set(id, entry)
      signal.addEventListener("abort", onAbort, { once: true })
      this.notify("available", id)
    })
  }

  discover() {
    this.expireDue()
    return {
      requests: [...this.entries.entries()].map(([requestID, entry]) => ({
        requestID,
        state: entry.state,
      })),
    }
  }

  claim(requestID: string, claimToken: string) {
    const entry = this.entries.get(requestID)
    if (!entry || this.expireIfDue(entry) || !entry.request) return null
    if (entry.state === "pending") {
      entry.state = "claimed"
      entry.claimToken = claimToken
    } else if (
      (entry.state !== "claimed" && entry.state !== "delivered") ||
      entry.claimToken !== claimToken
    )
      return null
    return entry.request
  }

  begin(requestID: string, claimToken: string) {
    const entry = this.entries.get(requestID)
    if (!entry || this.expireIfDue(entry) || !entry.request || entry.claimToken !== claimToken)
      return null
    if (entry.state === "claimed") entry.state = "delivered"
    else if (entry.state !== "delivered") return null
    return entry.request
  }

  complete(requestID: string, claimToken: string, completion: RelayCompletion) {
    const entry = this.entries.get(requestID)
    if (!entry) return false
    if (entry.state === "cancelled") {
      this.remove(requestID, entry)
      return false
    }
    if (entry.claimToken !== claimToken) return false
    if (entry.state !== "claimed" && entry.state !== "delivered") return false
    if (this.expireIfDue(entry)) return false
    this.remove(requestID, entry)
    entry.finish(completion)
    return true
  }

  recover(requestID: string, claimToken: string) {
    const entry = this.entries.get(requestID)
    if (!entry || entry.claimToken !== claimToken) return false
    if (entry.state !== "claimed" && entry.state !== "delivered") return false
    const delivered = entry.state === "delivered"
    this.remove(requestID, entry)
    entry.finish({
      status: "error",
      error: delivered
        ? "Desktop relay restarted after forwarding; inference completion is uncertain and the request was not replayed"
        : "Desktop relay restarted before inference delivery; the request was not replayed",
      uncertain: delivered,
    })
    return true
  }

  acknowledge(requestID: string) {
    const entry = this.entries.get(requestID)
    if (!entry || entry.state !== "cancelled") return false
    this.remove(requestID, entry)
    return true
  }

  close(reason = "Local inference location was unloaded") {
    if (this.closed) return
    this.closed = true
    for (const [id, entry] of this.entries) {
      if (entry.state === "cancelled") {
        this.remove(id, entry)
        continue
      }
      const delivered = entry.state === "delivered"
      entry.cancel(
        delivered
          ? `${reason}; delivered inference completion is uncertain`
          : `${reason} before inference delivery`,
      )
      this.remove(id, entry)
    }
  }

  private remove(id: string, entry: Entry) {
    if (entry.deadline) clearTimeout(entry.deadline)
    if (entry.retention) clearTimeout(entry.retention)
    entry.removeAbort()
    this.entries.delete(id)
  }

  private expireDue() {
    for (const entry of this.entries.values()) this.expireIfDue(entry)
  }

  private expireIfDue(entry: Entry) {
    const deadlineAt = entry.request?.deadlineAt
    if (deadlineAt === null || deadlineAt === undefined || deadlineAt > this.now()) return false
    entry.cancel("Local inference deadline exceeded")
    return true
  }
}
