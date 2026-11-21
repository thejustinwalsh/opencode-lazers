import { expect, test } from "bun:test"
import {
  attemptFromRow,
  checkFromDetail,
  checkFromRow,
  eventFromDetail,
  eventFromRow,
  eventFromTranscript,
  timelineEventID,
} from "../../src/trajectory-panel/rows.ts"

const base = { plan_id: "plan", attempt_id: "attempt", session_id: "ses" }

test("a timeline row maps to the event kind the view knows", () => {
  expect(
    eventFromRow(
      {
        ...base,
        ref: "tr:1",
        kind: "transition",
        at: 5,
        event: "FAIL",
        from_state: "running",
        to_state: "failed",
      },
      "task",
    ),
  ).toMatchObject({
    id: "tr:1",
    kind: "runner-transition",
    event: "FAIL",
    from: "running",
    to: "failed",
    attemptID: "attempt",
  })
  expect(
    eventFromRow({ ...base, ref: "ef:1", kind: "effect", event: "SEND", status: "sent" }, "t"),
  ).toMatchObject({
    kind: "runner-effect",
    effect: "SEND",
    state: "sent",
  })
  expect(
    eventFromRow({ ...base, ref: "tr:2", kind: "check", event: "tests", status: "failed" }, "t"),
  ).toMatchObject({
    kind: "verification",
    checkID: "tests",
    status: "failed",
  })
  expect(
    eventFromRow({ ...base, ref: "pg:1", kind: "progress", event: "tool", tool: "bash" }, "t"),
  ).toMatchObject({
    kind: "worker-tool",
    tool: "bash",
  })
  expect(
    eventFromRow({ ...base, ref: "pg:2", kind: "progress", event: "commentary" }, "t").kind,
  ).toBe("commentary")
})

test("a tool row and its transcript row are one event by id", () => {
  const row = {
    ...base,
    ref: "call:9",
    kind: "tool",
    message_id: "msg",
    call_id: "c1",
    tool: "bash",
    status: "completed",
    at: 7,
  }
  expect(timelineEventID(row)).toBe("msg:tool:c1")
  const call = eventFromRow(row, "t")
  const text = eventFromTranscript(
    {
      id: "msg:tool:c1",
      kind: "tool",
      message_id: "msg",
      at: 7,
      text: "bash",
      body: { callID: "c1", result: "ok" },
    },
    { id: "attempt", planID: "plan", sessionID: "ses" },
  )
  expect(call.id).toBe(text.id)
  expect(text).toMatchObject({ result: "ok", sessionID: "ses", attemptID: "attempt" })
})

test("an attempt row ends at its last event once it is no longer active", () => {
  const row = {
    id: "a",
    plan_id: "p",
    number: 1,
    state: "failed",
    session_id: "ses",
    started_at: 10,
    tool_count: 3,
    last_event_at: 50,
    takeover: false,
    model: { providerID: "x", id: "y" },
  }
  expect(attemptFromRow(row, undefined).intervals.attempt).toMatchObject({
    startedAt: 10,
    endedAt: 50,
  })
  expect(
    attemptFromRow({ ...row, state: "running" }, undefined).intervals.attempt.endedAt,
  ).toBeNull()
})

test("a check row is a point; its detail adds the stored interval", () => {
  const row = { ...base, ref: "tr:3", kind: "check", event: "tests", status: "passed", at: 40 }
  expect(checkFromRow(row)).toMatchObject({
    id: "tests",
    scope: "attempt",
    result: "passed",
    startedAt: null,
    endedAt: 40,
  })
  const detail = {
    event: { id: "tr:3", kind: "verification" },
    check: { startedAt: 30, endedAt: 40, command: "bun test" },
  }
  expect(checkFromDetail(detail)).toMatchObject({ startedAt: 30, command: "bun test" })
  expect(eventFromDetail(detail)?.kind).toBe("verification")
})
