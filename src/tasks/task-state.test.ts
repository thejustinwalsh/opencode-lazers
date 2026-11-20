import { expect, test } from "bun:test"
import type { ExecutionListRow } from "./execution-list.ts"
import { taskExplanation, taskStateView } from "./task-state.ts"

const row = (change: Partial<ExecutionListRow> = {}): ExecutionListRow => ({
  taskID: "11111111-1111-4111-8111-111111111111",
  title: "Continue interrupted workers",
  status: "running",
  reason: null,
  waiting: false,
  holdReason: null,
  ordinal: 0,
  contextOnly: false,
  prerequisites: [],
  successors: [],
  ...change,
})
const quietActivity = {
  waiting: false,
  holdReason: null,
  pendingInput: false,
  pendingPermissions: 0,
  pendingForms: 0,
}

test("a running task under a hold has one state word everywhere: Waiting, not running", () => {
  const held = taskStateView(row({ waiting: true, holdReason: "Worker interrupted" }))
  expect(held).toMatchObject({ label: "Waiting", tone: "waiting", labelTone: "warning" })
  expect(held.explained).toBe(true)
  expect(taskStateView(row()).label).toBe("Running")
})

test("each state has a word, a hue, and explains itself only when it asks for attention", () => {
  const words = (status: string) => taskStateView(row({ status }))
  expect(words("queued")).toMatchObject({
    label: "Queued",
    labelTone: "interactive",
    explained: false,
  })
  expect(words("incorporated")).toMatchObject({ label: "Integrated", labelTone: "success" })
  expect(words("failed")).toMatchObject({ label: "Failed", labelTone: "critical", explained: true })
  expect(words("cancelled")).toMatchObject({ label: "Cancelled", labelTone: "neutral" })
  expect(words("blocked")).toMatchObject({ label: "Blocked", explained: true })
  expect(taskStateView(row(), { ...quietActivity, pendingInput: true })).toMatchObject({
    tone: "attention",
    explained: true,
  })
  expect(
    taskStateView(
      row({ status: "queued", dispatchPause: { reason: "Paused by the owner" } as never }),
    ),
  ).toMatchObject({ label: "Paused", explained: true })
})

test("the callout sentence is the translated real reason, with what to do", () => {
  const waiting = taskStateView(row({ waiting: true }))
  expect(
    taskExplanation(waiting, {
      hold: ["Worker execution was interrupted; the runtime could not resume it"],
    }),
  ).toBe(
    "The worker was interrupted and the runtime could not resume it. Open Architect to resume or retry it.",
  )
  const failed = taskStateView(row({ status: "failed" }))
  expect(
    taskExplanation(failed, { hold: [], failure: "Verification quality exited with code 1" }),
  ).toBe("A verification check failed. Open Architect to retry or amend the task.")
  expect(taskExplanation(failed, { hold: [], failure: null })).toBe(
    "The last attempt failed. Open Architect to choose the next step.",
  )
  const needs = taskStateView(row(), { ...quietActivity, pendingPermissions: 1 })
  expect(
    taskExplanation(needs, { hold: [], activity: { ...quietActivity, pendingPermissions: 1 } }),
  ).toBe("The worker needs your approval to continue. Approve it from Radar.")
  expect(taskExplanation(taskStateView(row()), { hold: ["anything"] })).toBeUndefined()
})

test("a concern reading rides beside the state word without changing it", () => {
  const concern = {
    line: "3 verification rounds",
    reasons: ["verify-rounds"],
    totals: { attempts: 1, verifyRounds: 3, attemptMs: 0, tokens: 0, toolCalls: 0, costUSD: null },
  }
  const view = taskStateView(row({ concern }))
  expect(view).toMatchObject({ label: "Running", tone: "running", concern })
  expect(taskStateView(row()).concern).toBeUndefined()
})
