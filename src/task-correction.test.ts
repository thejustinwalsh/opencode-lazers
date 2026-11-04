import { expect, test } from "bun:test"
import { TaskCorrectionInput } from "./task-correction.ts"

test("task corrections require an explicit project-local original or explicit separation", () => {
  const taskID = crypto.randomUUID()
  const originalTaskID = crypto.randomUUID()
  expect(
    TaskCorrectionInput.parse({
      taskID,
      originalTaskID,
      requestID: "review-correction-1",
      expectedRevision: 0,
      reason: "  Same original acceptance boundary.  ",
    }),
  ).toEqual({
    taskID,
    originalTaskID,
    requestID: "review-correction-1",
    expectedRevision: 0,
    reason: "Same original acceptance boundary.",
  })
  expect(
    TaskCorrectionInput.parse({
      taskID,
      originalTaskID: null,
      requestID: "review-separation-1",
      expectedRevision: 1,
      reason: "Reviewed as independent work.",
    }).originalTaskID,
  ).toBeNull()
  expect(() =>
    TaskCorrectionInput.parse({
      taskID,
      originalTaskID,
      requestID: " ",
      expectedRevision: 0,
      reason: "Not valid.",
    }),
  ).toThrow()
  expect(() =>
    TaskCorrectionInput.parse({
      taskID,
      originalTaskID,
      requestID: "unknown-field",
      expectedRevision: 0,
      reason: "Not valid.",
      inferred: true,
    }),
  ).toThrow()
})
