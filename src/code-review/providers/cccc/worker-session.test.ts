import { EventEmitter } from "node:events"
import type { Worker } from "node:worker_threads"
import { expect, it } from "bun:test"
import { runCcccWorkerSession } from "./worker-session.ts"
import type { CcccWorkerRequest } from "./worker-protocol.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

class TestWorker extends EventEmitter {
  readonly termination = deferred<number>()
  readonly terminationRequested = deferred<void>()
  readonly requestPosted = deferred<void>()
  terminationCalls = 0

  constructor(readonly response: "success" | "silent" | "exit-zero") {
    super()
    queueMicrotask(() => {
      if (response === "exit-zero") this.emit("exit", 0)
      else this.emit("message", { ready: true })
    })
  }

  postMessage(request: CcccWorkerRequest) {
    this.requestPosted.resolve(undefined)
    if (this.response === "success")
      queueMicrotask(() => this.emit("message", { id: request.id, ok: true, reports: [] }))
  }

  terminate(): Promise<number> {
    this.terminationCalls++
    this.terminationRequested.resolve(undefined)
    return this.termination.promise
  }

  asWorker(): Worker {
    return this as unknown as Worker
  }
}

function run(worker: TestWorker, signal = new AbortController().signal) {
  return runCcccWorkerSession(worker.asWorker(), { id: 1, files: [] }, signal, 10_000)
}

it("waits for worker termination before returning reports", async () => {
  const worker = new TestWorker("success")
  const pending = run(worker)
  let settled = false
  void pending.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )

  await worker.terminationRequested.promise
  await Promise.resolve()
  expect(settled).toBe(false)
  worker.emit("exit", 0)
  worker.termination.resolve(0)
  await expect(pending).resolves.toEqual([])
  expect(worker.terminationCalls).toBe(1)
})

it("awaits termination before completing cancellation", async () => {
  const worker = new TestWorker("silent")
  const controller = new AbortController()
  const pending = run(worker, controller.signal)
  let settled = false
  void pending.catch(() => {
    settled = true
  })
  await worker.requestPosted.promise
  controller.abort()

  await worker.terminationRequested.promise
  await Promise.resolve()
  expect(settled).toBe(false)
  worker.emit("exit", 0)
  worker.termination.resolve(0)
  await expect(pending).rejects.toMatchObject({ code: "cancelled" })
  expect(worker.terminationCalls).toBe(1)
})

it("fails promptly when a worker exits with code zero before replying", async () => {
  const worker = new TestWorker("exit-zero")

  await expect(run(worker)).rejects.toMatchObject({
    code: "worker-unavailable",
    message: "cccc worker exited early",
  })
  expect(worker.terminationCalls).toBe(0)
})

it("converts termination errors into a safe local worker failure", async () => {
  const worker = new TestWorker("success")
  const pending = run(worker)
  await worker.terminationRequested.promise
  worker.termination.reject(new Error("captured secret source"))

  await expect(pending).rejects.toMatchObject({
    code: "worker-unavailable",
    message: "cccc analysis worker could not be stopped",
  })
  await expect(pending.catch((error: Error) => error.message)).resolves.not.toContain(
    "captured secret source",
  )
})
