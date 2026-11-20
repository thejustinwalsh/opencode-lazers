import { expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { Sha256 } from "../src/live/sha256"

test("matches node's sha256 across sizes and split points", () => {
  for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 100_003]) {
    const data = new Uint8Array(randomBytes(size))
    const expected = createHash("sha256").update(data).digest("hex")
    for (const step of [1, 7, 64, 4096, size || 1]) {
      const hash = new Sha256()
      for (let i = 0; i < data.length; i += step) hash.update(data.subarray(i, i + step))
      expect(hash.hex()).toBe(expected)
    }
  }
})
