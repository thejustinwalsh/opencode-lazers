import { Worker } from "node:worker_threads"
import { workerURL } from "../worker-url.ts"
import type {
  RetentionEstimateStatus,
  RetentionReadRequest,
  RetentionReadResult,
} from "./reader-protocol.ts"
import type { RetentionPreview } from "./retention.ts"
import type { WorktreeCandidates } from "./worktrees.ts"

type Pending = {
  worker: RetentionReaderWorker
  resolve(value: unknown): void
  reject(error: Error): void
}

export type RetentionReaderWorker = {
  on(event: "message", listener: (message: RetentionReadResult) => void): unknown
  on(event: "error", listener: (error: Error) => void): unknown
  on(event: "exit", listener: (code: number) => void): unknown
  once(event: "exit", listener: (code: number) => void): unknown
  postMessage(message: RetentionReadRequest): void
  unref(): unknown
  terminate(): Promise<number>
}

type RetentionReaderWorkerFactory = (
  url: URL,
  options: { workerData: { path: string } },
) => RetentionReaderWorker

type RetentionReadCall =
  | Omit<Extract<RetentionReadRequest, { type: "status" }>, "id">
  | Omit<Extract<RetentionReadRequest, { type: "preview" }>, "id">
  | Omit<Extract<RetentionReadRequest, { type: "worktrees" }>, "id">

const CLOSE_GRACE_MS = 1_000

/**
 * One lazy reader for a RetentionService owner. It serializes estimates on one worker connection;
 * failures reject the current read and the next request can replace the failed worker.
 */
export class RetentionReader {
  private worker: RetentionReaderWorker | undefined
  private sequence = 0
  private closed = false
  private queue: Promise<unknown> = Promise.resolve()
  private readonly pending = new Map<number, Pending>()

  constructor(
    private readonly path: string,
    private readonly url = workerURL("./retention-reader-worker", import.meta.url),
    private readonly createWorker: RetentionReaderWorkerFactory = (url, options) =>
      new Worker(url, options),
  ) {}

  status(input: { now: number; dataDirectory: string }): Promise<RetentionEstimateStatus> {
    return this.enqueue({ type: "status", ...input }) as Promise<RetentionEstimateStatus>
  }

  preview(input: {
    now: number
    days: number
    dataDirectory: string
    projectDirectory: string
  }): Promise<{ preview: RetentionPreview; worktrees: WorktreeCandidates }> {
    return this.enqueue({ type: "preview", ...input }) as Promise<{
      preview: RetentionPreview
      worktrees: WorktreeCandidates
    }>
  }

  worktrees(input: {
    now: number
    days: number
    projectDirectory: string
  }): Promise<WorktreeCandidates> {
    return this.enqueue({ type: "worktrees", ...input }) as Promise<WorktreeCandidates>
  }

  private enqueue(request: RetentionReadCall) {
    const result = this.queue.then(() => this.call(request))
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private acquire(): RetentionReaderWorker {
    if (this.closed) throw new Error("Retention reader is closed")
    if (this.worker) return this.worker
    const created = this.createWorker(this.url, { workerData: { path: this.path } })
    created.unref()
    this.worker = created
    created.on("message", (message: RetentionReadResult) => {
      if (message.type === "closed") return
      const entry = this.pending.get(message.id)
      if (!entry || entry.worker !== created) return
      this.pending.delete(message.id)
      if (message.type === "error") entry.reject(new Error(message.message))
      else if (message.type === "preview")
        entry.resolve({ preview: message.preview, worktrees: message.worktrees })
      else if (message.type === "worktrees") entry.resolve(message.worktrees)
      else entry.resolve(message.value)
    })
    const dead = (error: Error) => {
      if (this.worker === created) this.worker = undefined
      for (const [id, entry] of this.pending) {
        if (entry.worker !== created) continue
        this.pending.delete(id)
        entry.reject(error)
      }
    }
    created.on("error", (error) => dead(error instanceof Error ? error : new Error(String(error))))
    created.on("exit", (code) => {
      if (!this.closed) dead(new Error(`Retention reader exited with code ${code}`))
      if (this.worker === created) this.worker = undefined
    })
    return created
  }

  private call(request: RetentionReadCall): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Retention reader is closed"))
    let worker: RetentionReaderWorker
    try {
      worker = this.acquire()
    } catch (error) {
      return Promise.reject(error)
    }
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { worker, resolve, reject })
      try {
        worker.postMessage({ ...request, id } as RetentionReadRequest)
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async close() {
    if (this.closed) return
    this.closed = true
    const worker = this.worker
    this.worker = undefined
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      entry.reject(new Error("Retention reader closed"))
    }
    if (!worker) return
    try {
      await new Promise<void>((resolve) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(finish, CLOSE_GRACE_MS)
        worker.on("message", (message: RetentionReadResult) => {
          if (message.type === "closed") finish()
        })
        worker.once("exit", finish)
        try {
          worker.postMessage({ type: "close" } satisfies RetentionReadRequest)
        } catch {
          finish()
        }
      })
    } finally {
      await worker.terminate()
    }
  }
}
