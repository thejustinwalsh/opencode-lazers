import { expect, test } from "bun:test"
import { StartFeedback, ScrollRestoration, canStart, connectionLabel } from "./panel-view.ts"

test("late Start failures/completions cannot affect another task or scope", () => {
  let value = { taskID: "", error: "" }
  const feedback = new StartFeedback((next) => {
    value = next
  })
  feedback.reset("scope-a:task-a")
  const a = feedback.begin("a")!
  expect(feedback.begin("a")).toBeUndefined()
  feedback.reset("scope-a:task-b")
  const b = feedback.begin("b")!
  feedback.fail(a, new Error("old failure"))
  feedback.finish(a)
  expect(value).toEqual({ taskID: "b", error: "" })
  feedback.fail(b, new Error("current failure"))
  feedback.finish(b)
  expect(value).toEqual({ taskID: "", error: "current failure" })
  feedback.reset("scope-b:task-b")
  expect(value).toEqual({ taskID: "", error: "" })
  const c = feedback.begin("b")!
  feedback.finish(c)
  expect(value).toEqual({ taskID: "", error: "" })
})

test("scroll restoration waits for detail content independently of the list", () => {
  const jobs: (() => void)[] = []
  const list = new ScrollRestoration((job) => jobs.push(job))
  const detail = new ScrollRestoration((job) => jobs.push(job))
  const listElement = { scrollTop: 0 }
  const detailElement = { scrollTop: 0 }
  list.restore("scope", true, listElement, 80)
  detail.restore("scope:task", false, detailElement, 420)
  jobs.splice(0).forEach((job) => job())
  expect(listElement.scrollTop).toBe(80)
  expect(detail.restored("scope:task")).toBe(false)
  detail.restore("scope:task", true, detailElement, 420)
  jobs.splice(0).forEach((job) => job())
  expect(detailElement.scrollTop).toBe(420)
  expect(detail.restored("scope:task")).toBe(true)
  detailElement.scrollTop = 500
  detail.restore("scope:task", true, detailElement, 420)
  jobs.splice(0).forEach((job) => job())
  expect(detailElement.scrollTop).toBe(500)
  detail.restore("scope:task-b", true, detailElement, 10)
  detail.restore("new-scope:task", false, detailElement, 700)
  jobs.splice(0).forEach((job) => job())
  expect(detailElement.scrollTop).toBe(500)
})

test("default scroll restoration respects the browser scheduler receiver", () => {
  const original = globalThis.queueMicrotask
  const jobs: (() => void)[] = []
  try {
    // Browser WebIDL functions reject an arbitrary object as their receiver.
    globalThis.queueMicrotask = function (this: unknown, job: () => void) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation")
      jobs.push(job)
    }
    const restoration = new ScrollRestoration()
    const element = { scrollTop: 0 }
    expect(() => restoration.restore("task", true, element, 420)).not.toThrow()
    jobs.forEach((job) => job())
    expect(element.scrollTop).toBe(420)
    expect(restoration.restored("task")).toBe(true)
  } finally {
    globalThis.queueMicrotask = original
  }
})

test("planned queued work exposes Start, but ended or held work does not", () => {
  for (const state of ["submitted", "queued", "ready"]) expect(canStart(state)).toBe(true)
  for (const state of [
    "running",
    "verifying",
    "blocked",
    "accepted",
    "cancelled",
    "failed",
    "exhausted",
  ])
    expect(canStart(state)).toBe(false)
  expect(connectionLabel(false, false)).toBe("Task updates disconnected")
  expect(connectionLabel(true, true)).toBe("Task data is stale")
  expect(connectionLabel(false, true)).toBe("Task updates connected")
})
