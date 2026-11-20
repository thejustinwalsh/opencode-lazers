import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"

/**
 * One RPC namespace for every stream source. Plugin RPC is JSON over HTTP (`rpc.call` carries
 * `{ input?: unknown }` and returns `{ output?: unknown }`; see
 * node_modules/@opencode/protocol/dist/groups/rpc.js), so a frame's bytes travel as base64 text.
 * Measured for a 100-row frame (9,232 bytes): base64 12,324 JSON bytes, encode 3.8 us, decode
 * 4.7 us; a JSON number array 22,161 bytes, encode 141 us, decode 73 us.
 *
 * The client chooses the stream id, so the pushed `changed` event (which every window receives:
 * events are not addressed) is matched to a stream before `open` returns, and the event carries
 * no rows: a window that owns the stream pulls the frame with `read`.
 */
export const StreamAnchor = z.union([
  z.literal("head"),
  z.literal("tail"),
  z.strictObject({
    key: z.array(z.union([z.string(), z.number(), z.null()])),
    place: z.enum(["center", "start"]).optional(),
  }),
])
export type StreamAnchorInput = z.input<typeof StreamAnchor>

/** A frame in the stream's own numbering: apply it only if `seq` is newer than the last applied. */
export const StreamFrame = z.strictObject({ seq: z.int().nonnegative(), data: z.string() })
export type StreamFrame = z.infer<typeof StreamFrame>

const Id = z.string().min(1).max(200)
const UnknownStream = z.strictObject({ stream: Id })

/**
 * A stream not touched for this long is closed: events are not addressed, so the server cannot
 * see a window go away, and a window that did not call `close` is detected by its silence. A
 * live window renews every third of it.
 */
export const STREAM_LEASE_MS = 60_000

export const Streams = Rpc.define({
  id: "lazers.streams",
  methods: {
    open: {
      input: z.strictObject({
        stream: Id,
        source: z.string().min(1).max(200),
        filter: z.unknown(),
        order: z.string().min(1).max(200),
        window: z.int().min(1),
        anchor: StreamAnchor.optional(),
      }),
      output: StreamFrame,
      errors: { stream_failed: z.strictObject({ stream: Id }) },
    },
    slide: {
      input: z.strictObject({ stream: Id, delta: z.int() }),
      output: StreamFrame,
      errors: { unknown_stream: UnknownStream, stream_failed: UnknownStream },
    },
    seek: {
      input: z.strictObject({ stream: Id, anchor: StreamAnchor }),
      output: StreamFrame,
      errors: { unknown_stream: UnknownStream, stream_failed: UnknownStream },
    },
    read: {
      input: z.strictObject({ stream: Id }),
      output: StreamFrame,
      errors: { unknown_stream: UnknownStream },
    },
    touch: {
      input: z.strictObject({ stream: Id }),
      output: z.strictObject({ alive: z.boolean() }),
    },
    close: {
      input: z.strictObject({ stream: Id }),
      output: z.strictObject({ closed: z.boolean() }),
    },
  },
  events: {
    changed: { schema: z.strictObject({ stream: Id, seq: z.int().nonnegative() }) },
  },
})
