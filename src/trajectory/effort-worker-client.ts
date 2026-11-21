import { Worker } from "node:worker_threads"
import type { PriceInputs } from "../models/price-state.ts"
import { workerURL } from "../worker-url.ts"
import type { EffortRow, TaskEffortCompute } from "./effort-compute.ts"

export type EffortWorkerRequest =
  | {
      type: "compute"
      id: number
      projectDirectory: string
      projectID: string
      taskID: string
      inputs: PriceInputs
    }
  | { type: "cancel"; id: number }

export type EffortWorkerResponse =
  | { type: "result"; id: number; row: EffortRow | null }
  | { type: "error"; id: number; message: string }

type Pending = { resolve(row: EffortRow | undefined): void; reject(error: Error): void }

/**
 * The effort worker of one database in this process, shared by every project's fold and spawned
 * on the first compute. A worker that fails or exits rejects what it held (those entries park and
 * retry) and the next compute spawns another. The last release terminates it.
 */
class EffortWorker {
  private worker: Worker | undefined
  private readonly pending = new Map<number, Pending>()
  private sequence = 0
  refs = 0

  constructor(
    private readonly path: string,
    private readonly url: URL,
  ) {}

  private acquire() {
    if (this.worker) return this.worker
    const created = new Worker(this.url, { workerData: { path: this.path } })
    created.unref()
    this.worker = created
    created.on("message", (message: EffortWorkerResponse) => {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.type === "result") entry.resolve(message.row ?? undefined)
      else entry.reject(new Error(message.message))
    })
    const dead = (error: Error) => {
      if (this.worker === created) this.worker = undefined
      for (const entry of this.pending.values()) entry.reject(error)
      this.pending.clear()
    }
    created.on("error", (error) => dead(error instanceof Error ? error : new Error(String(error))))
    created.on("exit", (code) => dead(new Error(`Effort worker exited with code ${code}`)))
    return created
  }

  compute(
    request: Omit<Extract<EffortWorkerRequest, { type: "compute" }>, "type" | "id">,
    signal: AbortSignal,
  ): Promise<EffortRow | undefined> {
    signal.throwIfAborted()
    const worker = this.acquire()
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id)
        worker.postMessage({ type: "cancel", id } satisfies EffortWorkerRequest)
        reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"))
      }
      signal.addEventListener("abort", onAbort, { once: true })
      this.pending.set(id, {
        resolve: (row) => {
          signal.removeEventListener("abort", onAbort)
          resolve(row)
        },
        reject: (error) => {
          signal.removeEventListener("abort", onAbort)
          reject(error)
        },
      })
      worker.postMessage({ type: "compute", id, ...request } satisfies EffortWorkerRequest)
    })
  }

  close() {
    const worker = this.worker
    this.worker = undefined
    for (const entry of this.pending.values()) entry.reject(new Error("Effort worker closed"))
    this.pending.clear()
    void worker?.terminate()
  }
}

const registryKey = Symbol.for("lazers.effort-worker.v1")
const host = globalThis as typeof globalThis & { [registryKey]?: Map<string, EffortWorker> }
const held = () => (host[registryKey] ??= new Map())

export type EffortWorkerCompute = { compute: TaskEffortCompute; release(): void }

/**
 * A task effort computation that runs in the database's effort worker. Only the price inputs
 * (`readPriceInputs`: the saved source order and OpenRouter access, which OpenCode owns) are read
 * on this thread, asynchronously.
 */
export function workerTaskEffort(options: {
  path: string
  projectDirectory: string
  projectID: string
  readPriceInputs(signal: AbortSignal): Promise<PriceInputs>
  workerURL?: URL
}): EffortWorkerCompute {
  const url = options.workerURL ?? workerURL("./effort-worker", import.meta.url)
  const key = `${options.path}\u0000${url.href}`
  let worker = held().get(key)
  if (!worker) {
    worker = new EffortWorker(options.path, url)
    held().set(key, worker)
  }
  worker.refs++
  const taken = worker
  let released = false
  return {
    async compute(taskID, signal) {
      const inputs = await options.readPriceInputs(signal)
      return taken.compute(
        {
          projectDirectory: options.projectDirectory,
          projectID: options.projectID,
          taskID,
          inputs,
        },
        signal,
      )
    },
    release() {
      if (released) return
      released = true
      if (--taken.refs > 0) return
      held().delete(key)
      taken.close()
    },
  }
}
