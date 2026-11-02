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

function fakeClient(
  relay: LocationInferenceRelay,
  call: (
    input: unknown,
    options: { signal?: AbortSignal; location?: { directory?: string } },
  ) => Promise<unknown>,
  locations: string[] = [location],
) {
  const targets: (string | undefined)[] = []
  const client = {
    rpc(definition: { id: string }) {
      if (definition.id === InferenceRelay.id)
        return {
          discover: (_input: unknown, options: { location?: { directory?: string } }) => {
            targets.push(options.location?.directory)
            return Promise.resolve(relay.discover())
          },
          claim: (
            input: { requestID: string; claimToken: string },
            options: { location?: { directory?: string } },
          ) => {
            targets.push(options.location?.directory)
            return Promise.resolve(relay.claim(input.requestID, input.claimToken))
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
            input: { requestID: string },
            options: { location?: { directory?: string } },
          ) => {
            targets.push(options.location?.directory)
            return Promise.resolve(relay.recover(input.requestID))
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
          await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve()
            signal.addEventListener("abort", () => resolve(), { once: true })
          })
          yield undefined
        })(),
    },
  }
  return { client: client as unknown as OpenCodeClient, targets }
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
