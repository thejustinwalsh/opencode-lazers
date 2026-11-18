import { expect, test } from "bun:test"
import { Schema } from "effect"
import { BudgetSettings, defaults } from "../../src/budget/contract.ts"
import { fetchGo, localWeek, parseGo, ring } from "../../src/budget/usage.ts"
import { fetchCounters, observe, parseCounters } from "../../src/budget/openrouter.ts"
import { SharedUsage } from "../../src/budget/poller.ts"
import { UsageCache } from "../../src/budget/server.ts"

const now = Date.parse("2026-11-04T17:00:00Z")
const week = {
  start: Date.parse("2026-11-01T04:00:00Z"),
  end: Date.parse("2026-11-08T05:00:00Z"),
  timezone: "America/Detroit",
}
const meter = (percent: number) => ({ percent, status: "ok", resetsAt: "2026-11-08T05:00:00Z" })
const go = () => parseGo({ usage: { monthly: meter(59.99), rolling: meter(112.3) } }, now)

test("Go uses raw percentages, validates both meters, and clamps only circle geometry", () => {
  const value = go()
  expect(value.monthly?.percent).toBe(59.99)
  expect(ring(79.99).tone).toBe("normal")
  expect(ring(80).tone).toBe("warning")
  expect(ring(99.99).tone).toBe("warning")
  expect(ring(100).tone).toBe("critical")
  expect(ring(112.3)).toEqual({ fraction: 1, tone: "critical" })
  expect(ring(null).tone).toBe("none")
  for (const percent of [-1, NaN, Infinity, "0", null]) {
    expect(() =>
      parseGo({ usage: { monthly: { ...meter(0), percent }, rolling: meter(0) } }),
    ).toThrow()
  }
  expect(() => parseGo({ usage: { monthly: meter(0) } })).toThrow()
  expect(() =>
    parseGo({ usage: { monthly: { ...meter(0), resetsAt: "no" }, rolling: meter(0) } }),
  ).toThrow()
})

test("settings default off and accept only a finite positive weekly dollar budget", () => {
  expect(defaults.enabled).toBe(false)
  for (const weeklyUSD of [0, -1, NaN, Infinity])
    expect(Schema.decodeUnknownOption(BudgetSettings)({ ...defaults, weeklyUSD })._tag).toBe("None")
  expect(Schema.decodeUnknownOption(BudgetSettings)({ ...defaults, weeklyUSD: 300 })._tag).toBe(
    "Some",
  )
})

test("OpenRouter reads lifetime usage and BYOK only, never limit or UTC counters", () => {
  expect(
    parseCounters({ data: { usage: 50, byok_usage: 10, limit: 300, usage_weekly: 2 } }),
  ).toEqual({ credit: 50, byok: 10 })
  for (const body of [
    { data: { limit: 300 } },
    { data: { usage: 0 } },
    { data: { usage: -1, byok_usage: 0 } },
    { data: { usage: 0, byok_usage: null } },
  ])
    expect(() => parseCounters(body)).toThrow()
})

test("first observation is not zero; persisted baseline yields only observed deltas", () => {
  const first = observe(undefined, { credit: 100, byok: 20 }, week, now)
  expect(first.usage.status).toBe("unavailable")
  expect(first.usage.creditUSD).toBeNull()
  const persisted = JSON.parse(JSON.stringify(first.baseline))
  const second = observe(persisted, { credit: 102.4, byok: 23.2 }, week, now + 60_000)
  expect(second.usage.creditUSD).toBeCloseTo(2.4)
  expect(second.usage.byokUSD).toBeCloseTo(3.2)
  expect(second.usage.coverageStart).toBe(now)
  expect(second.usage.reason).toContain("spend before tracking started is not counted")
  expect(
    observe(second.baseline, { credit: 102.4, byok: 23.2 }, week, now + 120_000).usage.status,
  ).toBe("available")
})

test("missed Sunday, timezone change, clock rollback and counter rollback never allocate a cross-boundary delta", () => {
  const first = observe(undefined, { credit: 100, byok: 20 }, week, now).baseline
  const nextWeek = { ...week, start: week.end, end: week.end + 7 * 86400000 }
  for (const result of [
    observe(first, { credit: 200, byok: 30 }, nextWeek, nextWeek.start + 3600000),
    observe(first, { credit: 200, byok: 30 }, { ...week, timezone: "America/New_York" }, now + 1),
    observe(first, { credit: 99, byok: 30 }, week, now + 1),
    observe(first, { credit: 200, byok: 19 }, week, now + 1),
    observe(first, { credit: 200, byok: 30 }, week, now - 1),
  ]) {
    expect(result.usage.status).toBe("unavailable")
    expect(result.usage.creditUSD).toBeNull()
    expect(result.usage.byokUSD).toBeNull()
  }
})

test("Sunday-local calendar boundaries honor DST and timezone changes", () => {
  const prior = process.env.TZ
  try {
    process.env.TZ = "America/Detroit"
    const spring = localWeek(new Date("2026-03-08T12:00:00Z"))
    const fall = localWeek(new Date("2026-11-01T12:00:00Z"))
    expect(spring.end - spring.start).toBe(167 * 3600000)
    expect(fall.end - fall.start).toBe(169 * 3600000)
    expect(new Date(fall.start).getDay()).toBe(0)
    expect(new Date(fall.start).getHours()).toBe(0)
    process.env.TZ = "Asia/Tokyo"
    expect(localWeek(new Date("2026-11-01T12:00:00Z")).start).not.toBe(fall.start)
  } finally {
    if (prior === undefined) delete process.env.TZ
    else process.env.TZ = prior
  }
})

test("provider transports use canonical HTTPS GET with no credential-forwarding redirects", async () => {
  for (const [request, url, body] of [
    [
      fetchGo,
      "https://opencode.ai/zen/go/v1/usage",
      { usage: { monthly: meter(20), rolling: meter(0) } },
    ],
    [fetchCounters, "https://openrouter.ai/api/v1/key", { data: { usage: 10, byok_usage: 3 } }],
  ] as const) {
    let calls = 0
    const fetcher = (async (input, init) => {
      calls++
      expect(input).toBe(url)
      expect(init?.redirect).toBe("error")
      expect(init?.method ?? "GET").toBe("GET")
      return Response.json(body)
    }) as typeof fetch
    await request("test-only-placeholder", new AbortController().signal, fetcher)
    expect(calls).toBe(1)
    await expect(
      request(
        "test-only-placeholder",
        new AbortController().signal,
        async () => new Response("raw secret-like error must not escape", { status: 403 }),
      ),
    ).rejects.toThrow(/unavailable/)
  }
})

test("shared leases coalesce, abort on last release, and reject old responses", async () => {
  let calls = 0
  let finish: ((v: ReturnType<typeof go>) => void) | undefined
  let signal: AbortSignal | undefined
  const shared = new SharedUsage((s) => {
    calls++
    signal = s
    return new Promise((resolve) => {
      finish = resolve
    })
  }, 10)
  const seen: string[] = []
  const a = shared.subscribe((v) => seen.push(v.status))
  const b = shared.subscribe((v) => seen.push(v.status))
  expect(calls).toBe(1)
  a()
  expect(signal?.aborted).toBe(false)
  b()
  expect(signal?.aborted).toBe(true)
  finish?.(go())
  await Bun.sleep(25)
  expect(calls).toBe(1)
  expect(seen.every((status) => status === "unavailable")).toBe(true)
  const c = shared.subscribe(() => {})
  expect(calls).toBe(2)
  c()
})

test("backend cache coalesces same identity without sharing a new connection", async () => {
  const cache = new UsageCache()
  let calls = 0
  const read = async () => {
    calls++
    return go()
  }
  await Promise.all([cache.read("identity-a", read, 0), cache.read("identity-a", read, 0)])
  expect(calls).toBe(1)
  await cache.read("identity-b", read, 1)
  expect(calls).toBe(2)
  await cache.read(
    "identity-a",
    async () => {
      throw new Error("private raw error")
    },
    60_001,
  )
  expect(await cache.read("identity-a", read, 60_002)).toEqual(go())
})
