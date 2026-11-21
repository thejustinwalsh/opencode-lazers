import { parentPort, workerData } from "node:worker_threads"
import { computeTaskEffort, storedPriceProvider } from "./effort-compute.ts"
import type { EffortWorkerRequest, EffortWorkerResponse } from "./effort-worker-client.ts"

/**
 * Computes task effort rows for every project of one database, one request at a time, on
 * read-only connections: the task's progress rows, plans and stored session facts are read and
 * parsed here, the effort composed and valued here. The main thread sends ids and the
 * OpenCode-owned price inputs, and writes the row it gets back.
 */
const port = parentPort
if (!port) throw new Error("effort-worker must run in a worker thread")
const { path } = workerData as { path: string }
const controllers = new Map<number, AbortController>()
const send = (message: EffortWorkerResponse) => port.postMessage(message)

port.on("message", (message: EffortWorkerRequest) => {
  if (message.type === "cancel") {
    controllers.get(message.id)?.abort()
    return
  }
  const controller = new AbortController()
  controllers.set(message.id, controller)
  computeTaskEffort(
    path,
    message.projectDirectory,
    message.projectID,
    message.taskID,
    storedPriceProvider(path, message.projectDirectory, message.inputs),
    controller.signal,
  )
    .then(
      (row) => send({ type: "result", id: message.id, row: row ?? null }),
      (error: unknown) =>
        send({
          type: "error",
          id: message.id,
          message: error instanceof Error ? error.message : String(error),
        }),
    )
    .finally(() => controllers.delete(message.id))
})
