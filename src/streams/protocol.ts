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
  /** The main thread committed; streams of sources reading `tables` refresh (all when omitted). */
  | { type: "revision"; revision: number; tables?: readonly string[] }
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
 * The shared tier's buffer: `[ control | frame 0 | frame 1 | frame 2 ]`, three frames handed off
 * without a copy. `control` is an `Int32Array`:
 * `[latest, sequence, stop, frameBytes, frameSequence0..2]`, and frame `n` starts at
 * `SHARED_CONTROL_BYTES + n * frameBytes`. Each frame is in exactly one hand: the reader's (being
 * written), the consumer's (held and read in place) or the `latest` word's (published). `latest`
 * is `frameIndex | FRESH` where FRESH means "published since the consumer last took". The reader
 * publishes with one `Atomics.exchange(latest, written | FRESH)` and writes next into the frame
 * that comes back; the consumer takes with one `Atomics.exchange(latest, held)` and holds what
 * comes back until it takes again. See `shared-frames.ts`. The consumer stores 1 to `stop` to
 * close the stream; `sequence` is the word consumers wait on.
 */
export const SHARED_CONTROL_BYTES = 64
export const SHARED_LATEST = 0
export const SHARED_SEQUENCE = 1
export const SHARED_STOP = 2
export const SHARED_FRAME_BYTES = 3
export const SHARED_FRAME_SEQUENCE = 4
export const SHARED_FRAMES = 3
