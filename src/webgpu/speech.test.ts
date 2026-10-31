import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import {
  DEFAULT_VOICE,
  latestCompletedResponse,
  latestResponse,
  speechInstruction,
  speechSegments,
  SPEECH_CHUNK_CHARS,
} from "./speech.ts"

const fixture = (...items: unknown[]) => items as SessionMessageInfo[]
const answer = {
  type: "assistant",
  finish: "stop",
  time: { created: 2, completed: 3 },
  content: [{ type: "text", text: "Visible answer." }],
}
const idle = { type: "idle", outcome: "succeeded", time: { created: 4 } }

test("a very long unpunctuated reply retains every word within bounded speech chunks", () => {
  const text = Array.from({ length: 2_000 }, (_, i) => `word${i}`).join(" ")
  const segments = speechSegments(text)
  expect(segments.join(" ")).toBe(text)
  expect(segments.every((segment) => segment.length <= SPEECH_CHUNK_CHARS)).toBe(true)
})

test("read aloud honors native final-answer phase and excludes commentary, reasoning and tools", () => {
  expect(
    latestResponse(
      fixture(
        { type: "user", text: "Question", time: { created: 1 } },
        {
          ...answer,
          finish: "tool-calls",
          content: [
            { type: "text", text: "Inspecting internals." },
            { type: "tool", state: { content: "private JSON" } },
          ],
        },
        {
          ...answer,
          content: [
            { type: "reasoning", text: "private thought" },
            { type: "text", text: "Internal progress.", native: { phase: "commentary" } },
            { type: "text", text: "Unmarked setup." },
            { type: "text", text: "Visible answer.", native: { phase: "final_answer" } },
          ],
        },
        idle,
      ),
    ),
  ).toBe("Visible answer.")
  expect(latestResponse([])).toBe("")
})

test("unmarked providers use only final-step text after tools, including steered input", () => {
  expect(
    latestResponse(
      fixture(
        { type: "user", text: "Question" },
        {
          ...answer,
          finish: "tool-calls",
          content: [{ type: "text", text: "Planning." }, { type: "tool" }],
        },
        { type: "user", text: "Steered clarification" },
        {
          ...answer,
          content: [{ type: "text", text: "Before tool." }, { type: "tool" }, ...answer.content],
        },
        idle,
        { type: "model-switched" },
      ),
    ),
  ).toBe("Visible answer.")
})

test("active, failed, interrupted and tool-only turns never fall back to older answers", () => {
  const previous = fixture(answer, idle)
  for (const current of [
    [{ type: "user", text: "New question" }],
    [{ ...answer, time: { created: 5 }, content: [{ type: "text", text: "Streaming" }] }],
    [{ ...answer, finish: "tool-calls" }, idle],
    [{ ...answer, finish: "error", error: { message: "Failed" } }, idle],
    [answer, { ...idle, outcome: "failed" }],
    [answer, { ...idle, outcome: "interrupted" }],
    [{ ...answer, content: [{ type: "reasoning", text: "private" }] }, idle],
    [
      { ...answer, content: [{ type: "text", text: "Progress", native: { phase: "commentary" } }] },
      idle,
    ],
  ])
    expect(latestResponse([...previous, ...fixture(...current)])).toBe("")
  expect(latestResponse(fixture(answer))).toBe("")
})

test("manual replay retains the latest successful final while newer work is active or failed", () => {
  const completed = { ...answer }
  expect(
    latestCompletedResponse(
      fixture(
        { type: "user", text: "Earlier question" },
        completed,
        idle,
        { type: "user", text: "New work" },
        { ...answer, time: { created: 5 }, content: [{ type: "text", text: "Still working" }] },
      ),
    ),
  ).toBe("Visible answer.")
  expect(
    latestCompletedResponse(
      fixture(
        completed,
        idle,
        { ...answer, finish: "error", error: { message: "Failed" } },
        { ...idle, outcome: "failed" },
      ),
    ),
  ).toBe("Visible answer.")
  expect(
    latestCompletedResponse(
      fixture(
        completed,
        idle,
        { ...answer, content: [{ type: "text", text: "```ts\nprivate()\n```" }] },
        idle,
      ),
    ),
  ).toBe("Visible answer.")
  expect(
    latestCompletedResponse(fixture({ ...answer, content: [{ type: "text", text: "Not done" }] })),
  ).toBe("")
})

test("speech cleans Markdown without reading fenced code, comments, image paths or link destinations", () => {
  expect(
    speechSegments(
      [
        "# Result",
        "1. **Ready** on October 31, 2026, with 3 checks.",
        '```json\n{"internal": "do not read"}\n```',
        "~~~ts\nsecret()\n~~~",
        "<!-- internal note -->",
        "[Details](https://example.com/private) ![screen](/tmp/image.png)",
        "Use `cancel` to stop.",
      ].join("\n"),
    ).join(" "),
  ).toBe("Result Ready on October 31, 2026, with 3 checks. Details Use cancel to stop.")
  expect(speechSegments("Before.\n```json\nUnclosed code")).toEqual(["Before."])
  expect(speechSegments("```json\n{}\n```")).toEqual([])
})

test("long answers are spoken in bounded segments without dropping words", () => {
  const text = "This is a complete sentence. ".repeat(50).trim()
  const segments = speechSegments(text)
  expect(segments.length).toBeGreaterThan(1)
  expect(segments.every((segment) => segment.length <= SPEECH_CHUNK_CHARS)).toBe(true)
  expect(segments.join(" ")).toBe(text)
  expect(speechSegments("# Hello\n**World** [reference](https://example.com)")).toEqual([
    "Hello World reference",
  ])
  expect(speechInstruction(DEFAULT_VOICE)).toBe(
    "Perform TTS in American English using a female voice.",
  )
  expect(speechInstruction("british-male")).toBe(
    "Perform TTS in British English using a male voice.",
  )
})

test("speech preserves complete larger sentences and decimal numbers", () => {
  const first =
    "The proposal now narrows scope to the adapter and its test file, and strengthens cancellation acceptance to require every microphone track to stop while preserving all existing draft text without sending it."
  expect(first.length).toBeGreaterThan(120)
  expect(speechSegments(first + " The measured value was 3.14 seconds.")).toEqual([
    first,
    "The measured value was 3.14 seconds.",
  ])
})

test("oversized sentences prefer clause boundaries and retain the entire reply", () => {
  const clause =
    "The microphone tracks are all stopped and the existing composer draft stays exactly as it was before recording began,"
  const text = clause + " " + "the remaining words are preserved ".repeat(20).trim() + "."
  const segments = speechSegments(text)
  expect(segments[0]).toBe(clause)
  expect(segments.every((segment) => segment.length <= SPEECH_CHUNK_CHARS)).toBe(true)
  expect(segments.every((segment) => segment.split(/\s+/).length <= 48)).toBe(true)
  expect(segments.join(" ")).toBe(text)
})
