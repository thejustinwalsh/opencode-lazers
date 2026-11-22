import { expect, test } from "bun:test"
import { pricesLabel } from "./prices-label.ts"

const now = Date.parse("2026-11-22T03:00:00Z")
const entry = (source: string, retrievedAt: string, refresh?: Record<string, unknown>) => ({
  source,
  snapshot: { retrievedAt },
  refresh: (refresh ?? { state: "succeeded" }) as never,
})
const used = ["openrouter-models", "native-catalog"]

test("prices retrieved today show the time and the sources used", () => {
  expect(
    pricesLabel(
      [
        entry("openrouter-models", "2026-11-22T02:34:44Z"),
        entry("native-catalog", "2026-11-22T02:34:43Z"),
      ],
      used,
      now,
      "en-US",
    ),
  ).toEqual({ text: expect.stringMatching(/^OpenRouter, OpenCode prices \d{1,2}:34 [AP]M$/) })
})

test("prices from an earlier day show their date and say they are stale and why", () => {
  // Live 2026-11-22: "Prices 1:39 PM" was two days old and read as today.
  const old = "2026-11-19T18:39:46Z"
  const label = pricesLabel([entry("openrouter-models", old)], used, now, "en-US")!
  expect(label.text).toMatch(/^OpenRouter prices Nov 19, \d{1,2}:39 [AP]M$/)
  expect(label.stale).toMatch(/^Stale: not refreshed since Nov 19, \d{1,2}:39 [AP]M$/)
  expect(
    pricesLabel(
      [
        entry("openrouter-models", old, {
          state: "failed",
          errorCode: "server-error",
          httpStatus: 503,
        }),
      ],
      used,
      now,
      "en-US",
    )!.stale,
  ).toBe("Stale: the last refresh failed (source server error, HTTP 503)")
  expect(
    pricesLabel([entry("openrouter-models", old, { state: "refreshing" })], used, now, "en-US")!
      .stale,
  ).toBe("Stale: refreshing now")
})

test("a source with no prices is skipped; with none, no price line", () => {
  expect(
    pricesLabel(
      [
        { source: "openrouter-models", snapshot: null },
        entry("native-catalog", "2026-11-22T02:50:00Z"),
      ],
      used,
      now,
      "en-US",
    )!.text,
  ).toMatch(/^OpenCode prices/)
  expect(pricesLabel([{ source: "openrouter-models", snapshot: null }], used, now)).toBeUndefined()
})
