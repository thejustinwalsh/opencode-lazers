import { expect, test } from "bun:test"
import { sessionTitle } from "./session-title.ts"

test("a title is the code, a middle dot and the text", () => {
  expect(sessionTitle("ONS", "Fix the parser")).toBe("ONS · Fix the parser")
})

test("a long text is cut to 120 characters", () => {
  const title = sessionTitle("ONS", "x".repeat(300))
  expect(title).toHaveLength(120)
  expect(title.startsWith("ONS · x")).toBe(true)
})
