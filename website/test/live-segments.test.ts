import { expect, test } from "bun:test"
import { speechSegments as product } from "../../src/webgpu/speech"
import { speechSegments as page } from "../src/live/segments"

test("the page splits speech exactly like the product", () => {
  const samples = [
    "Hello there. How are you? Fine, thanks!",
    "# Title\n\n- one\n- two\n\n```js\ncode()\n```\nAfter **bold** and [a link](http://x).",
    "word ".repeat(200),
    "A very long clause, " + "and another clause that keeps going, ".repeat(20),
  ]
  for (const sample of samples) expect(page(sample)).toEqual(product(sample))
})
