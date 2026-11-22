import { parentPort, workerData } from "node:worker_threads"
import { acquireSharedConnection } from "../storage.ts"
import { RETENTION_PRESET_DAYS } from "./contract.ts"
import { classifyPlans, previewRetention } from "./retention.ts"
import type { RetentionReadRequest, RetentionReadResult } from "./reader-protocol.ts"
import { worktreeCandidates } from "./worktrees.ts"

const port = parentPort
if (!port) throw new Error("retention-reader must run in a worker thread")

const { path } = workerData as { path: string }
const connection = acquireSharedConnection(path, "readonly")
const db = connection.db
let active: AbortController | undefined
let closing = false
let released = false

const send = (message: RetentionReadResult) => port.postMessage(message)
const release = () => {
  if (released) return
  released = true
  connection.release()
  send({ type: "closed" })
  port.close()
}
const check = (signal: AbortSignal) => signal.throwIfAborted()

async function status(now: number, dataDirectory: string, signal: AbortSignal) {
  const presets: Array<{ days: number; rows: number; bytes: number }> = []
  for (const days of RETENTION_PRESET_DAYS) {
    check(signal)
    const preview = await previewRetention(db, {
      now,
      days,
      ageIndependent: false,
      dataDirectory,
      signal,
    })
    presets.push({ days, rows: preview.rows, bytes: preview.bytes })
  }
  check(signal)
  const superseded = await previewRetention(db, {
    now,
    days: RETENTION_PRESET_DAYS[0],
    ageDependent: false,
    signal,
  })
  return {
    presets,
    superseded: { rows: superseded.rows, bytes: superseded.bytes },
  }
}

async function run(message: Exclude<RetentionReadRequest, { type: "close" }>) {
  if (closing) {
    send({ type: "error", id: message.id, message: "Retention reader is closing" })
    return
  }
  const controller = new AbortController()
  active = controller
  try {
    const { signal } = controller
    if (message.type === "status") {
      const value = await status(message.now, message.dataDirectory, signal)
      check(signal)
      send({ type: "result", id: message.id, value })
    } else {
      const { retired } = classifyPlans(db, message.now, message.days)
      check(signal)
      const worktrees = worktreeCandidates(db, retired, message.projectDirectory)
      if (message.type === "worktrees") send({ type: "worktrees", id: message.id, worktrees })
      else {
        const preview = await previewRetention(db, {
          now: message.now,
          days: message.days,
          dataDirectory: message.dataDirectory,
          signal,
        })
        check(signal)
        send({ type: "preview", id: message.id, preview, worktrees })
      }
    }
  } catch (error) {
    send({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    active = undefined
    if (closing) release()
  }
}

port.on("message", (message: RetentionReadRequest) => {
  if (message.type === "close") {
    closing = true
    active?.abort(new Error("Retention reader closing"))
    if (!active) release()
    return
  }
  void run(message)
})
