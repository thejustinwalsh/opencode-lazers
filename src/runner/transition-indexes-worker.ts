import { Database } from "bun:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { createTransitionIndexes } from "./transition-indexes.ts"

/** Builds missing transition indexes on a dedicated connection; the main thread keeps running. */
const port = parentPort
if (!port) throw new Error("transition-indexes-worker must run in a worker thread")
const { path } = workerData as { path: string }
const db = new Database(path)
try {
  db.exec("PRAGMA busy_timeout = 30000")
  createTransitionIndexes(db)
  port.postMessage({ type: "done" })
} finally {
  db.close()
}
