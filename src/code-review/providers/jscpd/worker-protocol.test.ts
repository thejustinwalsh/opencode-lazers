import { expect, test } from "bun:test"
import { duplicationFailureCode, isDuplicationFailureCode } from "./worker-protocol.ts"

test("worker protocol maps only known error codes to safe failures", () => {
  expect(
    duplicationFailureCode(Object.assign(new Error("private"), { code: "analyzer-memory" })),
  ).toBe("analyzer-memory")
  expect(
    duplicationFailureCode(Object.assign(new Error("private"), { code: "private detail" })),
  ).toBe("analyzer-unavailable")
  expect(duplicationFailureCode("private error")).toBe("analyzer-unavailable")
  expect(isDuplicationFailureCode("invalid-request")).toBe(true)
  expect(isDuplicationFailureCode("private detail")).toBe(false)
})
