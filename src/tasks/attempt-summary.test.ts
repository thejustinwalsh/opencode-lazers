import { expect, test } from "bun:test"
import { attemptModel } from "./attempt-summary.ts"

test("the model comes from the recorded policy and is omitted when absent or unreadable", () => {
  expect(
    attemptModel(
      JSON.stringify({
        agent: "x",
        model: { providerID: "openai", id: "gpt-6-luna", variant: "max" },
      }),
    ),
  ).toEqual({ providerID: "openai", id: "gpt-6-luna", variant: "max" })
  expect(attemptModel("{}")).toBeUndefined()
  expect(attemptModel("not json")).toBeUndefined()
})
