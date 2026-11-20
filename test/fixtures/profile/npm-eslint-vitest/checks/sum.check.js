import { expect, test } from "vitest"
import { sum } from "../src/sum.js"

test("sums", () => {
  expect(sum(2, 2)).toBe(4)
})
