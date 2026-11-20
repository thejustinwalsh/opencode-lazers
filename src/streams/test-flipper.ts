import { parentPort, workerData } from "node:worker_threads"
import { frameSize, writeFrame } from "./frame.ts"
import {
  SHARED_ACTIVE,
  SHARED_CONTROL_BYTES,
  SHARED_FRAME_BYTES,
  SHARED_SEQUENCE,
} from "./protocol.ts"

/** Test worker: flips a shared stream through `flips` frames, each row carrying the frame's number. */
const { buffer, flips, rows } = workerData as {
  buffer: SharedArrayBuffer
  flips: number
  rows: number
}
const columns = { n: "int", t: "text" } as const
const control = new Int32Array(buffer, 0, 4)
const frameBytes = control[SHARED_FRAME_BYTES]!
for (let n = 1; n <= flips; n++) {
  const set = Array.from({ length: rows }, () => [n, `x${n}`.repeat(20)])
  if (frameSize(columns, set) > frameBytes) throw new Error("test frame does not fit")
  const next = 1 - Atomics.load(control, SHARED_ACTIVE)
  writeFrame(
    buffer,
    SHARED_CONTROL_BYTES + next * frameBytes,
    columns,
    {
      revision: n,
      count: rows,
      before: 0,
      after: 0,
    },
    set,
  )
  Atomics.store(control, SHARED_ACTIVE, next)
  Atomics.store(control, SHARED_SEQUENCE, n)
  Atomics.notify(control, SHARED_SEQUENCE)
}
parentPort!.postMessage("done")
