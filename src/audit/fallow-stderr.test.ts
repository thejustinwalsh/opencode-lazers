import { expect, test } from "bun:test"
import { keepTail, STDERR_TAIL_BYTES, StdoutBuffer, type Sinks } from "./fallow-wasi.ts"

test("stderr keeps its tail within the cap and never refuses a write", () => {
  const sinks: Sinks = { input: new Uint8Array(), inputOffset: 0, out: new StdoutBuffer(), err: [] }
  const chunk = new Uint8Array(100_000).fill(65)
  for (let i = 0; i < 100; i++) keepTail(sinks, chunk)
  keepTail(sinks, new TextEncoder().encode("memory allocation of 42 bytes failed"))
  const held = sinks.err.reduce((sum, part) => sum + part.length, 0)
  expect(held).toBeLessThanOrEqual(STDERR_TAIL_BYTES + chunk.length)
  expect(held).toBeGreaterThan(STDERR_TAIL_BYTES - chunk.length)
  expect(new TextDecoder().decode(sinks.err.at(-1))).toContain("allocation of 42 bytes")
})

test("stdout is one growing buffer: the bytes written, in order, copied by growth once", () => {
  const out = new StdoutBuffer()
  const chunks = Array.from({ length: 300 }, (_, i) => new Uint8Array(1000 + i).fill(i % 251))
  for (const chunk of chunks) out.append(chunk)
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  expect(out.length).toBe(total)
  // Doubling from 64 KiB: growth moves less than twice what was written, over the whole run.
  expect(out.regrown).toBeLessThan(2 * total)
  const bytes = out.take()
  expect(bytes.length).toBe(total)
  expect(bytes.buffer.byteLength).toBe(total)
  expect(Buffer.from(bytes).equals(Buffer.concat(chunks))).toBe(true)
  expect(out.length).toBe(0)
})
