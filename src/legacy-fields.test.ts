import { expect, test } from "bun:test"
import { tolerantJsonSchema } from "./legacy-fields.ts"
import { TaskClassificationToolInput } from "./task-classification.ts"
import { TaskCorrectionToolInput } from "./task-correction.ts"
import { TaskAdviceToolInput } from "./tasks/advice.ts"
import { CommandInput } from "./runner/schema.ts"

const taskID = crypto.randomUUID()

test("declared tool schemas list no revision field and stay open for legacy ones", () => {
  for (const schema of [
    TaskClassificationToolInput,
    TaskCorrectionToolInput,
    TaskAdviceToolInput,
  ]) {
    const json = tolerantJsonSchema(schema)
    const properties = Object.keys((json.properties ?? {}) as Record<string, unknown>)
    expect(properties).not.toContain("expectedRevision")
    expect(properties).not.toContain("specRevision")
    expect(json.additionalProperties).toBeUndefined()
  }
  expect(tolerantJsonSchema(CommandInput).additionalProperties).toBeUndefined()
})

test("legacy revision fields are ignored; other unknown fields are still refused", () => {
  const correction = { taskID, originalTaskID: null, requestID: "r", reason: "why" }
  expect(TaskCorrectionToolInput.parse({ ...correction, expectedRevision: 4 })).toEqual(correction)
  expect(TaskCorrectionToolInput.safeParse({ ...correction, bogus: 1 }).success).toBe(false)
  const advice = {
    taskID,
    requestID: "r",
    findings: ["a"],
    implementationAdvice: ["b"],
    references: [],
  }
  expect(TaskAdviceToolInput.parse({ ...advice, expectedRevision: 2, specRevision: 3 })).toEqual(
    advice,
  )
})
