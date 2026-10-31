import { expect, test } from "bun:test"
import { privacyStats, safeText } from "./privacy.ts"

test("visible text redacts OpenCode credentials including embedded quoted JSON", () => {
  const key = `oc_sk_${"a".repeat(12)}_${"B".repeat(32)}`
  const stats = privacyStats()
  const text = safeText(`Console key: ${key}; config: {"apiKey":"fake-credential-canary"}`, stats)
  expect(text).not.toContain(key)
  expect(text).not.toContain("fake-credential-canary")
  expect(text).toContain("[REDACTED]")
})
