import type { Stream } from "./client.ts"
import { frameSize, readFrame, writeFrame, type Columns, type FrameRow } from "./frame.ts"
import type { Anchor } from "./protocol.ts"
import { streamColumns, type StreamContext } from "./source.ts"

/**
 * A host-backed source: rows that OpenCode owns and LAZERS reads on demand by cursor (a
 * transcript, a composed view), never stored. It serves the same `Stream` contract as a SQL
 * source on the copy tier, with the same frame bytes, so the RPC and the GUI client are the same.
 *
 * ```
 * host (cursors) ──page──► HostPager ──rows──► openHostStream ──writeFrame──► bytes ─► RPC ─► GUI
 *      ▲                      │ watch(notify)        │ window of rows lives only in `bytes`
 *      └──── hint (late, duplicated, lost, reordered) ┘ refresh = re-read from the start position
 * ```
 *
 * Rules the stream keeps:
 * - Rows are held only in the current frame. The window's edges are remembered as positions
 *   (opaque strings the pager gave back), never as rows.
 * - A slide reads the new edge only. The edge that moved away is advanced by re-reading the
 *   dropped rows from its position, so a position is always exact.
 * - A hint re-reads the window from its start position and emits `change` only when the bytes
 *   differ, so a hint that arrives late, twice or never is harmless: the next one converges.
 * - Moves and refreshes run one at a time, in order.
 */
export type HostFrom =
  | "head"
  | "tail"
  /** A boundary a previous page returned as `start` or `end`. */
  | { position: string }
  /** The boundary just before the row with this key. */
  | { key: readonly unknown[] }

export type HostPageRequest = {
  from: HostFrom
  /**
   * `after`: the rows that follow the boundary, oldest first. `before`: the rows that precede it,
   * in the same chronological order (the last row is the nearest to the boundary). `head` reads
   * `after`, `tail` reads `before`.
   */
  direction: "after" | "before"
  limit: number
  signal: AbortSignal
}

export type HostPageResult = {
  /** Cell arrays in column order (list columns, plus the detail columns for a window of one). */
  rows: readonly (readonly unknown[])[]
  /** The boundary before the first row returned (the request's boundary when there is none). */
  start: string
  /** The boundary after the last row returned. */
  end: string
  /** Rows exist before `start`. True when unsure. */
  before: boolean
  /** Rows exist after `end`. True when unsure. */
  after: boolean
}

export type HostPager = {
  page(request: HostPageRequest): Promise<HostPageResult>
  /** Hints that the rows may have changed; returns the unsubscribe. */
  watch(notify: () => void): () => void
}

export type HostSourceDefinition<F, C extends Columns, R> = {
  name: string
  /** Stable row key columns; a `seek` names a row by them. */
  key: readonly (keyof C & string)[]
  columns: C
  detail?: Columns
  /** As `SourceDefinition.authorize`: runs when a stream is opened through the Streams RPC. */
  authorize?(filter: F, context: StreamContext): F | Promise<F>
  /** As `SourceDefinition.release`: once, when an admitted stream is no longer held. */
  release?(filter: F): void
  /** A pager over the host for this filter; `window` is the stream's window in items. */
  open(filter: F, runtime: R, options: { window: number }): HostPager
}

export type HostSource<F, C extends Columns, R> = HostSourceDefinition<F, C, R> & {
  readonly kind: "host"
}

const registryKey = Symbol.for("lazers.streams.host-sources.v1")
const runtimeKey = Symbol.for("lazers.streams.host-runtimes.v1")
const globals = globalThis as typeof globalThis & {
  [registryKey]?: Map<string, HostSource<never, Columns, never>>
  [runtimeKey]?: Map<string, unknown>
}
const registry = (globals[registryKey] ??= new Map())
const runtimes = (globals[runtimeKey] ??= new Map())

/** Defining a name again replaces it: a reload redefines the same source. */
export function defineHostSource<F, C extends Columns, R>(
  definition: HostSourceDefinition<F, C, R>,
): HostSource<F, C, R> {
  const source: HostSource<F, C, R> = { ...definition, kind: "host" }
  registry.set(definition.name, source as unknown as HostSource<never, Columns, never>)
  return source
}

/** The host source registered under `name`, or undefined (SQL sources are `findSource`). */
export const findHostSource = (name: string) => registry.get(name)

/**
 * The host access of one project's core, keyed by project directory. The core binds it when it
 * is built and the returned function unbinds it; a successor core's binding is never removed by
 * its predecessor's unbind.
 */
export function bindHostRuntime(projectDirectory: string, runtime: unknown): () => void {
  runtimes.set(projectDirectory, runtime)
  return () => {
    if (runtimes.get(projectDirectory) === runtime) runtimes.delete(projectDirectory)
  }
}

export const hostRuntime = (projectDirectory: string) => runtimes.get(projectDirectory)

export type HostStreamOptions<F, R> = {
  filter: F
  window: number
  anchor?: Anchor
  runtime: R
}

type HostStream<C extends Columns> = Stream<C>

export function openHostStream<F, C extends Columns, R>(
  source: HostSource<F, C, R>,
  options: HostStreamOptions<F, R>,
): HostStream<C> {
  const window = options.window
  if (!Number.isInteger(window) || window < 1)
    throw new RangeError("A window holds at least 1 item")
  const columns = streamColumns(source as never, window) as C
  const pager = source.open(options.filter, options.runtime, { window })
  const abort = new AbortController()
  const listeners = new Set<() => void>()

  let bytes: Uint8Array | undefined
  let cache: ReturnType<typeof readItems> | undefined
  let count = 0
  let start = ""
  let end = ""
  let before = false
  let after = false
  let revision = 0
  let closed = false
  let followTail = false
  let chain: Promise<unknown> = Promise.resolve()
  let refreshQueued = false

  const readItems = () => {
    if (!bytes) return []
    const frame = readFrame(bytes.buffer, bytes.byteOffset, columns)
    return Array.from({ length: count }, (_, i) => frame.row(i))
  }
  const heldRows = (): FrameRow[] => {
    if (!bytes) return []
    const frame = readFrame(bytes.buffer, bytes.byteOffset, columns)
    return Array.from({ length: count }, (_, i) => frame.rowBytes(i))
  }
  const encode = (
    rows: readonly FrameRow[],
    hasBefore: boolean,
    hasAfter: boolean,
    rev: number,
  ) => {
    const buffer = new ArrayBuffer(frameSize(columns, rows))
    const header = {
      revision: rev,
      count: rows.length,
      before: hasBefore ? ("more" as const) : 0,
      after: hasAfter ? ("more" as const) : 0,
    }
    const written = writeFrame(buffer, 0, columns, header, rows)
    return new Uint8Array(buffer, 0, written)
  }
  const same = (a: Uint8Array | undefined, b: Uint8Array) =>
    a !== undefined && a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i])

  /** Install the window; `change` fires when the frame differs from the current one. */
  const commit = (
    rows: readonly FrameRow[],
    edges: { start: string; end: string; before: boolean; after: boolean },
  ) => {
    const next = encode(rows, edges.before, edges.after, revision)
    const changed = !same(bytes, next)
    start = edges.start
    end = edges.end
    before = edges.before
    after = edges.after
    if (!changed) return
    revision++
    bytes = encode(rows, edges.before, edges.after, revision)
    count = rows.length
    cache = undefined
    for (const listener of [...listeners]) listener()
  }

  const read = (from: HostFrom, direction: "after" | "before", limit: number) =>
    pager.page({ from, direction, limit, signal: abort.signal })

  const fill = async (anchor: Anchor) => {
    followTail = anchor === "tail"
    if (anchor === "head") {
      const r = await read("head", "after", window)
      return commit(r.rows as FrameRow[], r)
    }
    if (anchor === "tail") {
      const r = await read("tail", "before", window)
      return commit(r.rows as FrameRow[], r)
    }
    const from = { key: anchor.key }
    const half = anchor.place === "start" ? 0 : Math.floor(window / 2)
    const a = await read(from, "after", window - half)
    const b =
      half > 0 || a.rows.length < window
        ? await read(from, "before", window - a.rows.length)
        : undefined
    const rows = [...(b?.rows ?? []), ...a.rows] as FrameRow[]
    const first = b && b.rows.length > 0 ? b : a
    commit(rows, {
      start: first.start,
      end: a.rows.length > 0 ? a.end : (b?.end ?? a.end),
      before: first.before,
      after: a.after,
    })
  }

  type Edges = { start: string; end: string; before: boolean; after: boolean }
  /** Top a window up to its size from whichever side still has rows. */
  const topUp = async (held: FrameRow[], edges: Edges) => {
    let rows = held
    let e = edges
    if (rows.length < window && e.before) {
      const r = await read({ position: e.start }, "before", window - rows.length)
      rows = [...(r.rows as FrameRow[]), ...rows]
      e = { ...e, start: r.start, before: r.before }
    }
    if (rows.length < window && e.after) {
      const r = await read({ position: e.end }, "after", window - rows.length)
      rows = [...rows, ...(r.rows as FrameRow[])]
      e = { ...e, end: r.end, after: r.after }
    }
    commit(rows, e)
  }

  const move = async (delta: number) => {
    const held = heldRows()
    const edges = { start, end, before, after }
    const forward = delta > 0
    const d = Math.abs(delta)
    const side = forward ? "after" : "before"
    const near = { position: forward ? end : start }
    const far = { position: forward ? start : end }
    if (d >= held.length) {
      // No overlap: skip the rows between the window and the new one, then read a whole window.
      let boundary = near
      const skip = d - held.length
      if (skip > 0) {
        const s = await read(near, side, skip)
        if (s.rows.length < skip) return fill(forward ? "tail" : "head")
        boundary = { position: forward ? s.end : s.start }
      }
      const r = await read(boundary, side, window)
      return topUp(r.rows as FrameRow[], r)
    }
    const r = await read(near, side, d)
    if (r.rows.length === 0)
      return commit(held, forward ? { ...edges, after: r.after } : { ...edges, before: r.before })
    const drop = Math.max(0, held.length + r.rows.length - window)
    const gone = drop > 0 ? await read(far, forward ? "after" : "before", drop) : undefined
    const incoming = r.rows as FrameRow[]
    if (forward)
      return commit([...held.slice(drop), ...incoming], {
        start: gone ? gone.end : start,
        end: r.end,
        before: drop > 0 ? true : before,
        after: r.after,
      })
    return commit([...incoming, ...held.slice(0, held.length - drop)], {
      start: r.start,
      end: gone ? gone.start : end,
      before: r.before,
      after: drop > 0 ? true : after,
    })
  }

  const refresh = async () => {
    if (followTail && !after) return fill("tail")
    const r = await read({ position: start }, "after", window)
    commit(r.rows as FrameRow[], r)
  }

  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    const result = chain.then(() => {
      if (closed) throw new Error("Stream is closed")
      return run()
    })
    chain = result.catch(() => {})
    return result
  }

  const unwatch = pager.watch(() => {
    if (closed || refreshQueued) return
    refreshQueued = true
    void enqueue(async () => {
      refreshQueued = false
      await refresh()
    }).catch(() => {})
  })

  const first = enqueue(() => fill(options.anchor ?? "head"))
  first.catch(() => {})

  const close = () => {
    if (closed) return
    closed = true
    unwatch()
    abort.abort()
    listeners.clear()
    bytes = undefined
    cache = undefined
    count = 0
  }

  return {
    get bytes() {
      return bytes
    },
    get items() {
      return (cache ??= readItems()) as never
    },
    get before() {
      return before ? "more" : 0
    },
    get after() {
      return after ? "more" : 0
    },
    get revision() {
      return revision
    },
    ready: () => first,
    slide: (delta) => (delta === 0 ? Promise.resolve() : enqueue(() => move(delta))),
    seek: (anchor) => enqueue(() => fill(anchor)),
    on(_event, listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    close,
    [Symbol.dispose]: close,
  }
}
