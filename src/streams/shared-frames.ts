import {
  SHARED_CONTROL_BYTES,
  SHARED_FRAME_BYTES,
  SHARED_FRAME_SEQUENCE,
  SHARED_FRAMES,
  SHARED_LATEST,
  SHARED_SEQUENCE,
} from "./protocol.ts"

/**
 * Triple-buffer handoff over one `SharedArrayBuffer`: nothing is copied. At most one frame is
 * the reader's, one the consumer's and one published, so the reader never writes a frame the
 * consumer is reading and a held frame stays intact until the consumer itself takes the next.
 */
const FRESH = 4
const INDEX = 3

export function allocateSharedFrames(frameBytes: number): SharedArrayBuffer {
  const buffer = new SharedArrayBuffer(SHARED_CONTROL_BYTES + SHARED_FRAMES * frameBytes)
  const control = new Int32Array(buffer, 0, 16)
  control[SHARED_FRAME_BYTES] = frameBytes
  // Frame 0 is the writer's, frame 2 the consumer's; frame 1 starts published and stale.
  control[SHARED_LATEST] = 1
  return buffer
}

export const sharedFrameBytes = (buffer: SharedArrayBuffer) =>
  new Int32Array(buffer, 0, 16)[SHARED_FRAME_BYTES]!

export class SharedFrameWriter {
  private readonly control: Int32Array
  private index = 0
  constructor(readonly buffer: SharedArrayBuffer) {
    this.control = new Int32Array(buffer, 0, 16)
  }
  get frameBytes() {
    return this.control[SHARED_FRAME_BYTES]!
  }
  /** Where the next frame is written: never a frame the consumer holds. */
  get offset() {
    return SHARED_CONTROL_BYTES + this.index * this.frameBytes
  }
  /** Make the written frame the latest and wake waiters. */
  publish(sequence: number) {
    Atomics.store(this.control, SHARED_FRAME_SEQUENCE + this.index, sequence)
    this.index = Atomics.exchange(this.control, SHARED_LATEST, this.index | FRESH) & INDEX
    Atomics.store(this.control, SHARED_SEQUENCE, sequence)
    Atomics.notify(this.control, SHARED_SEQUENCE)
  }
}

export class SharedFrameConsumer {
  private readonly control: Int32Array
  private held = 2
  constructor(readonly buffer: SharedArrayBuffer) {
    this.control = new Int32Array(buffer, 0, 16)
  }
  /**
   * Take the newest published frame, or undefined when nothing is new. The frame taken stays
   * intact until the next successful `take`.
   */
  take(): { offset: number; sequence: number } | undefined {
    if ((Atomics.load(this.control, SHARED_LATEST) & FRESH) === 0) return undefined
    // Only the reader sets FRESH and only this exchange clears it, so what comes back is fresh.
    this.held = Atomics.exchange(this.control, SHARED_LATEST, this.held) & INDEX
    return {
      offset: SHARED_CONTROL_BYTES + this.held * this.control[SHARED_FRAME_BYTES]!,
      sequence: Atomics.load(this.control, SHARED_FRAME_SEQUENCE + this.held),
    }
  }
}
