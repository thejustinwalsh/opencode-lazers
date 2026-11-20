import { parentPort, workerData } from "node:worker_threads"
import { acquireSharedConnection } from "../storage.ts"
import { encodeRow, frameSize, readRow, writeFrame, type Columns } from "./frame.ts"
import {
  SHARED_STOP,
  type Anchor,
  type FromReader,
  type ReaderStats,
  type Tier,
  type ToReader,
} from "./protocol.ts"
import { allocateSharedFrames, SharedFrameWriter } from "./shared-frames.ts"
import {
  anchorQuery,
  edgeColumns,
  findSource,
  slideQuery,
  windowQuery,
  type Source,
  type SQL,
  type WindowAnchor,
} from "./source.ts"

/**
 * Reader worker: a read-only connection, the registered sources, and for every open stream the
 * current window as encoded rows. A slide reads only the rows that enter the window from the
 * leading edge by keyset and keeps the rest; a frame is those rows copied into the stream's
 * transport buffer. Everything here runs synchronously per message, so a stream is never
 * observed half moved; no wait in this file blocks: the only shared flag it consults is read,
 * never waited on, which keeps the worker answering messages and interruptible by the stop flags.
 */
const port = parentPort
if (!port) throw new Error("reader-worker must run in a worker thread")
const { path, control, sourceModules } = workerData as {
  path: string
  control: SharedArrayBuffer
  sourceModules?: readonly string[]
}
/** `[stop]`: the pool sets it before terminating; long loops here check it between streams. */
const stopFlag = new Int32Array(control)

const send = (message: FromReader, transfer?: ArrayBuffer[]) =>
  port.postMessage(message, transfer ?? [])

const connection = acquireSharedConnection(path, "readonly")
const db = connection.db
const stats = { statements: 0, rowsRead: 0, buffersAllocated: 0 }

const run = (query: SQL): unknown[][] => {
  stats.statements++
  const rows = db.query<unknown[], never[]>(query.sql).values(...(query.params as never[]))
  stats.rowsRead += rows.length
  return rows
}

type Count = number | "more"
type Shared = { buffer: SharedArrayBuffer; control: Int32Array; writer: SharedFrameWriter }
type Stream = {
  id: number
  source: Source<never, Columns>
  filter: unknown
  order: string
  window: number
  tier: Tier
  columns: Columns
  edgeNames: readonly string[]
  rows: Uint8Array[]
  before: Count
  after: Count
  /** The anchor kind the consumer last asked for; `head` and `tail` follow new rows. */
  follow: "head" | "tail" | null
  sequence: number
  op: number | undefined
  shared: Shared | undefined
}

const streams = new Map<number, Stream>()
let revision = 0

// ---------------------------------------------------------------- window reads

const edgeOf = (stream: Stream, row: Uint8Array): unknown[] => {
  const view = readRow(row, stream.columns) as Record<string, unknown>
  return stream.edgeNames.map((name) => view[name])
}

const keyOf = (stream: Stream, row: Uint8Array): unknown[] => {
  const view = readRow(row, stream.columns) as Record<string, unknown>
  return stream.source.keyColumns.map((name) => view[name])
}

const countBeyond = (stream: Stream, side: "before" | "after", edge: readonly unknown[]): Count => {
  const query = windowQuery(stream.source, {
    filter: stream.filter,
    order: stream.order,
    anchor: "head",
    window: stream.window,
  })
  const [row] = run(side === "before" ? query.before(edge) : query.after(edge))
  const value = Number(row?.[0] ?? 0)
  return stream.source.countMode === "more" ? (value > 0 ? "more" : 0) : value
}

type Loaded = { rows: Uint8Array[]; before: Count; after: Count }

/** Read a whole window at `anchor`. Counts come from known edges first, else one statement each. */
const load = (stream: Stream, anchor: WindowAnchor): Loaded => {
  const { window } = stream
  const query = windowQuery(stream.source, {
    filter: stream.filter,
    order: stream.order,
    anchor,
    window,
  })
  const fetched = run(query.rows)
  if (query.reversed) fetched.reverse()
  let lead: unknown[][] = []
  let leadAsked = 0
  if (query.lead) {
    leadAsked = Math.max(Math.floor(window / 2), window - fetched.length)
    if (leadAsked > 0) lead = run(query.lead(leadAsked)).reverse()
  }
  const taken = query.lead ? fetched.slice(0, window - lead.length) : fetched
  const rows = [...lead, ...taken].map((row) => encodeRow(query.columns, row))
  if (rows.length === 0) return { rows, before: 0, after: 0 }
  const exhaustedForward = fetched.length === taken.length && fetched.length < window
  const exhaustedBackward =
    anchor === "tail" ? fetched.length < window : leadAsked > 0 && lead.length < leadAsked
  const startsAtHead = anchor === "head"
  const endsAtTail = anchor === "tail"
  const first = edgeOf(stream, rows[0]!)
  const last = edgeOf(stream, rows[rows.length - 1]!)
  return {
    rows,
    before: startsAtHead || exhaustedBackward ? 0 : countBeyond(stream, "before", first),
    after: endsAtTail || exhaustedForward ? 0 : countBeyond(stream, "after", last),
  }
}

/** Order values of the row with `key`, or undefined when it is gone or filtered out. */
const resolveKey = (stream: Stream, key: readonly unknown[]) =>
  run(anchorQuery(stream.source, { filter: stream.filter, order: stream.order, key }))[0]

const toWindowAnchor = (stream: Stream, anchor: Anchor): WindowAnchor => {
  if (anchor === "head" || anchor === "tail") return anchor
  // A row that is gone or filtered out cannot anchor a window; the window starts at the head.
  const values = resolveKey(stream, anchor.key)
  return values ? { values, place: anchor.place ?? "center" } : "head"
}

/** Where the window is now: the anchor a reopened or refreshed stream resumes from. */
const currentAnchor = (stream: Stream): "head" | "tail" | { key: unknown[] } => {
  if (stream.follow === "tail" && stream.after === 0) return "tail"
  if (stream.before === 0) return "head"
  if (stream.after === 0) return "tail"
  return { key: keyOf(stream, stream.rows[0]!) }
}

const windowAnchorOf = (stream: Stream): WindowAnchor => {
  const anchor = currentAnchor(stream)
  if (anchor === "head" || anchor === "tail") return anchor
  // Re-resolve the first row's current order values (a row can move when it changes); a deleted
  // first row keeps its old position, so the window starts at its successor.
  const values = resolveKey(stream, anchor.key) ?? edgeOf(stream, stream.rows[0]!)
  return { values, place: "start" }
}

const protocolAnchor = (stream: Stream): Anchor => {
  const anchor = currentAnchor(stream)
  return anchor === "head" || anchor === "tail" ? anchor : { key: anchor.key, place: "start" }
}

// ---------------------------------------------------------------- slides

const slide = (stream: Stream, delta: number) => {
  if (delta === 0) return
  if (stream.rows.length === 0) return adopt(stream, load(stream, windowAnchorOf(stream)))
  const forward = delta > 0
  const size = Math.abs(delta)
  const limit = Math.min(size, stream.window)
  const offset = Math.max(0, size - stream.window)
  const probe = stream.source.countMode === "more" ? 1 : 0
  const edge = edgeOf(stream, stream.rows[forward ? stream.rows.length - 1 : 0]!)
  const { query, reversed } = slideQuery(stream.source, {
    filter: stream.filter,
    order: stream.order,
    side: forward ? "after" : "before",
    edge,
    limit: limit + probe,
    offset,
    window: stream.window,
  })
  const fetched = run(query)
  const more = fetched.length > limit
  if (more) fetched.length = limit
  if (offset > 0 && fetched.length < limit) {
    // The move ran past the data: land on the nearest end.
    stream.follow = forward ? "tail" : "head"
    return adopt(stream, load(stream, forward ? "tail" : "head"))
  }
  if (reversed) fetched.reverse()
  const entering = fetched.map((row) => encodeRow(stream.columns, row))
  const merged = forward ? [...stream.rows, ...entering] : [...entering, ...stream.rows]
  const keep = Math.min(stream.window, merged.length)
  const leaving = merged.length - keep
  const rows = forward ? merged.slice(leaving) : merged.slice(0, keep)
  const exhausted = entering.length < limit
  const passed = offset + leaving
  const trailing = forward ? stream.before : stream.after
  const leadingNow = (value: Count): Count =>
    stream.source.countMode !== "more"
      ? (typeof value === "number" ? value : 0) + passed
      : value === "more" || passed > 0
        ? "more"
        : 0
  const ahead = (value: Count): Count =>
    exhausted
      ? 0
      : stream.source.countMode !== "more"
        ? Math.max(0, (typeof value === "number" ? value : 0) - entering.length - offset)
        : more
          ? "more"
          : 0
  stream.rows = rows
  if (forward) {
    stream.before = leadingNow(trailing)
    stream.after = ahead(stream.after)
  } else {
    stream.after = leadingNow(trailing)
    stream.before = ahead(stream.before)
  }
}

const adopt = (stream: Stream, loaded: Loaded) => {
  stream.rows = loaded.rows
  stream.before = loaded.before
  stream.after = loaded.after
}

// ---------------------------------------------------------------- frames

/** Transfer-tier buffers, reused: only the worker that allocated one takes it back. */
const pool: ArrayBuffer[] = []
const takeBuffer = (size: number): ArrayBuffer => {
  let best = -1
  for (let i = 0; i < pool.length; i++)
    if (pool[i]!.byteLength >= size && (best < 0 || pool[i]!.byteLength < pool[best]!.byteLength))
      best = i
  if (best >= 0) return pool.splice(best, 1)[0]!
  stats.buffersAllocated++
  let bytes = 16 * 1024
  while (bytes < size) bytes *= 2
  return new ArrayBuffer(bytes)
}
const trimPool = () => {
  const transferStreams = [...streams.values()].filter((s) => s.tier === "transfer").length
  while (pool.length > Math.max(2, 2 * transferStreams)) pool.shift()
}

const newShared = (frameBytes: number): Shared => {
  const buffer = allocateSharedFrames(frameBytes)
  return { buffer, control: new Int32Array(buffer, 0, 16), writer: new SharedFrameWriter(buffer) }
}
const frameBytesFor = (size: number) => Math.max(4096, (Math.ceil(size * 1.5) + 7) & ~7)

const emit = (stream: Stream) => {
  const size = frameSize(stream.columns, stream.rows)
  const header = {
    revision,
    count: stream.rows.length,
    before: stream.before,
    after: stream.after,
  }
  const sequence = ++stream.sequence
  const base = {
    stream: stream.id,
    sequence,
    anchor: protocolAnchor(stream),
    ...(stream.op === undefined ? {} : { op: stream.op }),
  }
  if (stream.tier === "shared") {
    let shared = stream.shared!
    if (size > shared.writer.frameBytes) {
      shared = stream.shared = newShared(frameBytesFor(size))
      send({ type: "regrow", stream: stream.id, shared: shared.buffer })
    }
    writeFrame(shared.buffer, shared.writer.offset, stream.columns, header, stream.rows)
    shared.writer.publish(sequence)
    send({ type: "frame", ...base })
  } else if (stream.tier === "transfer") {
    const buffer = takeBuffer(size)
    writeFrame(buffer, 0, stream.columns, header, stream.rows)
    send({ type: "frame", ...base, buffer }, [buffer])
  } else {
    const bytes = new Uint8Array(size)
    writeFrame(bytes.buffer, 0, stream.columns, header, stream.rows)
    send({ type: "frame", ...base, bytes })
  }
}

const sameWindow = (stream: Stream, loaded: Loaded) =>
  stream.before === loaded.before &&
  stream.after === loaded.after &&
  stream.rows.length === loaded.rows.length &&
  stream.rows.every((row, i) =>
    Buffer.from(row.buffer, row.byteOffset, row.byteLength).equals(loaded.rows[i]!),
  )

// ---------------------------------------------------------------- messages

const fail = (id: number, error: unknown) =>
  send({
    type: "failed",
    stream: id,
    message: error instanceof Error ? error.message : String(error),
  })

const stopped = (stream: Stream) =>
  stream.shared !== undefined && Atomics.load(stream.shared.control, SHARED_STOP) !== 0

const open = (message: Extract<ToReader, { type: "open" }>) => {
  try {
    const source = findSource(message.source)
    if (!source) throw new Error(`Unknown source ${message.source}`)
    if (!Number.isInteger(message.window) || message.window < 1)
      throw new RangeError(`Window must be a positive integer of items; got ${message.window}`)
    const columns = windowQuery(source, {
      filter: message.filter,
      order: message.order,
      anchor: "head",
      window: message.window,
    }).columns
    const stream: Stream = {
      id: message.stream,
      source,
      filter: message.filter,
      order: message.order,
      window: message.window,
      tier: message.tier,
      columns,
      edgeNames: edgeColumns(source, message.order),
      rows: [],
      before: 0,
      after: 0,
      follow: message.anchor === "head" || message.anchor === "tail" ? message.anchor : null,
      sequence: message.sequence ?? 0,
      op: undefined,
      shared: undefined,
    }
    adopt(stream, load(stream, toWindowAnchor(stream, message.anchor)))
    if (stream.tier === "shared") {
      stream.shared = newShared(frameBytesFor(frameSize(columns, stream.rows)))
      send({ type: "opened", stream: stream.id, shared: stream.shared.buffer })
    } else send({ type: "opened", stream: stream.id })
    streams.set(stream.id, stream)
    emit(stream)
  } catch (error) {
    fail(message.stream, error)
  }
}

const withStream = (id: number, op: number | undefined, act: (stream: Stream) => void) => {
  const stream = streams.get(id)
  if (!stream) return
  if (stopped(stream)) {
    streams.delete(id)
    return
  }
  try {
    stream.op = op
    act(stream)
    emit(stream)
  } catch (error) {
    fail(id, error)
  } finally {
    stream.op = undefined
  }
}

let refreshing = false
let refreshAgain = false
/** Tables written since the last pass finished; `"all"` when a revision named none. */
let dirty: Set<string> | "all" = new Set()
const affected = (stream: Stream, tables: Set<string> | "all") =>
  tables === "all" || stream.source.readsTables.some((table) => tables.has(table))
const yieldToMessages = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Re-read every open stream's window; send a frame only where the rows or counts differ. */
const refreshAll = async () => {
  if (refreshing) {
    refreshAgain = true
    return
  }
  refreshing = true
  try {
    do {
      refreshAgain = false
      const tables = dirty
      dirty = new Set()
      for (const stream of [...streams.values()]) {
        if (!affected(stream, tables)) continue
        if (Atomics.load(stopFlag, 0) !== 0) return
        if (!streams.has(stream.id)) continue
        if (stopped(stream)) {
          streams.delete(stream.id)
          continue
        }
        try {
          const loaded = load(stream, windowAnchorOf(stream))
          if (!sameWindow(stream, loaded)) {
            adopt(stream, loaded)
            stream.op = undefined
            emit(stream)
          }
        } catch (error) {
          fail(stream.id, error)
        }
        await yieldToMessages()
      }
    } while (refreshAgain)
  } finally {
    refreshing = false
  }
}

const snapshot = (id: number): ReaderStats & { id: number } => ({
  id,
  statements: stats.statements,
  rowsRead: stats.rowsRead,
  buffersAllocated: stats.buffersAllocated,
  buffersPooled: pool.length,
  streams: streams.size,
})

const shutdown = () => {
  streams.clear()
  pool.length = 0
  connection.release()
  send({ type: "closed" })
  port.close()
}

const handle = (message: ToReader) => {
  switch (message.type) {
    case "open":
      return open(message)
    case "slide":
      return withStream(message.stream, message.op, (stream) => slide(stream, message.delta))
    case "seek":
      return withStream(message.stream, message.op, (stream) => {
        stream.follow =
          message.anchor === "head" || message.anchor === "tail" ? message.anchor : null
        adopt(stream, load(stream, toWindowAnchor(stream, message.anchor)))
      })
    case "revision":
      revision = message.revision
      dirty = message.tables && dirty !== "all" ? new Set([...dirty, ...message.tables]) : "all"
      return void refreshAll()
    case "return":
      if (message.buffer.byteLength > 0) pool.push(message.buffer)
      return trimPool()
    case "close":
      streams.delete(message.stream)
      return trimPool()
    case "stats":
      return send({ type: "stats", ...snapshot(message.id) })
    case "shutdown":
      return shutdown()
  }
}

// Source modules (tests, and sources defined outside this bundle) load before the first message.
for (const specifier of sourceModules ?? []) await import(specifier)
port.on("message", handle)
