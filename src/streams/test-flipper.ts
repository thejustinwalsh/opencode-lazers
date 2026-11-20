import { parentPort, workerData } from "node:worker_threads"
import { frameSize, writeFrame } from "./frame.ts"
import { SharedFrameWriter } from "./shared-frames.ts"

/** Test worker: flips a shared stream through `flips` frames, each row carrying the frame's number. */
const { buffer, flips, rows } = workerData as {
  buffer: SharedArrayBuffer
  flips: number
  rows: number
}
const columns = { n: "int", t: "text" } as const
const writer = new SharedFrameWriter(buffer)
for (let n = 1; n <= flips; n++) {
  const set = Array.from({ length: rows }, () => [n, `x${n}`.repeat(20)])
  if (frameSize(columns, set) > writer.frameBytes) throw new Error("test frame does not fit")
  writeFrame(buffer, writer.offset, columns, { revision: n, count: rows, before: 0, after: 0 }, set)
  writer.publish(n)
}
parentPort!.postMessage("done")
