import { expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode/client"
import { createSpeechEventCoordinator } from "./speech-events.ts"

const sessionID = "session-a"
const messageID = "message-a"

function makeEvent(type: string, data: Record<string, unknown>): OpenCodeEvent {
  return {
    id: `${type}-event`,
    created: 1,
    type,
    durable: { aggregateID: sessionID, seq: 1, version: 1 },
    data: { sessionID, ...data },
  } as unknown as OpenCodeEvent
}

const started = () => makeEvent("session.execution.started", {})
const succeeded = () => makeEvent("session.execution.succeeded", {})
const text = (
  text: string,
  ordinal = 0,
  native?: Record<string, unknown>,
  id = messageID,
  target = sessionID,
) =>
  makeEvent("session.text.ended", {
    assistantMessageID: id,
    ordinal,
    text,
    native,
    sessionID: target,
  })
const step = (id = messageID, finish = "stop") =>
  makeEvent("session.step.ended", { assistantMessageID: id, finish })

function harness(session = sessionID) {
  let current = true
  let enabled = true
  const calls: Array<{ segments: readonly string[]; messageID: string }> = []
  const coordinator = createSpeechEventCoordinator({
    sessionID: session,
    isCurrent: () => current,
    enabled: () => enabled,
    speak: (segments, spokenMessageID) => calls.push({ segments, messageID: spokenMessageID }),
  })
  return {
    calls,
    coordinator,
    setCurrent(value: boolean) {
      current = value
    },
    setEnabled(value: boolean) {
      enabled = value
    },
  }
}

test("raw deltas and phase-marked commentary never become speech", () => {
  const { calls, coordinator } = harness()
  coordinator.handle(started())
  coordinator.handle(
    makeEvent("session.text.delta", {
      assistantMessageID: messageID,
      ordinal: 0,
      delta: "RAW DELTA CANARY",
    }),
  )
  coordinator.handle(
    makeEvent("session.reasoning.ended", {
      assistantMessageID: messageID,
      ordinal: 0,
      text: "PRIVATE REASONING CANARY",
    }),
  )
  coordinator.handle(text("COMMENTARY CANARY", 0, { phase: "commentary" }))
  coordinator.handle(step())
  coordinator.handle(succeeded())
  expect(calls).toEqual([])
})

test("identified final parts speak as available and retain split code-fence state", () => {
  const { calls, coordinator } = harness()
  coordinator.handle(started())
  const first = text("The answer is ready.\n```ts\nDO NOT SPEAK", 0, { phase: "final_answer" })
  const second = text("STILL CODE\n```\nThe visible conclusion.", 1, { phase: "final_answer" })
  coordinator.handle(first)
  expect(calls.map((call) => call.segments.join(" "))).toEqual(["The answer is ready."])
  coordinator.handle(second)
  expect(calls.map((call) => call.segments.join(" "))).toEqual([
    "The answer is ready.",
    "The visible conclusion.",
  ])
  coordinator.handle(second)
  coordinator.handle(step())
  coordinator.handle(succeeded())
  expect(calls.flatMap((call) => call.segments).join(" ")).toBe(
    "The answer is ready. The visible conclusion.",
  )
})

test("unmarked providers wait for successful final completion and use only the final step", () => {
  const { calls, coordinator } = harness()
  coordinator.handle(started())
  coordinator.handle(text("Tool preamble CANARY", 0, undefined, "tool-message"))
  coordinator.handle(step("tool-message", "tool-calls"))
  coordinator.handle(text(" in two parts.", 1, undefined, "final-message"))
  coordinator.handle(text("Final answer", 0, undefined, "final-message"))
  coordinator.handle(step("final-message"))
  expect(calls).toEqual([])
  coordinator.handle(succeeded())
  expect(calls).toEqual([{ segments: ["Final answer in two parts."], messageID: "final-message" }])
})

test("replayed event parts, inactive sessions, and stopped turns cannot start stale playback", () => {
  const { calls, coordinator, setCurrent } = harness()
  const part = text("First final.\n", 0, { phase: "final_answer" })
  coordinator.handle(started())
  setCurrent(false)
  coordinator.handle(part)
  setCurrent(true)
  coordinator.handle(part)
  coordinator.handle(part)
  expect(calls).toHaveLength(1)

  coordinator.suppressCurrent()
  coordinator.handle(text("After stop CANARY", 1, { phase: "final_answer" }))
  expect(calls).toHaveLength(1)

  coordinator.handle(started())
  coordinator.handle(text("Fresh final.\n", 0, { phase: "final_answer" }, "message-b"))
  expect(calls.map((call) => call.segments.join(" "))).toEqual(["First final.", "Fresh final."])
  coordinator.dispose()
  coordinator.handle(text("Disposed CANARY", 1, { phase: "final_answer" }, "message-b"))
  expect(calls).toHaveLength(2)
})

test("successful completion does not infer unmarked speech after commentary metadata", () => {
  const { calls, coordinator } = harness()
  coordinator.handle(started())
  coordinator.handle(text("No speech from this lossy projection.", 0, { phase: "commentary" }))
  coordinator.handle(step())
  coordinator.handle(succeeded())
  expect(calls).toEqual([])
})

test("a comment and a fence split between parts remain excluded", () => {
  const { calls, coordinator } = harness()
  coordinator.handle(started())
  coordinator.handle(text("Visible. <!-- private", 0, { phase: "final_answer" }))
  coordinator.handle(text("commentary --> Done.\n", 1, { phase: "final_answer" }))
  coordinator.handle(text("```json\n{secret", 2, { phase: "final_answer" }))
  coordinator.handle(text(" data}\n```\nSafe ending.", 3, { phase: "final_answer" }))
  expect(calls.flatMap((call) => call.segments).join(" ")).toBe("Visible. Done. Safe ending.")
})

test("discarded code fragments do not turn an inline delimiter into a closing fence", () => {
  const { calls, coordinator } = harness()
  coordinator.handle(started())
  coordinator.handle(text("```ts\ninside_code ", 0, { phase: "final_answer" }))
  coordinator.handle(
    text("```\nPRIVATE_CODE_CANARY\n```\nSafe prose.", 1, { phase: "final_answer" }),
  )
  coordinator.handle(step())
  coordinator.handle(succeeded())
  expect(calls.flatMap((call) => call.segments)).toEqual(["Safe prose."])
})

test("replayed success events do not repeat an unmarked completed final", () => {
  const { calls, coordinator } = harness()
  coordinator.handle(started())
  coordinator.handle(text("Unmarked final once."))
  coordinator.handle(step())
  coordinator.handle(succeeded())
  coordinator.handle(step())
  coordinator.handle(succeeded())
  expect(calls.flatMap((call) => call.segments)).toEqual(["Unmarked final once."])
})
