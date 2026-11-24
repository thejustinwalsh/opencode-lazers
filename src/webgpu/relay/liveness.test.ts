import { expect, test } from "bun:test"
import type { OpenCodeClient } from "@opencode/client/promise"
import { DesktopInferenceRelay } from "./desktop.ts"
import { CLAIM_LEASE_MS } from "./lease.ts"
import { LocationInferenceRelay } from "./location.ts"
import { makeClient, waitUntil } from "./relay-client.fixture.ts"

const observed = (pending: Promise<unknown>) => pending.catch((error: unknown) => String(error))

test("source leases retire all abandoned control claims after disconnected owner shutdown", async () => {
  let now = 1_000
  const source = new LocationInferenceRelay(
    () => {},
    () => now,
  )
  let releaseBegin!: () => void
  const beginGate = new Promise<void>((resolve) => (releaseBegin = resolve))
  let claims = 0
  let forwarded = 0
  const client = makeClient(
    source,
    async () => {
      forwarded++
      return { ready: true }
    },
    {
      beforeBegin: async () => {
        claims++
        await beginGate
      },
    },
  )
  let current: OpenCodeClient | undefined = client
  const owner = new DesktopInferenceRelay(() => current, new AbortController().signal)
  const { DesktopInferenceRelay: Replacement } = await import(
    new URL(`./desktop.ts?abandoned-owner=${crypto.randomUUID()}`, import.meta.url).href
  )
  const replacement = new Replacement(() => client, new AbortController().signal)
  const calls = Array.from({ length: 8 }, () =>
    observed(source.forward("settings", {}, new AbortController().signal)),
  )

  try {
    await owner.resync()
    await waitUntil(() => claims === 8)
    current = undefined
    owner.refreshConnection()
    await owner.close()
    await replacement.resync()
    expect(source.discover().requests).toHaveLength(8)
    expect(forwarded).toBe(0)

    now += CLAIM_LEASE_MS + 1
    expect(source.discover().requests).toEqual([])
    for (const outcome of await Promise.all(calls))
      expect(outcome).toContain("ownership expired before inference delivery")

    releaseBegin()
    const next = source.forward("settings", {}, new AbortController().signal)
    await replacement.resync()
    await expect(next).resolves.toEqual({ ready: true })
    expect(forwarded).toBe(1)
  } finally {
    releaseBegin()
    await Promise.all([owner.close(), replacement.close()])
    source.close()
  }
})

test("content-free owner renewal keeps a live control alive without changing its deadline", async () => {
  let now = 1_000
  const source = new LocationInferenceRelay(
    () => {},
    () => now,
  )
  let release!: () => void
  let started = false
  const gate = new Promise<void>((resolve) => (release = resolve))
  const client = makeClient(source, async () => {
    started = true
    await gate
    return { configured: true }
  })
  const owner = new DesktopInferenceRelay(() => client, new AbortController().signal)
  const pending = source.forward("configure", {}, new AbortController().signal)

  try {
    await owner.resync()
    await waitUntil(() => started)
    const id = source.discover().requests[0]!.requestID
    for (let cycle = 0; cycle < 3; cycle++) {
      now += CLAIM_LEASE_MS - 1
      expect(source.renew(id, "foreign-owner")).toBe(false)
      await owner.resync()
      expect(source.discover().requests).toEqual([{ requestID: id, state: "delivered" }])
    }
    release()
    await expect(pending).resolves.toEqual({ configured: true })
  } finally {
    release()
    await owner.close()
    source.close()
  }
})

test("owner renewal cannot extend a caller deadline or replay expired delivered work", async () => {
  let now = 1_000
  const source = new LocationInferenceRelay(
    () => {},
    () => now,
  )
  const pending = observed(
    source.forward("ask", { timeoutMs: 1_000 }, new AbortController().signal),
  )
  const id = source.discover().requests[0]!.requestID
  const token = crypto.randomUUID()
  source.claim(id, token)
  source.begin(id, token)
  now += 500
  expect(source.renew(id, token)).toBe(true)
  now += 501
  expect(source.renew(id, token)).toBe(false)
  expect(await pending).toContain("Local inference deadline exceeded")
  expect(source.complete(id, token, { status: "result", value: "late" })).toBe(false)
  source.close()
})

test.each(["before", "after"] as const)(
  "terminal RPC failure %s source commit retains its token until reconciliation",
  async (failure) => {
    const source = new LocationInferenceRelay()
    let attempts = 0
    let forwarded = 0
    const client = makeClient(
      source,
      async () => {
        forwarded++
        return { ready: true }
      },
      {
        beforeComplete: () => {
          attempts++
          if (failure === "before" && attempts === 1) throw new Error("temporary transport loss")
        },
        afterComplete: () => {
          if (failure === "after" && attempts === 1) throw new Error("completion reply lost")
        },
      },
    )
    const main = new DesktopInferenceRelay(() => client, new AbortController().signal)
    const pending = observed(source.forward("settings", {}, new AbortController().signal))
    try {
      await main.resync()
      await waitUntil(
        () => attempts >= 2,
        () => main.resync(),
      )
      expect(await pending).toEqual({ ready: true })
      expect(forwarded).toBe(1)
      expect(source.discover().requests).toEqual([])
    } finally {
      await main.close()
      source.close()
    }
  },
)

test("same-client reconnect releases eight locally settled slots after source cancellation cleanup", async () => {
  const source = new LocationInferenceRelay()
  let calls = 0
  let aborted = 0
  const client = makeClient(source, async (signal) => {
    calls++
    if (calls > 8) return { ready: true }
    return new Promise((_resolve, reject) => {
      const abort = () => {
        aborted++
        reject(new Error("renderer aborted"))
      }
      if (signal?.aborted) abort()
      else signal?.addEventListener("abort", abort, { once: true })
    })
  })
  let current: OpenCodeClient | undefined = client
  const main = new DesktopInferenceRelay(() => current, new AbortController().signal)
  const controllers = Array.from({ length: 8 }, () => new AbortController())
  const pending = controllers.map((controller) =>
    observed(source.forward("settings", {}, controller.signal)),
  )
  try {
    main.start()
    await main.resync()
    await waitUntil(() => calls === 8)
    current = undefined
    main.refreshConnection()
    await waitUntil(() => aborted === 8)
    for (const controller of controllers) controller.abort()
    await Promise.all(pending)
    for (const { requestID } of source.discover().requests) source.acknowledge(requestID)

    current = client
    main.refreshConnection()
    const next = observed(source.forward("settings", {}, new AbortController().signal))
    await waitUntil(
      () => calls === 9,
      () => main.resync(),
    )
    expect(await next).toEqual({ ready: true })
    expect(calls).toBe(9)
  } finally {
    for (const controller of controllers) controller.abort()
    await main.close()
    source.close()
  }
})
