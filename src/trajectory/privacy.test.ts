import { expect, test } from "bun:test"
import { privacyStats, safeText, safeValue } from "./privacy.ts"

test("visible text redacts OpenCode credentials including embedded quoted JSON", () => {
  const key = `oc_sk_${"a".repeat(12)}_${"B".repeat(32)}`
  const stats = privacyStats()
  const text = safeText(`Console key: ${key}; config: {"apiKey":"fake-credential-canary"}`, stats)
  expect(text).not.toContain(key)
  expect(text).not.toContain("fake-credential-canary")
  expect(text).toContain("[REDACTED]")
})

test("structured projection omits tagged private content and unsupported values safely", () => {
  const stats = privacyStats()
  const getter = Object.defineProperty({}, "private", {
    enumerable: true,
    get() {
      throw new Error("GETTER_PRIVATE_CANARY")
    },
  })
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("PROXY_PRIVATE_CANARY")
      },
    },
  )
  const input = {
    safe: "visible summary",
    context: { messages: [{ type: "reasoning", text: "NESTED_REASONING_CANARY" }] },
    tool: { type: "tool", name: "Bash", state: { input: "FULL_INPUT_CANARY" } },
    unsupported: new Map([["private", "UNSUPPORTED_PRIVATE_CANARY"]]),
    getter,
  }

  const projected = safeValue(input, stats)
  const serialized = JSON.stringify(projected)
  for (const canary of [
    "NESTED_REASONING_CANARY",
    "FULL_INPUT_CANARY",
    "UNSUPPORTED_PRIVATE_CANARY",
    "GETTER_PRIVATE_CANARY",
    "PROXY_PRIVATE_CANARY",
  ])
    expect(serialized).not.toContain(canary)
  expect(serialized).toContain("visible summary")
  expect(serialized).toContain('"name":"Bash"')
  expect(() => safeValue(proxy, stats)).not.toThrow()
  expect(safeValue(proxy, stats)).toBe("[omitted: unsupported value]")

  const doubleEncoded = safeText(
    JSON.stringify(JSON.stringify({ type: "reasoning", text: "DOUBLE_ENCODED_CANARY" })),
    stats,
  )
  expect(doubleEncoded).not.toContain("DOUBLE_ENCODED_CANARY")
  expect(stats.omittedReasoning).toBeGreaterThan(0)
  expect(stats.unknown).toBeGreaterThan(0)
})

test("structured JSON strings at the nesting limit fail closed without hiding safe siblings", () => {
  const stats = privacyStats()
  const privateJson = JSON.stringify({ type: "reasoning", text: "DEPTH_STRING_PRIVATE_CANARY" })
  let belowLimit: unknown = privateJson
  for (let index = 0; index < 6; index++) belowLimit = { child: belowLimit }

  let atLimit: unknown = JSON.stringify(privateJson)
  for (let index = 0; index < 7; index++) atLimit = { child: atLimit }

  const serialized = JSON.stringify(
    safeValue({ summary: "visible safe summary", belowLimit, atLimit }, stats),
  )
  expect(serialized).not.toContain("DEPTH_STRING_PRIVATE_CANARY")
  expect(serialized).toContain("visible safe summary")
  expect(stats.unknown).toBeGreaterThan(0)
})

test("text bounds count Unicode code points after redaction", () => {
  for (const [input, maximum, output, truncated] of [
    ["short", 5, "short", 0],
    ["shorter", 5, "short…[truncated]", 1],
    ["😀😀", 2, "😀😀", 0],
    ["a😀b", 2, "a😀…[truncated]", 1],
    ["", 0, "", 0],
  ] as const) {
    const stats = privacyStats()
    expect(safeText(input, stats, maximum)).toBe(output)
    expect(stats.truncated).toBe(truncated)
  }
  const stats = privacyStats()
  expect(safeText("password=hidden", stats, 100)).toBe("password=[REDACTED]")
  expect(stats.redacted).toBe(1)
})
