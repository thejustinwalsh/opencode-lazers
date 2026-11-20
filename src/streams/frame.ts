/**
 * The frame codec: one window of rows in one contiguous buffer, read by field on access.
 *
 * Little endian, identical over `ArrayBuffer` and `SharedArrayBuffer`, location independent
 * (every offset inside a frame is relative to the frame or to its row), so a frame can be
 * copied byte for byte between buffers and tiers.
 *
 * ```
 * frame  u32 count | u32 usedBytes | f64 revision | f64 before | f64 after      (32 bytes)
 *        u32 rowOffset[count]            offsets from the frame start
 *        pad to 8, then rows, each starting 8-byte aligned
 * row    null bitmap (1 bit per column, set = null), padded to 8
 *        one 8-byte slot per column
 *          int    i64 (two u32 halves)      float  f64      bool  u8 at the slot start
 *          text/json   u32 offset from the row start | u32 byte length
 *        text bytes (UTF-8), row padded to 8
 * ```
 *
 * `before` and `after` are stored as f64 with `-1` for `"more"`. Padding and the slots of null
 * cells are written as zero, so equal rows are equal bytes.
 */

export type ColumnType = "int" | "float" | "text" | "json" | "bool" // nullable always allowed
export type Columns = Readonly<Record<string, ColumnType>>
export type FrameHeader = {
  revision: number
  count: number
  before: number | "more"
  after: number | "more"
}

/** One row of a frame, either as cell values in column order or as already encoded row bytes. */
export type FrameRow = readonly unknown[] | Uint8Array

const HEADER_BYTES = 32
const MORE = -1

const align8 = (n: number) => (n + 7) & ~7
const columnNames = new WeakMap<Columns, readonly string[]>()
const namesOf = (columns: Columns) => {
  let names = columnNames.get(columns)
  if (!names) columnNames.set(columns, (names = Object.keys(columns)))
  return names
}

const rowsStart = (count: number) => align8(HEADER_BYTES + 4 * count)

/** Scratch for one row: the UTF-8 text of its text and json cells and their byte lengths. */
type Cells = { texts: (string | null)[]; lengths: number[] }
const makeCells = (width: number): Cells => ({
  texts: new Array<string | null>(width).fill(null),
  lengths: new Array<number>(width).fill(0),
})

/** Measure one row of values; fills `cells`; returns the row's encoded size. */
function measureRow(columns: Columns, row: readonly unknown[], cells: Cells): number {
  const names = namesOf(columns)
  if (row.length !== names.length)
    throw new TypeError(`Row has ${row.length} cells, expected ${names.length}`)
  const slots = align8(Math.ceil(names.length / 8)) + 8 * names.length
  let size = slots
  for (let i = 0; i < names.length; i++) {
    const type = columns[names[i]!]!
    const value = row[i]
    cells.texts[i] = null
    cells.lengths[i] = 0
    if (value === null || value === undefined || (type !== "text" && type !== "json")) continue
    let text: string
    if (type === "text") {
      if (typeof value !== "string")
        throw new TypeError(`Column ${names[i]} is text; got ${typeof value}`)
      text = value
    } else {
      // json cells arrive as JSON text (what SQLite returns) or as any value to be stringified.
      text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null")
    }
    cells.texts[i] = text
    cells.lengths[i] = Buffer.byteLength(text)
    size += cells.lengths[i]!
  }
  return align8(size)
}

/** Write one measured row of values at `base`; the region is zeroed first. */
function writeRow(
  bytes: Uint8Array,
  view: DataView,
  base: number,
  columns: Columns,
  row: readonly unknown[],
  cells: Cells,
  rowSize: number,
) {
  const names = namesOf(columns)
  bytes.fill(0, base, base + rowSize)
  const slotsAt = base + align8(Math.ceil(names.length / 8))
  let textAt = align8(Math.ceil(names.length / 8)) + 8 * names.length
  for (let i = 0; i < names.length; i++) {
    const type = columns[names[i]!]!
    const value = row[i]
    if (value === null || value === undefined) {
      bytes[base + (i >> 3)]! |= 1 << (i & 7)
      continue
    }
    const slot = slotsAt + 8 * i
    switch (type) {
      case "int":
        if (typeof value === "bigint") view.setBigInt64(slot, value, true)
        else if (typeof value === "number" && Number.isSafeInteger(value)) {
          view.setUint32(slot, value >>> 0, true)
          view.setInt32(slot + 4, Math.floor(value / 4294967296), true)
        } else throw new TypeError(`Column ${names[i]} is int; got ${String(value)}`)
        break
      case "float":
        if (typeof value !== "number" && typeof value !== "bigint")
          throw new TypeError(`Column ${names[i]} is float; got ${typeof value}`)
        view.setFloat64(slot, Number(value), true)
        break
      case "bool":
        if (typeof value !== "boolean" && typeof value !== "number")
          throw new TypeError(`Column ${names[i]} is bool; got ${typeof value}`)
        bytes[slot] = value ? 1 : 0
        break
      default: {
        const length = cells.lengths[i]!
        view.setUint32(slot, textAt, true)
        view.setUint32(slot + 4, length, true)
        if (length > 0)
          Buffer.from(bytes.buffer, bytes.byteOffset + base + textAt, length).write(
            cells.texts[i]!,
            0,
            length,
            "utf8",
          )
        textAt += length
      }
    }
  }
}

/** Encode one row to its own bytes; the result can be placed in any frame of the same columns. */
export function encodeRow(columns: Columns, row: readonly unknown[]): Uint8Array {
  const cells = makeCells(namesOf(columns).length)
  const size = measureRow(columns, row, cells)
  const bytes = new Uint8Array(size)
  writeRow(bytes, new DataView(bytes.buffer), 0, columns, row, cells, size)
  return bytes
}

/** Bytes needed for `rows`; exact. A `Uint8Array` row is an encoded row and counts its length. */
export function frameSize(columns: Columns, rows: readonly FrameRow[]): number {
  const cells = makeCells(namesOf(columns).length)
  let size = rowsStart(rows.length)
  for (const row of rows)
    size += row instanceof Uint8Array ? row.byteLength : measureRow(columns, row, cells)
  return size
}

/**
 * Writes header + rows at `offset`; throws RangeError if it does not fit (callers size first).
 * Rows are cell values in column order or encoded rows (`encodeRow`, `rowBytes`); the second
 * form copies the row's bytes, which is how a slide keeps the rows that stay. `header.count` is
 * taken from `rows`. Returns the bytes written.
 */
export function writeFrame(
  target: ArrayBufferLike,
  offset: number,
  columns: Columns,
  header: FrameHeader,
  rows: readonly FrameRow[],
): number {
  const bytes = new Uint8Array(target)
  const view = new DataView(target)
  const cells = makeCells(namesOf(columns).length)
  const table = offset + HEADER_BYTES
  let at = rowsStart(rows.length)
  const need = (end: number) => {
    if (offset + end > target.byteLength)
      throw new RangeError(`Frame needs ${end} bytes at ${offset}; buffer has ${target.byteLength}`)
  }
  need(at)
  bytes.fill(0, offset + HEADER_BYTES + 4 * rows.length, offset + at)
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    view.setUint32(table + 4 * i, at, true)
    if (row instanceof Uint8Array) {
      need(at + row.byteLength)
      bytes.set(row, offset + at)
      at += row.byteLength
    } else {
      const size = measureRow(columns, row, cells)
      need(at + size)
      writeRow(bytes, view, offset + at, columns, row, cells, size)
      at += size
    }
  }
  view.setUint32(offset, rows.length, true)
  view.setUint32(offset + 4, at, true)
  view.setFloat64(offset + 8, header.revision, true)
  view.setFloat64(offset + 16, header.before === "more" ? MORE : header.before, true)
  view.setFloat64(offset + 24, header.after === "more" ? MORE : header.after, true)
  return at
}

const decoder = new TextDecoder()

type RowReader = { view: DataView; bytes: Uint8Array; base: number }

const isNull = (r: RowReader, index: number) =>
  (r.bytes[r.base + (index >> 3)]! & (1 << (index & 7))) !== 0

function readCell(r: RowReader, type: ColumnType, index: number, slots: number): unknown {
  if (isNull(r, index)) return null
  const slot = r.base + slots + 8 * index
  switch (type) {
    case "int": {
      const high = r.view.getInt32(slot + 4, true)
      if (high >= -2097152 && high < 2097152)
        return high * 4294967296 + r.view.getUint32(slot, true)
      return r.view.getBigInt64(slot, true)
    }
    case "float":
      return r.view.getFloat64(slot, true)
    case "bool":
      return r.bytes[slot] !== 0
    default: {
      const length = r.view.getUint32(slot + 4, true)
      if (length === 0) return ""
      const start = r.base + r.view.getUint32(slot, true)
      return decoder.decode(r.bytes.subarray(start, start + length))
    }
  }
}

type RowAccess = { readonly [key: string]: unknown }
const rowClasses = new WeakMap<Columns, new (reader: RowReader) => RowAccess>()

/** A row class per column set: one getter per column, decoding that field only when read. */
function rowClassFor(columns: Columns) {
  let found = rowClasses.get(columns)
  if (found) return found
  const names = namesOf(columns)
  const slots = align8(Math.ceil(names.length / 8))
  class Row {
    #reader: RowReader
    #json: Map<number, unknown> | undefined
    constructor(reader: RowReader) {
      this.#reader = reader
    }
    static define() {
      names.forEach((name, index) => {
        const type = columns[name]!
        Object.defineProperty(Row.prototype, name, {
          enumerable: true,
          get(this: Row) {
            const reader = this.#reader
            if (type !== "json") return readCell(reader, type, index, slots)
            const memo = (this.#json ??= new Map())
            if (memo.has(index)) return memo.get(index)
            const text = readCell(reader, "text", index, slots)
            const value = text === null ? null : (JSON.parse(text as string) as unknown)
            memo.set(index, value)
            return value
          },
        })
      })
    }
    toJSON() {
      const out: Record<string, unknown> = {}
      for (const name of names) out[name] = (this as unknown as RowAccess)[name]
      return out
    }
  }
  Row.define()
  found = Row as unknown as new (reader: RowReader) => RowAccess
  rowClasses.set(columns, found)
  return found
}

/** A lazy row over standalone encoded row bytes (from `encodeRow`, or `rowBytes`). */
export function readRow<C extends Columns>(
  bytes: Uint8Array,
  columns: C,
): { readonly [K in keyof C]: unknown } {
  const Row = rowClassFor(columns)
  return new Row({
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    bytes,
    base: 0,
  }) as never
}

/** Zero-copy reader. `row(i)` returns an object whose getters decode one field on access. */
export function readFrame<C extends Columns>(
  source: ArrayBufferLike,
  offset: number,
  columns: C,
): {
  header: FrameHeader
  row(index: number): { readonly [K in keyof C]: unknown }
  key(index: number, keyColumns: readonly (keyof C)[]): string
  /** The encoded bytes of one row (a view of the frame, not a copy). */
  rowBytes(index: number): Uint8Array
  /** Bytes the frame occupies from `offset`. */
  readonly usedBytes: number
} {
  const view = new DataView(source)
  const bytes = new Uint8Array(source)
  const count = view.getUint32(offset, true)
  const usedBytes = view.getUint32(offset + 4, true)
  const before = view.getFloat64(offset + 16, true)
  const after = view.getFloat64(offset + 24, true)
  const header: FrameHeader = {
    revision: view.getFloat64(offset + 8, true),
    count,
    before: before === MORE ? "more" : before,
    after: after === MORE ? "more" : after,
  }
  const Row = rowClassFor(columns)
  const names = namesOf(columns)
  const slots = align8(Math.ceil(names.length / 8))
  const rowAt = (index: number) => {
    if (!Number.isInteger(index) || index < 0 || index >= count)
      throw new RangeError(`Row ${index} is outside a frame of ${count}`)
    return offset + view.getUint32(offset + HEADER_BYTES + 4 * index, true)
  }
  return {
    header,
    usedBytes,
    row: (index) => new Row({ view, bytes, base: rowAt(index) }) as never,
    key(index, keyColumns) {
      const reader: RowReader = { view, bytes, base: rowAt(index) }
      return JSON.stringify(
        keyColumns.map((name) => {
          const at = names.indexOf(name as string)
          if (at < 0) throw new RangeError(`Unknown key column ${String(name)}`)
          const value = readCell(reader, columns[name as string]!, at, slots)
          return typeof value === "bigint" ? value.toString() : value
        }),
      )
    },
    rowBytes(index) {
      const start = rowAt(index)
      const end =
        index + 1 < count
          ? offset + view.getUint32(offset + HEADER_BYTES + 4 * (index + 1), true)
          : offset + usedBytes
      return bytes.subarray(start, end)
    },
  }
}
