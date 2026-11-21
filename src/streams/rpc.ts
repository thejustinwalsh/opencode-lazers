import { Effect } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { timedRpc } from "../diagnostics/stall-probe.ts"
import { openStream, type Stream } from "./client.ts"
import { STREAM_LEASE_MS, Streams, type StreamAnchorInput, type StreamFrame } from "./contract.ts"
import { acquireReaderPool, type ReaderPool } from "./pool.ts"
import { findSource, type StreamContext } from "./source.ts"
import "./sources/index.ts"
import type { Columns } from "./frame.ts"

/**
 * The server side of the stream RPC: each GUI stream wraps an `openStream` on the copy tier. The
 * service keeps the streams and their leases; the registration below wires it to plugin RPC.
 */
export class UnknownStreamError extends Error {
  constructor(readonly stream: string) {
    super(`Stream ${stream} is not open`)
    this.name = "UnknownStreamError"
  }
}
class StreamFailedError extends Error {
  constructor(
    readonly stream: string,
    message: string,
  ) {
    super(message)
    this.name = "StreamFailedError"
  }
}

type Entry = {
  stream: Stream<Columns>
  seq: number
  /** Calls in flight: their response carries the frame, so no `changed` event is pushed. */
  busy: number
  lease: ReturnType<typeof setTimeout> | undefined
  off(): void
  /** The source's `release` for the filter its `authorize` returned; once, when dropped. */
  release?: () => void
}

export type StreamsService = ReturnType<typeof createStreamsService>

const encode = (bytes: Uint8Array) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")

export function createStreamsService(options: {
  pool: Pick<ReaderPool, "attach">
  /** Called after a frame arrives that no response carried. */
  changed(stream: string, seq: number): void
  leaseMs?: number
  /** Given to a source's `authorize`; a source that has one cannot be opened without it. */
  context?: StreamContext
}) {
  const leaseMs = options.leaseMs ?? STREAM_LEASE_MS
  const streams = new Map<string, Entry>()

  const drop = (id: string) => {
    const entry = streams.get(id)
    if (!entry) return false
    streams.delete(id)
    clearTimeout(entry.lease)
    entry.off()
    entry.stream.close()
    try {
      entry.release?.()
    } catch {
      // A source's bookkeeping never fails a close.
    }
    return true
  }
  const renew = (id: string, entry: Entry) => {
    clearTimeout(entry.lease)
    entry.lease = setTimeout(() => drop(id), leaseMs)
    entry.lease.unref()
  }
  const need = (id: string) => {
    const entry = streams.get(id)
    if (!entry) throw new UnknownStreamError(id)
    renew(id, entry)
    return entry
  }
  const frame = (id: string, entry: Entry): StreamFrame => {
    const bytes = entry.stream.bytes
    if (!bytes) throw new StreamFailedError(id, "The stream has no frame yet")
    return { seq: entry.seq, data: encode(bytes) }
  }
  const respond = async (id: string, entry: Entry, run: () => Promise<void>) => {
    entry.busy++
    try {
      await run()
    } catch (error) {
      throw new StreamFailedError(id, error instanceof Error ? error.message : String(error))
    } finally {
      entry.busy--
    }
    return frame(id, entry)
  }

  return {
    async open(input: {
      stream: string
      source: string
      filter: unknown
      order: string
      window: number
      anchor?: StreamAnchorInput
    }) {
      drop(input.stream)
      const source = findSource(input.source)
      if (!source) throw new StreamFailedError(input.stream, `Unknown source ${input.source}`)
      let filter = input.filter
      if (source.authorize) {
        try {
          if (!options.context) throw new Error("This service cannot authorize the source")
          filter = await source.authorize(input.filter as never, options.context)
        } catch (error) {
          throw new StreamFailedError(
            input.stream,
            error instanceof Error ? error.message : String(error),
          )
        }
      }
      const admitted = filter
      const release =
        source.authorize && source.release ? () => source.release!(admitted as never) : undefined
      let stream: Stream<Columns>
      try {
        stream = openStream(options.pool, source, {
          filter: filter as never,
          order: input.order,
          window: input.window,
          transport: "copy",
          ...(input.anchor ? { anchor: input.anchor as never } : {}),
        })
      } catch (error) {
        release?.()
        throw error
      }
      const entry: Entry = {
        stream,
        seq: 0,
        busy: 1,
        lease: undefined,
        off: () => {},
        ...(release ? { release } : {}),
      }
      entry.off = stream.on("change", () => {
        entry.seq++
        if (entry.busy === 0) options.changed(input.stream, entry.seq)
      })
      streams.set(input.stream, entry)
      renew(input.stream, entry)
      try {
        await stream.ready()
      } catch (error) {
        drop(input.stream)
        throw new StreamFailedError(
          input.stream,
          error instanceof Error ? error.message : String(error),
        )
      } finally {
        entry.busy--
      }
      return frame(input.stream, entry)
    },
    async slide(input: { stream: string; delta: number }) {
      const entry = need(input.stream)
      return respond(input.stream, entry, () => entry.stream.slide(input.delta))
    },
    async seek(input: { stream: string; anchor: StreamAnchorInput }) {
      const entry = need(input.stream)
      return respond(input.stream, entry, () => entry.stream.seek(input.anchor as never))
    },
    read(input: { stream: string }) {
      const entry = need(input.stream)
      return frame(input.stream, entry)
    },
    touch(input: { stream: string }) {
      const entry = streams.get(input.stream)
      if (entry) renew(input.stream, entry)
      return { alive: entry !== undefined }
    },
    close: (input: { stream: string }) => ({ closed: drop(input.stream) }),
    /** Streams currently held, for diagnostics and tests. */
    get size() {
      return streams.size
    },
    /** Close every stream: the registration ended. */
    dispose() {
      for (const id of [...streams.keys()]) drop(id)
    },
  }
}

/**
 * Register the `Streams` RPC for one location. The reader pool is held through
 * `acquireReaderPool`, so the last location to release it (a reload, a closed project) closes
 * the workers; the streams close with the registration.
 */
export function registerStreams(
  ctx: Pick<Plugin.Context, "rpc">,
  options: {
    databasePath: string
    pool?: Pick<ReaderPool, "attach">
    leaseMs?: number
    context?: StreamContext
  },
) {
  return Effect.gen(function* () {
    const lease = yield* Effect.acquireRelease(
      Effect.sync(() => (options.pool ? undefined : acquireReaderPool(options.databasePath))),
      (held) => Effect.sync(() => held?.release()),
    )
    const pool = options.pool ?? lease!.pool
    let emit: ((stream: string, seq: number) => void) | undefined
    const service = createStreamsService({
      pool,
      changed: (stream, seq) => emit?.(stream, seq),
      ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}),
      ...(options.context ? { context: options.context } : {}),
    })
    yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => service.dispose()))
    const run = <T>(work: () => T | Promise<T>) =>
      Effect.tryPromise({ try: async () => work(), catch: (error) => error })
    const registration = yield* timedRpc(ctx.rpc).register(Streams, {
      open: (input, context) =>
        run(() => service.open(input)).pipe(
          Effect.catch((error) =>
            error instanceof StreamFailedError
              ? Effect.fail(context.error("stream_failed", error.message, { stream: error.stream }))
              : Effect.die(error),
          ),
        ),
      slide: (input, context) =>
        failures(
          run(() => service.slide(input)),
          context,
        ),
      seek: (input, context) =>
        failures(
          run(() => service.seek(input)),
          context,
        ),
      read: (input, context) =>
        failures(
          run(() => service.read(input)),
          context,
        ),
      touch: (input) => Effect.sync(() => service.touch(input)),
      close: (input) => Effect.sync(() => service.close(input)),
    })
    emit = (stream, seq) =>
      void Effect.runPromise(registration.events.emit("changed", { stream, seq })).catch(() => {})
  })
}

type FailureContext = {
  error(type: "unknown_stream" | "stream_failed", message: string, data: { stream: string }): never
}
const failures = <T>(effect: Effect.Effect<T, unknown>, context: unknown) => {
  const c = context as FailureContext
  return effect.pipe(
    Effect.catch((error) =>
      error instanceof UnknownStreamError
        ? Effect.fail(c.error("unknown_stream", error.message, { stream: error.stream }) as never)
        : error instanceof StreamFailedError
          ? Effect.fail(c.error("stream_failed", error.message, { stream: error.stream }) as never)
          : Effect.die(error),
    ),
  ) as never
}
