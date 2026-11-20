import { readFrame, type Columns, type FrameHeader } from "./frame.ts"
import type { PoolStream, ReaderPool } from "./pool.ts"
import {
  SHARED_ACTIVE,
  SHARED_CONTROL_BYTES,
  SHARED_FRAME_BYTES,
  SHARED_SEQUENCE,
  SHARED_STOP,
  type Anchor,
  type FromReader,
} from "./protocol.ts"
import { streamColumns, type Source } from "./source.ts"

export type StreamOptions<F> = {
  filter: F
  order: string
  /** Items, slop included; the consumer decides. */
  window: number
  anchor?: Anchor
  /**
   * The transport. Omitted: shared memory when available, else transfer. `copy` is for streams
   * served over RPC and for tests; the consumer sees the same contract on all three.
   */
  transport?: "shared" | "transfer" | "copy"
}

export type Row<C extends Columns> = { readonly [K in keyof C]: unknown }

export type Stream<C extends Columns> = {
  /** Lazy rows over the current frame; valid until the next frame. */
  readonly items: readonly Row<C>[]
  readonly before: number | "more"
  readonly after: number | "more"
  readonly revision: number
  /** Resolves with the first frame. */
  ready(): Promise<void>
  /** Resolves when the frame that answers the move has arrived. */
  slide(delta: number): Promise<void>
  seek(anchor: Anchor): Promise<void>
  on(event: "change", listener: () => void): () => void
  close(): void
  [Symbol.dispose](): void
}

/** What a stream needs from a pool: attach a stream and receive its messages. */
export type StreamPool = Pick<ReaderPool, "attach">

type Decoded = {
  header: FrameHeader
  row(index: number): unknown
  sequence: number
  buffer?: ArrayBuffer
}

/**
 * The decoding half of a frame message for the transfer and copy tiers, shared with the RPC
 * client: the message's bytes are read in place and stay valid while the message's buffer does.
 */
export function decodeFrameMessage<C extends Columns>(
  message: Extract<FromReader, { type: "frame" }>,
  columns: C,
): Decoded | undefined {
  const source = message.buffer ?? message.bytes
  if (!source) return undefined
  const frame = message.buffer
    ? readFrame(message.buffer, 0, columns)
    : readFrame(message.bytes!.buffer, message.bytes!.byteOffset, columns)
  return {
    header: frame.header,
    row: frame.row,
    sequence: message.sequence,
    ...(message.buffer ? { buffer: message.buffer } : {}),
  }
}

type SharedState = { buffer: SharedArrayBuffer; control: Int32Array }

export function openStream<F, C extends Columns>(
  pool: StreamPool,
  source: Source<F, C>,
  options: StreamOptions<F>,
  owner?: { onDispose(run: () => void): void },
): Stream<C> {
  const transport =
    options.transport ?? (typeof SharedArrayBuffer === "function" ? "shared" : "transfer")
  const columns = streamColumns(source as never, options.window) as C
  const listeners = new Set<() => void>()
  const waiting = new Map<number, { resolve(): void; reject(error: Error): void }>()
  /** Frames the reader announced, answered once this side has read a frame at least that new. */
  const acks: { op: number; sequence: number }[] = []
  let current: Decoded | undefined
  let cache: Row<C>[] | undefined
  let observed = 0
  let failure: Error | undefined
  let closed = false
  let shared: SharedState | undefined
  let scratch = new ArrayBuffer(0)
  let firstFrame: { resolve(): void; reject(error: Error): void } | undefined
  const first = new Promise<void>((resolve, reject) => {
    firstFrame = { resolve, reject }
  })
  first.catch(() => {})

  const flush = () => {
    for (let i = acks.length - 1; i >= 0; i--) {
      const ack = acks[i]!
      if (ack.sequence > observed) continue
      acks.splice(i, 1)
      for (const [op, entry] of [...waiting])
        if (op <= ack.op) {
          waiting.delete(op)
          entry.resolve()
        }
    }
  }

  const adopt = (next: Decoded) => {
    const previous = current
    current = next
    cache = undefined
    observed = Math.max(observed, next.sequence)
    if (previous?.buffer && previous.buffer !== next.buffer) attached.release(previous.buffer)
    firstFrame?.resolve()
    firstFrame = undefined
    flush()
    for (const listener of [...listeners]) listener()
  }

  const fail = (error: Error) => {
    failure = error
    firstFrame?.reject(error)
    firstFrame = undefined
    for (const entry of waiting.values()) entry.reject(error)
    waiting.clear()
  }

  /** A consistent copy of the active shared frame: retried while the reader flips under it. */
  const snapshot = (state: SharedState): number => {
    const { control, buffer } = state
    const frameBytes = control[SHARED_FRAME_BYTES]!
    for (;;) {
      const before = Atomics.load(control, SHARED_SEQUENCE)
      const active = Atomics.load(control, SHARED_ACTIVE)
      const base = SHARED_CONTROL_BYTES + active * frameBytes
      const used = new DataView(buffer).getUint32(base + 4, true)
      if (used <= frameBytes) {
        if (scratch.byteLength < used)
          scratch = new ArrayBuffer(Math.max(used, scratch.byteLength * 2))
        new Uint8Array(scratch, 0, used).set(new Uint8Array(buffer, base, used))
        if (Atomics.load(control, SHARED_SEQUENCE) === before) {
          const frame = readFrame(scratch, 0, columns)
          adopt({ header: frame.header, row: frame.row, sequence: before })
          return before
        }
      }
    }
  }

  /** Waits on the shared sequence word without blocking the thread, and reads each new frame. */
  const pump = async (state: SharedState) => {
    let seen = 0
    while (!closed && shared === state) {
      const sequence = Atomics.load(state.control, SHARED_SEQUENCE)
      if (sequence !== seen && sequence !== 0) {
        seen = snapshot(state)
        continue
      }
      const wait = Atomics.waitAsync(state.control, SHARED_SEQUENCE, sequence)
      if (wait.async) await wait.value
    }
  }

  const useShared = (buffer: SharedArrayBuffer) => {
    const previous = shared
    shared = { buffer, control: new Int32Array(buffer, 0, 4) }
    if (previous) Atomics.notify(previous.control, SHARED_SEQUENCE)
    void pump(shared)
  }

  // `adopt` and `fail` read `attached`; they only run once a message arrives, after this line.
  const attached: PoolStream = pool.attach(
    {
      source: source.name,
      filter: options.filter,
      order: options.order,
      anchor: options.anchor ?? "head",
      window: options.window,
      tier: transport,
    },
    (message) => {
      if (closed) return
      switch (message.type) {
        case "opened":
          if (message.shared) useShared(message.shared)
          return
        case "regrow":
          return useShared(message.shared)
        case "failed":
          return fail(new Error(message.message))
        case "frame":
          if (message.op !== undefined) acks.push({ op: message.op, sequence: message.sequence })
          if (transport === "shared") return flush()
          {
            const decoded = decodeFrameMessage(message, columns)
            if (decoded) adopt(decoded)
          }
      }
    },
  )

  const move = (command: Parameters<PoolStream["post"]>[0]) => {
    if (closed) return Promise.reject(new Error("Stream is closed"))
    if (failure) return Promise.reject(failure)
    return new Promise<void>((resolve, reject) => {
      const op = attached.post(command)
      waiting.set(op, { resolve, reject })
    })
  }

  const close = () => {
    if (closed) return
    closed = true
    const error = new Error("Stream is closed")
    firstFrame?.reject(error)
    for (const entry of waiting.values()) entry.reject(error)
    waiting.clear()
    if (shared) {
      Atomics.store(shared.control, SHARED_STOP, 1)
      Atomics.notify(shared.control, SHARED_SEQUENCE)
    }
    if (current?.buffer) attached.release(current.buffer)
    current = undefined
    cache = undefined
    attached.close()
    listeners.clear()
  }
  owner?.onDispose(close)

  const result: Stream<C> = {
    get items() {
      const frame = current
      if (!frame) return []
      return (cache ??= Array.from(
        { length: frame.header.count },
        (_, i) => frame.row(i) as Row<C>,
      ))
    },
    get before() {
      return current?.header.before ?? 0
    },
    get after() {
      return current?.header.after ?? 0
    },
    get revision() {
      return current?.header.revision ?? 0
    },
    ready: () => first,
    slide: (delta) => move({ type: "slide", delta }),
    seek: (anchor) => move({ type: "seek", anchor }),
    on(_event, listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    close,
    [Symbol.dispose]: close,
  }
  return result
}
