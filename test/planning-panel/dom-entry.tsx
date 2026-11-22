import { createComponent, createRoot } from "solid-js"
import type { JSX } from "solid-js"
import { render } from "solid-js/web"
import { PluginContext } from "../../node_modules/@opencode/plugin/dist/gui/internal.js"
import { setupPlanningPanel } from "../../src/planning/panel.tsx"
import { frameSize, writeFrame, type Columns } from "../../src/streams/frame.ts"
import {
  PLANNING_SOURCES,
  planningDetailCold,
  planningDetailColumns,
  planningListColumns,
} from "../../src/streams/sources/planning-ref.ts"

type Row = Record<string, unknown>
type Open = { source: string; window: number; filter: Row }

/**
 * The Plan panel over an in-memory Streams server: `planning.list` and `planning.detail` frames
 * written with the real codec from the rows a test sets. `set` changes the rows and pushes a
 * change to every open stream, as the server's revision feed does. Any other RPC is recorded.
 */
export function harness(root: HTMLElement, options: { plans: Row[]; details: Row[] }) {
  let plans = options.plans
  let details = options.details
  const calls: { method: string; input: Row }[] = []
  const streams = new Map<string, Open>()
  const listeners = new Set<(event: { data: { stream: string; seq: number } }) => void>()
  let seq = 0
  const encode = (columns: Columns, rows: Row[]) => {
    const names = Object.keys(columns)
    const cells = rows.map((row) => names.map((name) => row[name] ?? null))
    const bytes = new Uint8Array(frameSize(columns, cells))
    writeFrame(
      bytes.buffer,
      0,
      columns,
      { revision: ++seq, count: cells.length, before: 0, after: 0 },
      cells,
    )
    let binary = ""
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return { seq, data: btoa(binary) }
  }
  const frameOf = (id: string) => {
    const open = streams.get(id)!
    if (open.source === PLANNING_SOURCES.list)
      return encode(
        planningListColumns,
        plans.filter((plan) => plan.session_id === open.filter.sessionID).slice(0, open.window),
      )
    return encode(
      { ...planningDetailColumns, ...planningDetailCold },
      details.filter((row) => row.id === open.filter.planningID),
    )
  }
  const streamMethods: Record<string, (input: Row) => unknown> = {
    open: (input) => {
      calls.push({ method: "open", input })
      streams.set(String(input.stream), {
        source: String(input.source),
        window: Number(input.window),
        filter: (input.filter ?? {}) as Row,
      })
      return frameOf(String(input.stream))
    },
    read: (input) => frameOf(String(input.stream)),
    slide: (input) => frameOf(String(input.stream)),
    seek: (input) => frameOf(String(input.stream)),
    touch: (input) => ({ alive: streams.has(String(input.stream)) }),
    close: (input) => ({ closed: streams.delete(String(input.stream)) }),
  }
  const events = {
    subscribe: (_name: string, opts: { signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        const queue: { data: { stream: string; seq: number } }[] = []
        let wake: (() => void) | undefined
        const listener = (event: { data: { stream: string; seq: number } }) => {
          queue.push(event)
          wake?.()
        }
        listeners.add(listener)
        try {
          while (!opts.signal.aborted) {
            while (queue.length) yield queue.shift()!
            await new Promise<void>((resolve) => (wake = resolve))
          }
        } finally {
          listeners.delete(listener)
        }
      },
    }),
  }
  const client = {
    rpc: () =>
      new Proxy(
        {},
        {
          get: (_, method: string) =>
            method === "events"
              ? events
              : async (input: Row) => {
                  if (method in streamMethods) return streamMethods[method]!(input)
                  calls.push({ method, input })
                  throw new Error(`unexpected ${method}`)
                },
        },
      ),
  }
  const server = { id: "srv", connected: true, client }
  const session = { id: "s", server, location: { directory: "/work" }, directory: "/work" }
  let panel!: { render: (props: { session: typeof session }) => JSX.Element }
  const ctx = {
    id: "lazers",
    signal: new AbortController().signal,
    ui: { Icon: () => null },
    servers: { get: () => server },
    sessions: { list: () => [session], current: () => session },
    layout: { open: () => {} },
    add: (_kind: unknown, definition: { id?: string; render?: unknown }) => {
      if (definition?.id === "plan" && definition.render) panel = definition as never
    },
  }
  const setupDispose = createRoot((dispose) => {
    createComponent(PluginContext.Provider, {
      value: ctx as never,
      get children() {
        setupPlanningPanel(ctx as never)
        return null
      },
    })
    return dispose
  })
  const dispose = render(
    () =>
      createComponent(PluginContext.Provider, {
        value: ctx as never,
        get children() {
          return panel.render({ session })
        },
      }),
    root,
  )
  return {
    calls,
    open: () => [...streams.values()],
    set(next: { plans?: Row[]; details?: Row[] }) {
      plans = next.plans ?? plans
      details = next.details ?? details
      for (const stream of streams.keys())
        for (const listener of [...listeners]) listener({ data: { stream, seq: seq + 1 } })
    },
    dispose() {
      dispose()
      setupDispose()
    },
  }
}
