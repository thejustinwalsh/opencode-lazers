import { expect, test } from "bun:test"
import { progressSteps } from "../details/progress.ts"
import { lifecycleMachines } from "../runner/lifecycle-machines.ts"
import { PROGRESS_STEPS, taskProgress } from "./task-progress.ts"

const taskStates = Object.keys(lifecycleMachines.task.config.states ?? {})

test("every task lifecycle state maps to a stage, none by the default branch", () => {
  expect(taskStates.toSorted()).toEqual(
    [
      "accepted",
      "blocked",
      "cancelled",
      "exhausted",
      "failed",
      "incorporated",
      "queued",
      "ready",
      "running",
      "verifying",
    ].toSorted(),
  )
  const stage: Record<string, number> = {
    queued: 0,
    ready: 0,
    running: 1,
    verifying: 2,
    accepted: 3,
    incorporated: 4,
  }
  for (const state of taskStates) {
    const { current } = taskProgress({ state })
    expect(current).toBeGreaterThanOrEqual(0)
    expect(current).toBeLessThan(PROGRESS_STEPS.length)
    if (state in stage) expect(current).toBe(stage[state]!)
  }
  expect(taskProgress({ state: "submitted" })).toEqual({ current: 0, tone: "interactive" })
})

test("progress tone: green only at Integrated, hold warns, failure is critical", () => {
  expect(taskProgress({ state: "running" })).toEqual({ current: 1, tone: "interactive" })
  expect(taskProgress({ state: "running", held: true })).toEqual({ current: 1, tone: "warning" })
  expect(taskProgress({ state: "queued", held: true })).toEqual({ current: 0, tone: "warning" })
  expect(taskProgress({ state: "incorporated" })).toEqual({ current: 4, tone: "success" })
  expect(taskProgress({ state: "accepted", planState: "integrated" })).toEqual({
    current: 4,
    tone: "success",
  })
  expect(taskProgress({ state: "accepted", planState: "cleaning" })).toEqual({
    current: 3,
    tone: "interactive",
  })
  expect(taskProgress({ state: "accepted", planState: "cleanup-blocked" }).tone).toBe("warning")
  for (const state of ["queued", "ready", "running", "verifying", "accepted"])
    expect(
      progressSteps(PROGRESS_STEPS, taskProgress({ state }).current).slice(0, 4),
    ).not.toContainEqual(expect.objectContaining({ tone: "success" }))
})

test("blocked, failed and cancelled stay at the stage the latest attempt reached", () => {
  expect(taskProgress({ state: "blocked" })).toEqual({ current: 0, tone: "warning" })
  expect(taskProgress({ state: "blocked", attemptState: "running" })).toEqual({
    current: 1,
    tone: "warning",
  })
  expect(taskProgress({ state: "blocked", attemptState: "verifying" }).current).toBe(2)
  expect(taskProgress({ state: "failed", attemptState: "failed" })).toEqual({
    current: 1,
    tone: "critical",
  })
  expect(
    taskProgress({
      state: "failed",
      attemptState: "failed",
      reason: "Verification quality exited with code 1",
    }),
  ).toEqual({ current: 2, tone: "critical" })
  expect(taskProgress({ state: "exhausted", attemptState: "exhausted" }).tone).toBe("critical")
  expect(taskProgress({ state: "cancelled" })).toEqual({ current: 0, tone: "neutral" })
  expect(taskProgress({ state: "cancelled", attemptState: "cancelled" })).toEqual({
    current: 1,
    tone: "neutral",
  })
})
