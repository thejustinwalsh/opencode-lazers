import { expect, test } from "bun:test"
import { noticeMarker, parseNoticeMarker } from "./notice-marker.ts"
import { coalescedOutcomeText, outcomeText } from "./outcome.ts"

test("a marker line round-trips", () => {
  const line = noticeMarker({ kind: "task-accepted", plan: "p1", v: 4, task: "t1" })
  expect(line).toBe("[lz-notice kind=task-accepted plan=p1 v=4 task=t1]")
  expect(parseNoticeMarker(line!)).toEqual({ kind: "task-accepted", plan: "p1", v: 4, task: "t1" })
  expect(noticeMarker({ kind: "recovery-bundle", plan: "p1", gen: 2 })).toBe(
    "[lz-notice kind=recovery-bundle plan=p1 gen=2]",
  )
})

test("a value that would break the line is not marked, and lines that are not markers do not parse", () => {
  expect(noticeMarker({ kind: "blocked", plan: "has space" })).toBeUndefined()
  expect(noticeMarker({ kind: "blocked", plan: "a]b" })).toBeUndefined()
  expect(parseNoticeMarker("[lz-notice kind=blocked]")).toBeUndefined()
  expect(parseNoticeMarker("see [lz-notice kind=blocked plan=p]")).toBeUndefined()
})

test("outcome notices carry the marker under their header, once per plan section", () => {
  const payload = (planID: string, status: string) =>
    JSON.stringify({ planID, version: 3, status, reason: "r" })
  const one = outcomeText(payload("p1", "blocked"), "ONS")
  expect(one.split("\n").slice(0, 2)).toEqual([
    "LAZERS outcome · ONS",
    "[lz-notice kind=blocked plan=p1 v=3]",
  ])
  const two = coalescedOutcomeText(
    [
      { planID: "p1", payload: payload("p1", "blocked") },
      { planID: "p2", payload: payload("p2", "cancelled") },
    ],
    "ONS",
  )
  expect(two.split("\n").filter((line) => line.startsWith("[lz-notice "))).toEqual([
    "[lz-notice kind=blocked plan=p1 v=3]",
    "[lz-notice kind=cancelled plan=p2 v=3]",
  ])
  // A payload without a plan of its own takes the plan the entry names.
  expect(outcomeText(JSON.stringify({ status: "blocked" }), undefined, { planID: "p9" })).toContain(
    "[lz-notice kind=blocked plan=p9]",
  )
  expect(outcomeText(JSON.stringify({ status: "blocked" }))).not.toContain("[lz-notice")
})
