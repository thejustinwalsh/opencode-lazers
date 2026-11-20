import { expect, spyOn, test } from "bun:test"
import {
  encodeRow,
  frameSize,
  readFrame,
  readRow,
  writeFrame,
  type Columns,
  type FrameHeader,
} from "./frame.ts"

const columns = {
  id: "int",
  score: "float",
  title: "text",
  meta: "json",
  done: "bool",
} as const satisfies Columns

const header: FrameHeader = { revision: 42, count: 0, before: 7, after: "more" }

const snapshot = (frame: ReturnType<typeof readFrame<typeof columns>>, index: number) => {
  const row = frame.row(index)
  return { id: row.id, score: row.score, title: row.title, meta: row.meta, done: row.done }
}

const rows = [
  [1, 1.5, "alpha", '{"a":[1,2]}', true],
  [-9_007_199_254_740_991, -0.25, "héllo wörld ✓ 日本語 🧪", "[]", false],
  [null, null, null, null, null],
  [2 ** 40 + 3, Number.MAX_VALUE, "", "null", 1],
] as const

const expected = [
  { id: 1, score: 1.5, title: "alpha", meta: { a: [1, 2] }, done: true },
  {
    id: -9_007_199_254_740_991,
    score: -0.25,
    title: "héllo wörld ✓ 日本語 🧪",
    meta: [],
    done: false,
  },
  { id: null, score: null, title: null, meta: null, done: null },
  { id: 2 ** 40 + 3, score: Number.MAX_VALUE, title: "", meta: null, done: true },
]

test("every type round trips, including null, multi-byte text and negative integers", () => {
  const size = frameSize(columns, rows)
  const buffer = new ArrayBuffer(size)
  expect(writeFrame(buffer, 0, columns, header, rows)).toBe(size)
  const frame = readFrame(buffer, 0, columns)
  expect(frame.header).toEqual({ ...header, count: rows.length })
  expect(frame.usedBytes).toBe(size)
  for (let i = 0; i < rows.length; i++) expect(snapshot(frame, i)).toEqual(expected[i]!)
})

test("a frame at a non-zero offset reads the same", () => {
  const size = frameSize(columns, rows)
  const buffer = new ArrayBuffer(size + 100)
  writeFrame(buffer, 100, columns, header, rows)
  const frame = readFrame(buffer, 100, columns)
  expect(snapshot(frame, 1)).toEqual(expected[1]!)
})

test("integers beyond 2^53 come back as bigint, the header encodes before and after", () => {
  const big = 2n ** 62n + 5n
  const buffer = new ArrayBuffer(frameSize(columns, [[big, 0, "x", null, false]]))
  writeFrame(buffer, 0, columns, { revision: 0, count: 0, before: 0, after: 12 }, [
    [big, 0, "x", null, false],
  ])
  const frame = readFrame(buffer, 0, columns)
  expect(frame.row(0).id).toBe(big)
  expect(frame.header.before).toBe(0)
  expect(frame.header.after).toBe(12)
})

test("a 5 MiB text field round trips", () => {
  const text = "ab✓".repeat(Math.ceil((5 * 1024 * 1024) / 5))
  const big = [[7, 0, text, null, false]] as const
  const size = frameSize(columns, big)
  expect(size).toBeGreaterThan(5 * 1024 * 1024)
  const buffer = new ArrayBuffer(size)
  writeFrame(buffer, 0, columns, header, big)
  expect(readFrame(buffer, 0, columns).row(0).title).toBe(text)
})

test("an empty frame has no rows and keeps its header", () => {
  const buffer = new ArrayBuffer(frameSize(columns, []))
  writeFrame(buffer, 0, columns, { revision: 3, count: 0, before: 0, after: 0 }, [])
  const frame = readFrame(buffer, 0, columns)
  expect(frame.header).toEqual({ revision: 3, count: 0, before: 0, after: 0 })
  expect(() => frame.row(0)).toThrow(RangeError)
})

test("frameSize equals the bytes written, and an undersized target throws", () => {
  for (const set of [[], rows.slice(0, 1), rows]) {
    const size = frameSize(columns, set)
    const buffer = new ArrayBuffer(size + 64)
    expect(writeFrame(buffer, 0, columns, header, set)).toBe(size)
  }
  const size = frameSize(columns, rows)
  expect(() => writeFrame(new ArrayBuffer(size - 1), 0, columns, header, rows)).toThrow(RangeError)
})

test("reading one field does not decode the others", () => {
  const buffer = new ArrayBuffer(frameSize(columns, rows))
  writeFrame(buffer, 0, columns, header, rows)
  const frame = readFrame(buffer, 0, columns)
  const decode = spyOn(TextDecoder.prototype, "decode")
  try {
    const row = frame.row(0)
    expect(row.id).toBe(1)
    expect(row.score).toBe(1.5)
    expect(row.done).toBe(true)
    expect(decode).toHaveBeenCalledTimes(0)
    expect(row.title).toBe("alpha")
    expect(decode).toHaveBeenCalledTimes(1)
    expect(row.meta).toEqual({ a: [1, 2] })
    expect(decode).toHaveBeenCalledTimes(2)
    // json is parsed once per row object: a second read neither decodes nor parses again.
    const first = row.meta
    expect(row.meta).toBe(first)
    expect(decode).toHaveBeenCalledTimes(2)
  } finally {
    decode.mockRestore()
  }
})

test("a SharedArrayBuffer reads and writes identically to an ArrayBuffer", () => {
  const size = frameSize(columns, rows)
  const plain = new ArrayBuffer(size)
  const shared = new SharedArrayBuffer(size)
  writeFrame(plain, 0, columns, header, rows)
  writeFrame(shared, 0, columns, header, rows)
  expect(Array.from(new Uint8Array(shared))).toEqual(Array.from(new Uint8Array(plain)))
  const frame = readFrame(shared, 0, columns)
  for (let i = 0; i < rows.length; i++) expect(snapshot(frame, i)).toEqual(expected[i]!)
})

test("a dirty target yields the same bytes as a clean one", () => {
  const size = frameSize(columns, rows)
  const clean = new Uint8Array(size)
  const dirty = new Uint8Array(size).fill(0xab)
  writeFrame(clean.buffer, 0, columns, header, rows)
  writeFrame(dirty.buffer, 0, columns, header, rows)
  expect(dirty).toEqual(clean)
})

test("key reads only the key columns and encodes composite keys", () => {
  const buffer = new ArrayBuffer(frameSize(columns, rows))
  writeFrame(buffer, 0, columns, header, rows)
  const frame = readFrame(buffer, 0, columns)
  expect(frame.key(0, ["id"])).toBe("[1]")
  expect(frame.key(0, ["title", "id"])).toBe('["alpha",1]')
  expect(frame.key(2, ["id"])).toBe("[null]")
})

test("encoded rows copy into a frame byte for byte, mixed with values", () => {
  const encoded = rows.map((row) => encodeRow(columns, row))
  const viaValues = new Uint8Array(frameSize(columns, rows))
  writeFrame(viaValues.buffer, 0, columns, header, rows)
  const mixed = [encoded[0]!, rows[1]!, encoded[2]!, rows[3]!]
  expect(frameSize(columns, mixed)).toBe(viaValues.byteLength)
  const viaMixed = new Uint8Array(viaValues.byteLength)
  writeFrame(viaMixed.buffer, 0, columns, header, mixed)
  expect(viaMixed).toEqual(viaValues)
  const frame = readFrame(viaValues.buffer, 0, columns)
  expect(frame.rowBytes(1)).toEqual(encoded[1]!)
  expect(frame.rowBytes(3)).toEqual(encoded[3]!)
  expect(readRow(encoded[1]!, columns).title).toBe("héllo wörld ✓ 日本語 🧪")
})

test("type mismatches are reported, not coerced", () => {
  expect(() => encodeRow(columns, ["x", 0, "t", null, false])).toThrow(TypeError)
  expect(() => encodeRow(columns, [1, 0, 5, null, false])).toThrow(TypeError)
  expect(() => encodeRow(columns, [1, 0, "t"])).toThrow(TypeError)
})
