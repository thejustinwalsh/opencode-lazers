import { expect, test } from "bun:test"
import type { OpenCodeClient } from "@opencode/client/promise"
import { setupMain } from "../main.ts"
import { RendererInference } from "../rpc.ts"
import { DesktopInferenceRelay } from "./desktop.ts"
import { LocationInferenceRelay } from "./location.ts"
import { InferenceRelay } from "./protocol.ts"

const directory = "/workspace/project"
const result = {
  ok: true,
  text: "forwarded once",
  error: "",
  promptTokens: 3,
  completionTokens: 2,
}

type ClientHooks = {
  afterClaim?: () => void
  beforeBegin?: () => Promise<void>
  recover?: (requestID: string) => Promise<boolean>
}

function makeClient(
  relay: LocationInferenceRelay,
  infer: () => Promise<unknown>,
  hooks: ClientHooks = {},
): OpenCodeClient {
  return {
    rpc(definition: { id: string }) {
      if (definition.id === InferenceRelay.id)
        return {
          discover: async () => relay.discover(),
          claim: async ({ requestID, claimToken }: { requestID: string; claimToken: string }) => {
            const request = relay.claim(requestID, claimToken)
            hooks.afterClaim?.()
            return request
          },
          begin: async ({ requestID, claimToken }: { requestID: string; claimToken: string }) => {
            await hooks.beforeBegin?.()
            return relay.begin(requestID, claimToken)
          },
          complete: async ({
            requestID,
            claimToken,
            completion,
          }: {
            requestID: string
            claimToken: string
            completion: Parameters<typeof relay.complete>[2]
          }) => relay.complete(requestID, claimToken, completion),
          recover: ({ requestID, claimToken }: { requestID: string; claimToken: string }) =>
            hooks.recover?.(requestID) ?? Promise.resolve(relay.recover(requestID, claimToken)),
          acknowledge: async ({ requestID }: { requestID: string }) => relay.acknowledge(requestID),
        }
      if (definition.id === RendererInference.id) return { ask: infer }
      throw new Error(`Unexpected RPC: ${definition.id}`)
    },
    debug: {
      location: { list: async () => [{ directory }] },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) =>
        (async function* () {
          if (signal.aborted) return
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          )
          yield undefined
        })(),
    },
  } as unknown as OpenCodeClient
}

const waitUntil = async (predicate: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Timed out waiting for retained relay state")
}

test("source rejects completion after its absolute deadline before timer callbacks run", async () => {
  let now = 10_000
  const relay = new LocationInferenceRelay(
    () => {},
    () => now,
  )
  const completion = relay.forward(
    "ask",
    { prompt: "deadline", timeoutMs: 1_000 },
    new AbortController().signal,
  )
  const request = relay.discover().requests[0]!
  const claimToken = crypto.randomUUID()
  expect(relay.claim(request.requestID, claimToken)).not.toBeNull()
  expect(relay.begin(request.requestID, claimToken)).not.toBeNull()

  now += 1_001
  expect(relay.complete(request.requestID, claimToken, { status: "result", value: result })).toBe(
    false,
  )
  await expect(completion).rejects.toThrow("Local inference deadline exceeded")
  expect(relay.discover().requests).toEqual([{ requestID: request.requestID, state: "cancelled" }])
  expect(relay.acknowledge(request.requestID)).toBe(true)
  relay.close()
})

test("pre-delivery disconnects release claims and later requests retain capacity", async () => {
  const relay = new LocationInferenceRelay()
  let current: OpenCodeClient | undefined
  let calls = 0
  const ready = makeClient(relay, async () => {
    calls++
    return result
  })
  current = ready
  const main = new DesktopInferenceRelay(() => current, new AbortController().signal)

  try {
    for (let i = 0; i < 8; i++) {
      const disconnecting = makeClient(
        relay,
        async () => {
          throw new Error("Pre-delivery disconnect must not invoke inference")
        },
        {
          afterClaim: () => {
            current = undefined
            main.refreshConnection()
          },
        },
      )
      current = disconnecting

      const pending = relay.forward(
        "ask",
        { prompt: "pre-delivery", timeoutMs: 5_000 },
        new AbortController().signal,
      )
      pending.catch(() => {})
      main.refreshConnection()
      for (let attempt = 0; attempt < 200; attempt++) {
        if (relay.discover().requests[0]?.state === "claimed") break
        await main.resync()
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      await waitUntil(() => relay.discover().requests[0]?.state === "claimed")

      current = ready
      main.refreshConnection()
      await expect(pending).rejects.toThrow("before inference delivery")
      await waitUntil(() => relay.discover().requests.length === 0)
    }

    const valid = relay.forward(
      "ask",
      { prompt: "next", timeoutMs: 5_000 },
      new AbortController().signal,
    )
    for (let i = 0; i < 100 && calls === 0; i++) {
      await main.resync()
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await expect(valid).resolves.toEqual(result)
    expect(calls).toBe(1)
  } finally {
    await main.close()
    relay.close()
  }
})

test("a second live Desktop relay cannot recover another relay's active claim", async () => {
  const relay = new LocationInferenceRelay()
  let releaseBegin!: () => void
  let beginStarted!: () => void
  const beginGate = new Promise<void>((resolve) => (releaseBegin = resolve))
  const started = new Promise<void>((resolve) => (beginStarted = resolve))
  let calls = 0
  const client = makeClient(
    relay,
    async () => {
      calls++
      return result
    },
    {
      beforeBegin: () => {
        beginStarted()
        return beginGate
      },
    },
  )
  const signal = new AbortController().signal
  const first = new DesktopInferenceRelay(() => client, signal)
  const second = new DesktopInferenceRelay(() => client, signal)
  const pending = relay.forward(
    "ask",
    { prompt: "shared claim", timeoutMs: 5_000 },
    new AbortController().signal,
  )

  try {
    await first.resync()
    await started
    await second.resync()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(relay.discover().requests).toMatchObject([{ state: "claimed" }])
    expect(calls).toBe(0)

    releaseBegin()
    await expect(pending).resolves.toEqual(result)
    expect(calls).toBe(1)
  } finally {
    releaseBegin()
    await Promise.all([first.close(), second.close()])
    relay.close()
  }
})

test("relay shutdown bounds a stalled source recovery RPC", async () => {
  const relay = new LocationInferenceRelay()
  let releaseBegin!: () => void
  let beginStarted!: () => void
  const beginGate = new Promise<void>((resolve) => (releaseBegin = resolve))
  const started = new Promise<void>((resolve) => (beginStarted = resolve))
  const client = makeClient(relay, async () => result, {
    beforeBegin: () => {
      beginStarted()
      return beginGate
    },
    recover: () => new Promise<boolean>(() => {}),
  })
  const main = new DesktopInferenceRelay(() => client, new AbortController().signal)
  const pending = relay.forward(
    "ask",
    { prompt: "stalled recovery", timeoutMs: 5_000 },
    new AbortController().signal,
  )
  await main.resync()
  await started

  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    const closed = await Promise.race([
      main.close().then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 3_000)
      }),
    ])
    if (timer) clearTimeout(timer)
    expect(closed).toBe(true)
  } finally {
    releaseBegin()
    relay.close()
    await expect(pending).rejects.toThrow("before inference delivery")
  }
})

test("failed main setup does not start Desktop relay subscriptions", () => {
  let subscriptions = 0
  const ctx = {
    options: {},
    signal: new AbortController().signal,
    client: {
      event: {
        subscribe: ({ signal }: { signal: AbortSignal }) => {
          subscriptions++
          return (async function* () {
            if (!signal.aborted)
              await new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), { once: true }),
              )
            yield undefined
          })()
        },
      },
    },
    storage: {
      store: () => ({
        value: { schemaVersion: 1, providerEpoch: "invalid", state: "idle" },
      }),
    },
  } as unknown as Parameters<typeof setupMain>[0]

  expect(() => setupMain(ctx)).toThrow()
  expect(subscriptions).toBe(0)
})
