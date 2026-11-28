import { expect, test } from "bun:test"
import { CodeReviewIntegrations } from "./contract.ts"

test("integration contract publishes the shared typed read operations", () => {
  expect(CodeReviewIntegrations.id).toBe("lazers.codeReviewIntegrations")
  expect(Object.keys(CodeReviewIntegrations.methods)).toEqual(["list", "resolve"])
})
