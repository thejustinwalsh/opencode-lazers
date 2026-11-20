import { expect, test } from "bun:test"
import { keepTail, STDERR_TAIL_BYTES, type Sinks } from "./fallow-wasi.ts"

test("stderr keeps its tail within the cap and never refuses a write", () => {
  const sinks: Sinks = { input: new Uint8Array(), inputOffset: 0, out: [], err: [] }
  const chunk = new Uint8Array(100_000).fill(65)
  for (let i = 0; i < 100; i++) keepTail(sinks, chunk)
  keepTail(sinks, new TextEncoder().encode("memory allocation of 42 bytes failed"))
  const held = sinks.err.reduce((sum, part) => sum + part.length, 0)
  expect(held).toBeLessThanOrEqual(STDERR_TAIL_BYTES + chunk.length)
  expect(held).toBeGreaterThan(STDERR_TAIL_BYTES - chunk.length)
  expect(new TextDecoder().decode(sinks.err.at(-1))).toContain("allocation of 42 bytes")
})
