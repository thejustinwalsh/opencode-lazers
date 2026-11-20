import { expect, test } from "bun:test"
import type { OpenCodeClient } from "@opencode/client/promise"
import { RendererInference } from "../rpc.ts"
import { DesktopInferenceRelay } from "./desktop.ts"
import { LocationInferenceRelay } from "./location.ts"
import { InferenceRelay } from "./protocol.ts"

const location = "/workspace/project"
const request = { prompt: "private prompt", maxTokens: 16, timeoutMs: 5_000 }
const result = {
  ok: true,
  text: "forwarded once",
  error: "",
  promptTokens: 3,
  completionTokens: 2,
}

type FakeClientHooks = {
  beforeDiscover?: () => void | Promise<void>
  afterClaim?: () => void
}

function fakeClient(
  relay: LocationInferenceRelay,
  call: (
    input: unknown,
    options: { signal?: AbortSignal; location?: { directory?: string } },
  ) => Promise<unknown>,
  locations: string[] = [location],
  hooks: FakeClientHooks = {},
) {
  const targets: (string | undefined)[] = []
  const subscribers = new Set<{ events: unknown[]; wake?: () => void }>()
  const client = {
    rpc(definition: { id: string }) {
      if (definition.id === InferenceRelay.id)
        return {
          discover: (_input: unknown, options: { location?: { directory?: string } }) => {
            targets.push(options.location?.directory)
            return Promise.resolve(hooks.beforeDiscover?.()).then(() => relay.discover())
          },
          claim: (
            input: { requestID: string; claimToken: string },
            options: { location?: { directory?: string } },
          ) => {
            targets.push(options.location?.directory)
            const claimed = relay.claim(input.requestID, input.claimToken)
            hooks.afterClaim?.()
            return Promise.resolve(claimed)
          },
          begin: (
            input: { requestID: string; claimToken: string },
            options: { location?: { directory?: string } },
          ) => {
            targets.push(options.location?.directory)
            return Promise.resolve(relay.begin(input.requestID, input.claimToken))
          },
          complete: (
            input: {
              requestID: string
              claimToken: string
              completion: Parameters<typeof relay.complete>[2]
            },
            options: { location?: { directory?: string } },
          ) => {
            targets.push(options.location?.directory)
            return Promise.resolve(
              relay.complete(input.requestID, input.claimToken, input.completion),
            )
          },
          recover: (
            input: { requestID: string; claimToken: string },
            options: { location?: { directory?: string } },
          ) => {
            targets.push(options.location?.directory)
            return Promise.resolve(relay.recover(input.requestID, input.claimToken))
          },
          acknowledge: (
            input: { requestID: string },
            options: { location?: { directory?: string } },
          ) => {
            targets.push(options.location?.directory)
            return Promise.resolve(relay.acknowledge(input.requestID))
          },
        }
      if (definition.id === RendererInference.id)
        return {
          ask: (input: unknown, options: { signal?: AbortSignal }) => call(input, options),
        }
      throw new Error(`Unexpected RPC: ${definition.id}`)
    },
    debug: {
      location: { list: async () => locations.map((directory) => ({ directory })) },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) =>
        (async function* () {
          const subscriber: { events: unknown[]; wake?: () => void } = { events: [] }
          subscribers.add(subscriber)
          try {
            while (!signal.aborted) {
              const event = subscriber.events.shift()
              if (event !== undefined) {
                yield event
                continue
              }
              await new Promise<void>((resolve) => {
                const wake = () => {
                  signal.removeEventListener("abort", wake)
                  subscriber.wake = undefined
                  resolve()
                }
                subscriber.wake = wake
                signal.addEventListener("abort", wake, { once: true })
              })
            }
          } finally {
            subscriber.wake?.()
            subscribers.delete(subscriber)
          }
          yield undefined
        })(),
    },
  }
  const emit = (event: unknown) => {
    for (const subscriber of subscribers) {
      subscriber.events.push(event)
      subscriber.wake?.()
    }
  }
  return { client: client as unknown as OpenCodeClient, targets, emit, subscribers }
}

const waitUntil = async (predicate: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Timed out waiting for relay state")
}

test("location relay claims once, delivers once, and drops cancelled payloads", async () => {
  const notices: string[] = []
  const relay = new LocationInferenceRelay((event, id) => notices.push(`${event}:${id}`))
  const controller = new AbortController()
  const completion = relay.forward("ask", request, controller.signal)
  const pending = relay.discover().requests[0]!
  expect(pending.state).toBe("pending")
  expect(JSON.stringify(relay.discover())).not.toContain("private prompt")
  expect(notices).toHaveLength(1)

  const claimToken = crypto.randomUUID()
  expect(relay.claim(pending.requestID, claimToken)).toMatchObject({
    method: "ask",
    input: request,
  })
  expect(relay.claim(pending.requestID, "other-claim")).toBeNull()
  expect(relay.begin(pending.requestID, claimToken)).toMatchObject({ method: "ask" })
  expect(relay.begin(pending.requestID, claimToken)).toMatchObject({ method: "ask" })
  expect(relay.discover().requests[0]?.state).toBe("delivered")

  expect(relay.complete(pending.requestID, claimToken, { status: "result", value: result })).toBe(
    true,
  )
  await expect(completion).resolves.toEqual(result)
  expect(relay.discover().requests).toEqual([])

  const aborted = new AbortController()
  const cancelled = relay.forward("ask", request, aborted.signal)
  const cancelledID = relay.discover().requests[0]!.requestID
  const cancelledToken = crypto.randomUUID()
  relay.claim(cancelledID, cancelledToken)
  relay.begin(cancelledID, cancelledToken)
  aborted.abort()
  await expect(cancelled).rejects.toThrow("delivered inference may still be completing")
  expect(relay.discover().requests[0]).toEqual({ requestID: cancelledID, state: "cancelled" })
  expect(relay.claim(cancelledID, cancelledToken)).toBeNull()
  expect(notices.some((notice) => notice === `cancelled:${cancelledID}`)).toBe(true)
  expect(relay.complete(cancelledID, cancelledToken, { status: "result", value: result })).toBe(
    false,
  )
  expect(relay.discover().requests).toEqual([])
  relay.close()
})

test("location teardown reports delivery uncertainty and control calls retain caller-owned deadlines", async () => {
  const relay = new LocationInferenceRelay()
  const controller = new AbortController()
  const pending = relay.forward("ask", request, controller.signal)
  const id = relay.discover().requests[0]!.requestID
  const claimToken = crypto.randomUUID()
  relay.claim(id, claimToken)
  relay.begin(id, claimToken)
  relay.close()
  await expect(pending).rejects.toThrow("completion is uncertain")
  expect(relay.discover().requests).toEqual([])

  const controls = new LocationInferenceRelay()
  const settingsController = new AbortController()
  const settings = controls.forward("settings", {}, settingsController.signal)
  const envelope = controls.claim(controls.discover().requests[0]!.requestID, crypto.randomUUID())
  expect(envelope?.deadlineAt).toBeNull()
  settingsController.abort()
  await expect(settings).rejects.toThrow("before inference delivery")
  controls.close()
})

test("Desktop resync finds missed notifications and forwards to the default worker", async () => {
  const relay = new LocationInferenceRelay()
  const calls: unknown[] = []
  const transport = fakeClient(relay, async (input, options) => {
    calls.push({ input, location: options.location })
    return result
  })
  const main = new DesktopInferenceRelay(() => transport.client, new AbortController().signal)
  const pending = relay.forward("ask", request, new AbortController().signal)

  await main.resync()
  await expect(pending).resolves.toEqual(result)
  expect(calls).toEqual([{ input: request, location: undefined }])
  expect(transport.targets.length).toBeGreaterThan(0)
  expect(transport.targets.every((target) => target === location)).toBe(true)
  await main.close()
  relay.close()
})

test("a ready renderer accepts a one-second request after handoff overhead without inflating it", async () => {
  let now = 10_000
  const relay = new LocationInferenceRelay(
    () => {},
    () => now,
  )
  let calls = 0
  const transport = fakeClient(
    relay,
    async (input, options) => {
      calls++
      expect(input).toMatchObject({ timeoutMs: 1_000 })
      expect(options.signal?.aborted).toBe(false)
      return result
    },
    [location],
    { afterClaim: () => (now += 250) },
  )
  const main = new DesktopInferenceRelay(() => transport.client, new AbortController().signal, {
    now: () => now,
  })
  const pending = relay.forward(
    "ask",
    { ...request, timeoutMs: 1_000 },
    new AbortController().signal,
  )

  await main.resync()
  await expect(pending).resolves.toEqual(result)
  expect(calls).toBe(1)
  await main.close()
  relay.close()
})

test("a renderer reply after the original deadline cannot become a late success", async () => {
  const relay = new LocationInferenceRelay()
  let finishWorker!: (value: unknown) => void
  const transport = fakeClient(relay, (_input, options) => {
    options.signal?.addEventListener("abort", () => {}, { once: true })
    return new Promise((resolve) => (finishWorker = resolve))
  })
  const main = new DesktopInferenceRelay(() => transport.client, new AbortController().signal)
  main.start()
  const pending = relay.forward(
    "ask",
    { ...request, timeoutMs: 1_000 },
    new AbortController().signal,
  )

  await waitUntil(() => finishWorker !== undefined)
  await expect(pending).rejects.toThrow("Local inference deadline exceeded")
  finishWorker(result)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(relay.discover().requests).toEqual([])
  await main.close()
  relay.close()
})

test("replacement clients cannot complete old requests, while subsequent calls use the replacement", async () => {
  const relay = new LocationInferenceRelay((event, requestID) => {
    void main.handleEvent({
      type: `rpc.${InferenceRelay.id}.${event}`,
      location: { directory: location },
      data: { requestID },
    })
  })
  let oldReply!: (value: unknown) => void
  let oldCalls = 0
  let replacementCalls = 0
  const oldTransport = fakeClient(relay, () => {
    oldCalls++
    return new Promise((resolve) => (oldReply = resolve))
  })
  const newTransport = fakeClient(relay, async () => {
    replacementCalls++
    return { ...result, text: "replacement" }
  })
  let current = oldTransport.client
  const main = new DesktopInferenceRelay(() => current, new AbortController().signal)
  main.start()

  const first = relay.forward("ask", request, new AbortController().signal)
  await waitUntil(() => oldCalls === 1)
  current = newTransport.client
  main.refreshConnection()
  await expect(first).rejects.toThrow("completion is uncertain")
  oldReply(result)
  await Promise.resolve()
  expect(replacementCalls).toBe(0)

  const second = relay.forward("ask", request, new AbortController().signal)
  await expect(second).resolves.toMatchObject({ text: "replacement" })
  expect(oldCalls).toBe(1)
  expect(replacementCalls).toBe(1)
  await main.close()
  relay.close()
})

test("disconnect during delivered inference is recovered as uncertain without replay", async () => {
  const relay = new LocationInferenceRelay()
  let oldCalls = 0
  let newCalls = 0
  const oldTransport = fakeClient(relay, () => {
    oldCalls++
    return new Promise(() => {})
  })
  const newTransport = fakeClient(relay, async () => {
    newCalls++
    return result
  })
  let current: OpenCodeClient | undefined = oldTransport.client
  const main = new DesktopInferenceRelay(() => current, new AbortController().signal)
  main.start()

  const pending = relay.forward("ask", request, new AbortController().signal)
  await waitUntil(() => oldCalls === 1)
  current = undefined
  main.refreshConnection()
  await new Promise((resolve) => setTimeout(resolve, 0))
  current = newTransport.client
  main.refreshConnection()
  await expect(pending).rejects.toThrow("completion is uncertain")
  expect(oldCalls).toBe(1)
  expect(newCalls).toBe(0)
  await main.close()
  relay.close()
})

test("repeated pre-delivery disconnect and cancellation cycles release relay capacity", async () => {
  const relay = new LocationInferenceRelay()
  let current: OpenCodeClient | undefined
  let deliveries = 0
  const ready = fakeClient(relay, async () => {
    deliveries++
    return result
  })
  current = ready.client
  const main = new DesktopInferenceRelay(() => current, new AbortController().signal)
  main.refreshConnection()

  try {
    for (let i = 0; i < 8; i++) {
      let claimed = false
      const disconnecting = fakeClient(
        relay,
        async () => {
          throw new Error("A pre-delivery disconnect must not invoke inference")
        },
        [location],
        {
          afterClaim: () => {
            claimed = true
            current = undefined
          },
        },
      )
      current = disconnecting.client
      main.refreshConnection()
      await new Promise((resolve) => setTimeout(resolve, 0))
      const controller = new AbortController()
      const cancelled = relay.forward("ask", request, controller.signal).then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      )
      await main.resync()
      await waitUntil(
        () => claimed && relay.discover().requests.some((entry) => entry.state === "claimed"),
      )
      controller.abort()
      await expect(cancelled).resolves.toMatchObject({
        ok: false,
        error: expect.objectContaining({
          message: expect.stringContaining("before inference delivery"),
        }),
      })

      current = ready.client
      main.refreshConnection()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await main.resync()
      await waitUntil(() => relay.discover().requests.length === 0)
    }

    const validController = new AbortController()
    const valid = relay.forward("ask", request, validController.signal).then(
      (value) => ({ ok: true, value }),
      (error: unknown) => ({ ok: false, error }),
    )
    await main.resync()
    await waitUntil(() => deliveries === 1)
    await expect(valid).resolves.toEqual({ ok: true, value: result })
    expect(deliveries).toBe(1)
  } finally {
    await main.close()
    relay.close()
  }
})

test("delivered cancellation keeps its slot until uncertain renderer work settles", async () => {
  const relay = new LocationInferenceRelay((event, requestID) => {
    transport.emit({
      type: `rpc.${InferenceRelay.id}.${event}`,
      location: { directory: location },
      data: { requestID },
    })
  })
  const calls: { resolve: (value: unknown) => void }[] = []
  const transport = fakeClient(relay, () => new Promise((resolve) => calls.push({ resolve })))
  const main = new DesktopInferenceRelay(() => transport.client, new AbortController().signal)
  main.start()
  await waitUntil(() => transport.subscribers.size > 0)

  const controllers = Array.from({ length: 8 }, () => new AbortController())
  const delivered = controllers.map((controller) =>
    relay.forward("ask", request, controller.signal),
  )
  try {
    await waitUntil(() => calls.length === 8)
    for (const controller of controllers) controller.abort()
    await Promise.all(
      delivered.map((promise) => expect(promise).rejects.toThrow("will not be replayed")),
    )
    await waitUntil(() => relay.discover().requests.length === 0)

    const ninth = relay.forward("ask", request, new AbortController().signal).then(
      (value) => ({ ok: true, value }),
      (error: unknown) => ({ ok: false, error }),
    )
    await main.resync()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls).toHaveLength(8)

    calls[0]!.resolve(result)
    for (let attempt = 0; attempt < 100 && calls.length < 9; attempt++) {
      await main.resync()
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(calls).toHaveLength(9)
    calls[8]!.resolve(result)
    await expect(ninth).resolves.toEqual({ ok: true, value: result })
    expect(calls).toHaveLength(9)
  } finally {
    await main.close()
    relay.close()
  }
})

test("deferred discovery does not block cancellation events or subsequent request progress", async () => {
  let deferDiscovery = false
  let releaseDiscovery!: () => void
  let discoveryStarted!: () => void
  const discoveryGate = new Promise<void>((resolve) => (releaseDiscovery = resolve))
  const discoveryWait = new Promise<void>((resolve) => (discoveryStarted = resolve))
  const relay = new LocationInferenceRelay((event, requestID) => {
    transport.emit({
      type: `rpc.${InferenceRelay.id}.${event}`,
      location: { directory: location },
      data: { requestID },
    })
  })
  let firstSignal: AbortSignal | undefined
  let workerCalls = 0
  const transport = fakeClient(
    relay,
    (_input, options) => {
      workerCalls++
      if (workerCalls === 1) {
        firstSignal = options.signal
        return new Promise(() => {})
      }
      return Promise.resolve(result)
    },
    [location],
    {
      beforeDiscover: async () => {
        if (!deferDiscovery) return
        discoveryStarted()
        await discoveryGate
      },
    },
  )
  const main = new DesktopInferenceRelay(() => transport.client, new AbortController().signal)
  main.start()
  await waitUntil(() => transport.subscribers.size > 0)

  const firstController = new AbortController()
  const first = relay.forward("ask", request, firstController.signal)
  await waitUntil(() => workerCalls === 1)
  deferDiscovery = true

  const second = relay.forward("ask", request, new AbortController().signal)
  try {
    await discoveryWait
    firstController.abort()
    await expect(first).rejects.toThrow("delivered inference may still be completing")
    await waitUntil(() => firstSignal?.aborted === true)

    releaseDiscovery()
    await expect(second).resolves.toEqual(result)
  } finally {
    releaseDiscovery()
    await main.close()
    relay.close()
  }
})
