import { expect, test } from "bun:test"
import { eventLabel, eventPayloadText } from "./history.ts"

test("event names are translated for display", () => {
  expect(eventLabel("EFFECT_INTENDED")).toBe("Action planned")
  expect(eventLabel("READY")).toBe("Ready to run")
  expect(eventLabel("OUTCOME_OWNER_TRANSFER_UNCERTAIN")).toBe("Owner transfer uncertain")
  expect(eventLabel("ARCHITECT_RENEWAL_PREPARED")).toBe("Renewal prepared")
  for (const name of ["EFFECT_INTENDED", "SOME_NEW_EVENT", "OUTCOME_SUPERSEDED"])
    expect(eventLabel(name)).not.toMatch(/_|^[A-Z]+$/)
})

test("an event payload reads as indented JSON, and text that is not JSON as stored", () => {
  expect(eventPayloadText('{"attempt":1,"model":{"id":"m"}}')).toBe(
    '{\n  "attempt": 1,\n  "model": {\n    "id": "m"\n  }\n}',
  )
  expect(eventPayloadText("not json")).toBe("not json")
  expect(eventPayloadText("")).toBe("")
})
