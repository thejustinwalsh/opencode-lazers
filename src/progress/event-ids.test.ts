import { expect, test } from "bun:test"
import { EVENT_ID_WINDOW, mergeEventIDsText, mergeSourcesText } from "./recorder.ts"

test("a dedupe hit leaves the event id list untouched and the list stays windowed", () => {
  let ids = "[]"
  for (let index = 0; index < 1_000; index++) ids = mergeEventIDsText(ids, `evt_${index}`)
  const parsed: string[] = JSON.parse(ids)
  expect(parsed.length).toBe(EVENT_ID_WINDOW)
  expect(parsed[0]).toBe("evt_0")
  expect(parsed.at(-1)).toBe("evt_999")
  // Replaying a listed id, or no id, returns the same text without a parse or rewrite.
  expect(mergeEventIDsText(ids, "evt_999")).toBe(ids)
  expect(mergeEventIDsText(ids, undefined)).toBe(ids)
})

test("sources merge as a sorted set and a known source is a no-op", () => {
  const merged = mergeSourcesText(JSON.stringify(["native-event"]), ["recovery", "native-event"])
  expect(JSON.parse(merged)).toEqual(["native-event", "recovery"])
  expect(mergeSourcesText(merged, ["recovery"])).toBe(merged)
})
