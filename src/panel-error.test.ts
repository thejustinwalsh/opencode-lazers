import { expect, test } from "bun:test"
import { panelErrorMessage } from "./panel-error.ts"

test("F-S14-1 public errors preserve readable messages across RPC envelope shapes", () => {
  for (const error of [
    new Error("Narrow the scope"),
    { data: { message: "Narrow the scope" } },
    { data: { reason: "Narrow the scope" } },
    { error: { message: "Narrow the scope" } },
    "Narrow the scope",
  ]) {
    expect(panelErrorMessage(error)).toBe("Narrow the scope")
    expect(panelErrorMessage(error)).not.toContain("[object Object]")
  }
  expect(panelErrorMessage({ arbitrary: "private detail" })).toBe("Request failed.")
  expect(panelErrorMessage({}, "")).toBe("")
})

test("F-S14-1 error text and recovery instructions strip controls and stay bounded", () => {
  expect(
    panelErrorMessage({ data: { message: "Bad\u0000scope", recovery: "try\u001bagain" } }),
  ).toBe("Bad scope Recovery: try again.")
  expect(
    panelErrorMessage({ message: "x".repeat(400), data: { recovery: "y".repeat(400) } }),
  ).toHaveLength(320)
})
