import { batch, createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { readFrame, type Columns } from "./frame.ts"
import { STREAM_LEASE_MS, type StreamAnchorInput, type StreamFrame } from "./contract.ts"
import { streamColumns, type SourceRef } from "./source.ts"

/**
 * The GUI's stream client: the same contract as the server's (`open`, `slide`, `seek`, `change`,
 * `close`, a window in items) over plugin RPC on the copy tier. The frame arrives as base64 text
 * (plugin RPC is JSON), is decoded to the frame layout once, and rows are read from it lazily.
 */
export type Row<C extends Columns> = { readonly [K in keyof C]: unknown }

export type GuiStreamOptions<F> = {
  filter: F
  order: string
  window: number
  anchor?: StreamAnchorInput
}

export type ChangedEvent = { stream: string; seq: number } | "resync"

/** What the stream needs from the server; `rpcStreamsTransport` is the plugin RPC one. */
export type StreamsTransport = {
  open(input: {
    stream: string
    source: string
    filter: unknown
    order: string
    window: number
    anchor?: StreamAnchorInput
  }): Promise<StreamFrame>
  slide(stream: string, delta: number): Promise<StreamFrame>
  seek(stream: string, anchor: StreamAnchorInput): Promise<StreamFrame>
  read(stream: string): Promise<StreamFrame>
  touch(stream: string): Promise<{ alive: boolean }>
  close(stream: string): Promise<void>
  /** Pushed notifications; `"resync"` after the event stream was lost and resubscribed. */
  onChanged(listener: (event: ChangedEvent) => void): () => void
}

export type GuiStream<C extends Columns> = {
  items: Accessor<readonly Row<C>[]>
  before: Accessor<number | "more">
  after: Accessor<number | "more">
  revision: Accessor<number>
  /** The last failure, cleared by the next frame. */
  error: Accessor<Error | undefined>
  /** Move the window by items; the new frame replaces `items`. */
  slide(delta: number): void
  seek(anchor: StreamAnchorInput): void
}

export const base64ToBytes = (text: string): Uint8Array => {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const failureType = (error: unknown) =>
  typeof error === "object" && error !== null && "type" in error
    ? String((error as { type: unknown }).type)
    : undefined

let counter = 0
const newStreamID = () =>
  `g${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 8)}`

/**
 * A reactive stream. It opens when its owner runs, reopens when `options()` changes, closes on
 * cleanup, and reopens by itself if the server lost the stream (a restart, a lapsed lease).
 */
export function createStream<F, C extends Columns>(
  transport: StreamsTransport,
  source: SourceRef<F, C>,
  options: () => GuiStreamOptions<F>,
): GuiStream<C> {
  const [items, setItems] = createSignal<readonly Row<C>[]>([])
  const [before, setBefore] = createSignal<number | "more">(0)
  const [after, setAfter] = createSignal<number | "more">(0)
  const [revision, setRevision] = createSignal(0)
  const [error, setError] = createSignal<Error | undefined>(undefined)
  let controls: { slide(delta: number): void; seek(anchor: StreamAnchorInput): void } | undefined

  createEffect(() => {
    const opts = options()
    const stream = newStreamID()
    const columns = streamColumns(source, opts.window)
    let applied = -1
    let closed = false

    const apply = (frame: StreamFrame) => {
      if (closed || frame.seq <= applied) return
      applied = frame.seq
      const bytes = base64ToBytes(frame.data)
      const decoded = readFrame(bytes.buffer, bytes.byteOffset, columns)
      batch(() => {
        setItems(Array.from({ length: decoded.header.count }, (_, i) => decoded.row(i) as Row<C>))
        setBefore(decoded.header.before)
        setAfter(decoded.header.after)
        setRevision(decoded.header.revision)
        setError(undefined)
      })
    }
    const open = () => {
      applied = -1
      return guard(() =>
        transport.open({
          stream,
          source: source.name,
          filter: opts.filter,
          order: opts.order,
          window: opts.window,
          ...(opts.anchor ? { anchor: opts.anchor } : {}),
        }),
      )
    }
    const guard = async (call: () => Promise<StreamFrame>) => {
      try {
        apply(await call())
      } catch (failure) {
        if (closed) return
        if (failureType(failure) === "unknown_stream") void open()
        else
          setError(
            failure instanceof Error
              ? failure
              : new Error(String((failure as { message?: unknown })?.message ?? failure)),
          )
      }
    }

    controls = {
      slide: (delta) => void guard(() => transport.slide(stream, delta)),
      seek: (anchor) => void guard(() => transport.seek(stream, anchor)),
    }
    const off = transport.onChanged((event) => {
      if (event === "resync" || (event.stream === stream && event.seq > applied))
        void guard(() => transport.read(stream))
    })
    const lease = setInterval(() => {
      transport.touch(stream).then(
        (reply) => {
          if (!reply.alive && !closed) void open()
        },
        () => {},
      )
    }, STREAM_LEASE_MS / 3)
    void open()
    onCleanup(() => {
      closed = true
      off()
      clearInterval(lease)
      if (controls) controls = undefined
      void transport.close(stream).catch(() => {})
    })
  })

  return {
    items,
    before,
    after,
    revision,
    error,
    slide: (delta) => controls?.slide(delta),
    seek: (anchor) => controls?.seek(anchor),
  }
}

type CallOptions = { signal: AbortSignal; location?: { directory: string } }
type RpcCall<I, O> = (input: I, options: CallOptions) => Promise<O>
/** The shape of `ctx.client.rpc(Streams)` that the transport uses. */
export type StreamsRpc = {
  open: RpcCall<Parameters<StreamsTransport["open"]>[0], StreamFrame>
  slide: RpcCall<{ stream: string; delta: number }, StreamFrame>
  seek: RpcCall<{ stream: string; anchor: StreamAnchorInput }, StreamFrame>
  read: RpcCall<{ stream: string }, StreamFrame>
  touch: RpcCall<{ stream: string }, { alive: boolean }>
  close: RpcCall<{ stream: string }, { closed: boolean }>
  events: {
    subscribe(
      name: "changed",
      options: { signal: AbortSignal },
    ): AsyncIterable<{ data: { stream: string; seq: number } }>
  }
}

/** Plugin RPC as a stream transport. Events are live-only, so a lost subscription resyncs. */
export function rpcStreamsTransport(
  rpc: () => StreamsRpc,
  signal: AbortSignal,
  options: {
    resubscribeMs?: number
    /** The location whose service holds the streams; every call of a stream goes to the same one. */
    location?: { directory: string }
    /** Asked before a stream opens; a location that is not loaded must not be booted by a read. */
    ready?: () => Promise<boolean>
  } = {},
): StreamsTransport {
  const call = (extra: { signal: AbortSignal } = { signal }): CallOptions =>
    options.location ? { ...extra, location: options.location } : extra
  const listeners = new Set<(event: ChangedEvent) => void>()
  let listening = false
  let subscribedBefore = false
  const emit = (event: ChangedEvent) => {
    for (const listener of [...listeners]) listener(event)
  }
  const listen = async () => {
    listening = true
    while (!signal.aborted && listeners.size > 0) {
      try {
        const source = rpc().events.subscribe("changed", { signal })
        // A stream opened before the first subscription needs no resync; after a loss every one does.
        if (subscribedBefore) emit("resync")
        subscribedBefore = true
        for await (const event of source) emit(event.data)
      } catch {
        // Resubscribe below; the first frame after it resyncs every stream.
      }
      if (signal.aborted) break
      await new Promise((resolve) => setTimeout(resolve, options.resubscribeMs ?? 1_000))
    }
    listening = false
  }
  return {
    open: async (input) => {
      if (options.ready && !(await options.ready())) throw new Error("The location is not loaded")
      return rpc().open(input, call())
    },
    slide: (stream, delta) => rpc().slide({ stream, delta }, call()),
    seek: (stream, anchor) => rpc().seek({ stream, anchor }, call()),
    read: (stream) => rpc().read({ stream }, call()),
    touch: (stream) => rpc().touch({ stream }, call()),
    close: async (stream) =>
      void (await rpc().close({ stream }, call({ signal: AbortSignal.timeout(5_000) }))),
    onChanged(listener) {
      listeners.add(listener)
      if (!listening) void listen()
      return () => void listeners.delete(listener)
    },
  }
}
