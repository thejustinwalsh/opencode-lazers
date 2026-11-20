/**
 * Messages between a stream client and a reader worker, and the shared-memory layout of the
 * shared tier. The frame layout itself is `frame.ts`.
 */
export type Anchor =
  | "head"
  | "tail"
  /** `place` is where the key sits: in the middle of the window (default) or at its start. */
  | { key: readonly unknown[]; place?: "center" | "start" }

export type Tier = "shared" | "transfer" | "copy"

export type ToReader =
  | {
      type: "open"
      stream: number
      source: string
      filter: unknown
      order: string
      anchor: Anchor
      window: number
      tier: Tier
      /** A reopened stream continues numbering after its last delivered frame. */
      sequence?: number
    }
  | { type: "slide"; stream: number; delta: number; op?: number }
  | { type: "seek"; stream: number; anchor: Anchor; op?: number }
  | { type: "revision"; revision: number } // main thread committed; refresh affected streams
  | { type: "return"; buffer: ArrayBuffer } // transfer tier: buffer goes home
  | { type: "close"; stream: number }
  | { type: "stats"; id: number }
  | { type: "shutdown" }

export type ReaderStats = {
  /** SQL statements executed on the reader's connection. */
  statements: number
  /** Rows those statements returned. */
  rowsRead: number
  /** Transfer-tier buffers ever allocated, and those currently waiting in the pool. */
  buffersAllocated: number
  buffersPooled: number
  streams: number
}

export type FromReader =
  | {
      type: "opened"
      stream: number
      shared?: SharedArrayBuffer
    }
  | {
      type: "frame"
      stream: number
      buffer?: ArrayBuffer
      bytes?: Uint8Array
      sequence: number
      /** The last `op` (slide or seek) this frame answers; absent for open and revisions. */
      op?: number
      /** Where the window is now, so a lost stream can reopen at the same place. */
      anchor: Anchor
    }
  | { type: "regrow"; stream: number; shared: SharedArrayBuffer }
  | { type: "failed"; stream: number; message: string }
  | ({ type: "stats"; id: number } & ReaderStats)
  | { type: "closed" }

/**
 * The shared tier's buffer: `[ control | frame 0 | frame 1 ]`. `control` is `Int32Array`
 * `[active, sequence, stop, frameBytes]`; frame `n` starts at `SHARED_CONTROL_BYTES + n * frameBytes`.
 * The reader writes the inactive frame, stores `active`, stores `sequence`, notifies on it. A
 * consumer reads `sequence`, the active frame, then `sequence` again and retries on a change.
 * The consumer stores 1 to `stop` to close the stream.
 */
export const SHARED_CONTROL_BYTES = 64
export const SHARED_ACTIVE = 0
export const SHARED_SEQUENCE = 1
export const SHARED_STOP = 2
export const SHARED_FRAME_BYTES = 3
