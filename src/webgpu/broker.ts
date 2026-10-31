import type { InferenceJob, InferenceRequest, InferenceResult } from "./rpc.ts"
import { DEFAULT_VOICE } from "./speech.ts"
import type { SpeechVoice } from "./speech.ts"

export const failed = (error: string): InferenceResult => ({
  ok: false,
  text: "",
  error: error.slice(0, 2_000),
  promptTokens: 0,
  completionTokens: 0,
})

/** A bounded reverse-call mailbox. Polling resynchronizes after transport loss without relying on event replay. */
export class InferenceBroker {
  private owner: string | undefined
  private heartbeat = 0
  private pending:
    { job: InferenceJob; delivered: boolean; finish: (result: InferenceResult) => void } | undefined
  private cancelled: string | null = null
  private queue: {
    job: InferenceJob
    delivered: boolean
    finish: (result: InferenceResult) => void
  }[] = []

  constructor(
    private readonly now = Date.now,
    private readonly heartbeatMs = 15_000,
  ) {}

  attach(owner: string) {
    this.expire()
    if (!owner || owner.length > 100) throw new Error("Invalid renderer owner")
    if (this.owner && this.owner !== owner) throw new Error("Another renderer owns inference")
    this.owner = owner
    this.heartbeat = this.now()
  }

  detach(owner: string, error?: string) {
    this.assertOwner(owner)
    if (error) this.close(error.slice(0, 2_000))
    else this.disconnect("Desktop renderer disconnected")
  }

  private assertOwner(owner: string) {
    this.expire()
    if (owner !== this.owner) throw new Error("Renderer ownership was lost")
  }

  poll(owner: string, available = true) {
    this.assertOwner(owner)
    this.heartbeat = this.now()
    if (!this.pending && !this.cancelled && available) this.pending = this.queue.shift()
    const pending = this.pending
    const job = pending && !pending.delivered ? pending.job : null
    if (pending) pending.delivered = true
    return { job, cancelID: this.cancelled }
  }

  complete(owner: string, id: string, result: InferenceResult) {
    this.assertOwner(owner)
    if (
      result.text.length > 64_000 ||
      result.error.length > 2_000 ||
      (result.audioBase64?.length ?? 0) > 4_000_000
    )
      throw new Error("Oversized inference result")
    if (this.cancelled === id) this.cancelled = null
    if (this.pending?.job.id === id) this.pending.finish(result)
  }

  expire() {
    if (this.owner && this.now() - this.heartbeat > this.heartbeatMs)
      this.disconnect("Desktop renderer heartbeat was lost")
  }

  private disconnect(reason: string) {
    // Never replay a delivered request. Unstarted requests keep their original deadlines.
    this.pending?.finish(failed(reason))
    this.owner = undefined
    this.cancelled = null
  }

  demand() {
    return { requested: Boolean(this.pending || this.queue.length) }
  }

  generate(
    request: InferenceRequest & {
      mode?: "speak" | "systemone"
      audioBase64?: string
      requestID?: string
      voice?: SpeechVoice
      feature?: InferenceJob["feature"]
    },
    signal: AbortSignal,
  ): Promise<InferenceResult> {
    this.expire()
    if (this.queue.length + Number(Boolean(this.pending)) >= 8)
      return Promise.resolve(failed("Local inference queue is full (8 requests)"))
    if (
      !request.prompt.trim() ||
      request.prompt.length > 8_000 ||
      !Number.isInteger(request.maxTokens) ||
      request.maxTokens < 1 ||
      request.maxTokens > 512 ||
      !Number.isInteger(request.timeoutMs) ||
      request.timeoutMs < 1_000 ||
      request.timeoutMs > 120_000
    )
      return Promise.resolve(failed("Inference request exceeds the experiment limits"))
    if (signal.aborted) return Promise.resolve(failed("Inference cancelled"))
    return new Promise((resolve) => {
      let settled = false
      const id = crypto.randomUUID()
      const job: InferenceJob = {
        ...request,
        id,
        mode: request.mode ?? (request.audioBase64 ? "transcribe" : "text"),
        audioBase64: request.audioBase64 ?? "",
        requestID: request.requestID ?? id,
        voice: request.voice ?? DEFAULT_VOICE,
        feature:
          request.feature ??
          (request.mode === "systemone"
            ? "decisions"
            : request.mode === "speak"
              ? "readAloud"
              : request.audioBase64
                ? "dictation"
                : "questions"),
      }
      const finish = (result: InferenceResult) => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        signal.removeEventListener("abort", abort)
        if (this.pending?.job.id === job.id) this.pending = undefined
        this.queue = this.queue.filter((item) => item.job.id !== job.id)
        resolve(result)
      }
      const cancel = (message: string) => {
        if (this.pending?.job.id === job.id && this.pending.delivered) this.cancelled = job.id
        finish(failed(message))
      }
      const abort = () => cancel("Inference cancelled")
      const deadline = setTimeout(
        () => cancel("Local inference deadline exceeded"),
        request.timeoutMs,
      )
      signal.addEventListener("abort", abort, { once: true })
      this.queue.push({ job, delivered: false, finish })
    })
  }

  close(reason = "WebGPU plugin unloaded") {
    this.pending?.finish(failed(reason))
    for (const pending of [...this.queue]) pending.finish(failed(reason))
    this.owner = undefined
    this.cancelled = null
  }

  cancelWhere(disabled: (job: InferenceJob) => boolean, reason: string) {
    const current = this.pending
    if (current && disabled(current.job)) {
      if (current.delivered) this.cancelled = current.job.id
      current.finish(failed(reason))
    }
    for (const item of [...this.queue]) if (disabled(item.job)) item.finish(failed(reason))
  }
}
