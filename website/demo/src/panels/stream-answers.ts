import { frameSize, writeFrame, type Columns } from "../../../../src/streams/frame.ts"

/**
 * The demo's answer to `lazers.streams`: the same frames the real reader writes (the real codec),
 * over rows a panel's mock data builds. Windows slide and seek over the sorted rows, so lists
 * scroll, anchor and count the way they do live. Each panel names its sources and its rows.
 */
export type DemoRow = Record<string, unknown>
type Anchor = "head" | "tail" | { key: (string | number | null)[]; place?: "center" | "start" }
export type Open = {
  source: string
  filter: Record<string, unknown>
  order: string
  window: number
  position: number
}

export function streamAnswers(
  sources: Record<string, { columns: Columns; key: string[]; detail?: Columns }>,
  rowsOf: (open: Open) => DemoRow[],
) {
  const streams = new Map<string, Open>()
  let sequence = 0

  const frame = (id: string) => {
    const open = streams.get(id)
    if (!open) throw new Error(`Unknown stream ${id}`)
    const source = sources[open.source]
    const columns: Columns =
      open.window === 1 && source?.detail
        ? { ...source.columns, ...source.detail }
        : (source?.columns ?? {})
    const all = rowsOf(open)
    const top = Math.max(0, all.length - open.window)
    open.position = Math.min(top, Math.max(0, open.position))
    const names = Object.keys(columns)
    const rows = all
      .slice(open.position, open.position + open.window)
      .map((row) => names.map((name) => row[name] ?? null))
    const bytes = new Uint8Array(frameSize(columns, rows))
    writeFrame(
      bytes.buffer,
      0,
      columns,
      {
        revision: ++sequence,
        count: rows.length,
        before: open.position,
        after: Math.max(0, all.length - open.position - rows.length),
      },
      rows,
    )
    let binary = ""
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return { seq: sequence, data: btoa(binary) }
  }

  const place = (open: Open, anchor: Anchor | undefined) => {
    const all = rowsOf(open)
    if (anchor === "tail") open.position = Math.max(0, all.length - open.window)
    else if (anchor && anchor !== "head") {
      const key = sources[open.source]?.key ?? []
      const index = all.findIndex((row) => key.every((name, i) => row[name] === anchor.key[i]))
      open.position =
        index < 0 ? 0 : anchor.place === "start" ? index : index - Math.floor(open.window / 2)
    } else open.position = 0
  }

  return {
    open: (input: {
      stream: string
      source: string
      filter: Record<string, unknown>
      order: string
      window: number
      anchor?: Anchor
    }) => {
      const open: Open = {
        source: input.source,
        filter: (input.filter ?? {}) as Record<string, unknown>,
        order: input.order,
        window: input.window,
        position: 0,
      }
      streams.set(input.stream, open)
      place(open, input.anchor)
      return frame(input.stream)
    },
    slide: (input: { stream: string; delta: number }) => {
      streams.get(input.stream)!.position += input.delta
      return frame(input.stream)
    },
    seek: (input: { stream: string; anchor: Anchor }) => {
      place(streams.get(input.stream)!, input.anchor)
      return frame(input.stream)
    },
    read: (input: { stream: string }) => frame(input.stream),
    touch: () => ({ alive: true }),
    close: (input: { stream: string }) => ({ closed: streams.delete(input.stream) }),
  }
}
