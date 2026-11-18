import { expect, test } from "bun:test"
import { SLOW_AFTER_MS, panelClock, panelFailureSentence, panelStatus } from "./panel-status.ts"

const base = { subject: "tasks", hasContent: false, loading: false }

test("a first load shows one status line, then Still loading with elapsed seconds after 10 s", () => {
  expect(panelStatus({ ...base, loading: true })).toEqual({
    kind: "loading",
    slow: false,
    line: "Loading tasks",
  })
  expect(panelStatus({ ...base, loading: true, progress: "14 so far" }, 9_999)).toEqual({
    kind: "loading",
    slow: false,
    line: "Loading tasks · 14 so far",
  })
  expect(panelStatus({ ...base, loading: true }, SLOW_AFTER_MS + 2_400)).toEqual({
    kind: "loading",
    slow: true,
    line: "Still loading · 12 s",
  })
})

test("content is kept under one banner while disconnected or after a failed refresh", () => {
  const asOf = new Date(2026, 10, 17, 17, 54).getTime()
  expect(panelStatus({ ...base, hasContent: true, disconnected: true, asOf })).toEqual({
    kind: "reconnecting",
    line: `Reconnecting · as of ${panelClock(asOf)}`,
  })
  expect(panelStatus({ ...base, hasContent: true, error: "Transport: Timed out" })).toEqual({
    kind: "reconnecting",
    line: "Couldn't update tasks",
    detail: "Transport: Timed out",
  })
  // A background refresh of healthy content shows nothing.
  expect(panelStatus({ ...base, hasContent: true, loading: true })).toEqual({ kind: "ready" })
})

test("a failure with nothing to show is one plain sentence; the raw error stays in detail", () => {
  const view = panelStatus({ ...base, error: "Transport: Timed out waiting for the service" })
  expect(view).toEqual({
    kind: "failed",
    line: "Couldn't load tasks: the LAZERS service did not answer in time.",
    detail: "Transport: Timed out waiting for the service",
  })
  expect(panelFailureSentence("live activity", "Server is offline")).toBe(
    "Couldn't load live activity: the LAZERS service is not reachable.",
  )
  expect(panelFailureSentence("models", "Schema mismatch at $.rows[3]")).toBe(
    "Couldn't load models.",
  )
  for (const line of [view.kind === "failed" ? view.line : ""])
    expect(line).not.toMatch(/unknown|unavailable|Transport/i)
})

test("an idle empty panel is ready, so the panel renders its own empty state", () => {
  expect(panelStatus(base)).toEqual({ kind: "ready" })
})
