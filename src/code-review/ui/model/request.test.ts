import { describe, expect, test } from "bun:test"
import { resolveRequest } from "./request.ts"
import type { Revision } from "./request.ts"

const task = "00000000-0000-4000-8000-000000000001"
const plan = "00000000-0000-4000-8000-0000000000aa"
const revision = (n: number, artifact: boolean): Revision => ({
  planID: plan,
  attemptID: `00000000-0000-4000-8000-00000000000${n}`,
  attemptNumber: n,
  state: "succeeded",
  baseRevision: "a".repeat(40),
  artifactRevision: artifact ? String(n).repeat(40) : null,
  startedAt: n,
})
// History is newest first; attempt 3 recorded no artifact.
const history = [revision(3, false), revision(2, true), revision(1, true)]

describe("resolveRequest", () => {
  test("task and live need no history", () => {
    expect(resolveRequest(task, { mode: "task" }, undefined, [])).toEqual({
      taskID: task,
      mode: "task",
    })
    expect(resolveRequest(task, { mode: "live" }, undefined, [])).toEqual({
      taskID: task,
      mode: "live",
    })
  })
  test("plan takes the chosen plan, else the task's", () => {
    expect(resolveRequest(task, { mode: "plan" }, { planID: plan }, [])).toEqual({
      taskID: task,
      mode: "plan",
      planID: plan,
    })
    expect(resolveRequest(task, { mode: "plan" }, { planID: null }, [])).toBeUndefined()
  })
  test("attempt defaults to the newest attempt with recorded work", () => {
    expect(resolveRequest(task, { mode: "attempt" }, undefined, history)?.attemptID).toBe(
      history[1]!.attemptID,
    )
    expect(
      resolveRequest(
        task,
        { mode: "attempt", attemptID: history[2]!.attemptID },
        undefined,
        history,
      )?.attemptID,
    ).toBe(history[2]!.attemptID)
    expect(
      resolveRequest(task, { mode: "attempt" }, undefined, [revision(1, false)]),
    ).toBeUndefined()
  })
  test("since compares the attempt before the chosen head", () => {
    expect(resolveRequest(task, { mode: "since" }, undefined, history)).toEqual({
      taskID: task,
      mode: "since",
      baseAttemptID: history[2]!.attemptID,
      headAttemptID: history[1]!.attemptID,
    })
    expect(resolveRequest(task, { mode: "since" }, undefined, [revision(1, true)])).toBeUndefined()
  })
})
