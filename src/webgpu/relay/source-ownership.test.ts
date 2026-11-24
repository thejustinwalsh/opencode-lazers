import { expect, test } from "bun:test"
import { LocationInferenceRelay } from "./location.ts"
import { makeClient } from "./relay-client.fixture.ts"
const result = {
  ok: true,
  text: "forwarded once",
  error: "",
  promptTokens: 3,
  completionTokens: 2,
}

test("recovery requires the source-stored claim token", async () => {
  const relay = new LocationInferenceRelay()
  const completion = relay.forward(
    "ask",
    { prompt: "owned claim", timeoutMs: 5_000 },
    new AbortController().signal,
  )
  const { requestID } = relay.discover().requests[0]!
  const ownerToken = crypto.randomUUID()

  expect(relay.claim(requestID, ownerToken)).not.toBeNull()
  expect(relay.recover(requestID, "not-the-owner")).toBe(false)
  expect(relay.discover().requests).toEqual([{ requestID, state: "claimed" }])
  expect(relay.recover(requestID, ownerToken)).toBe(true)
  await expect(completion).rejects.toThrow("before inference delivery")
  relay.close()
})

test("isolated Desktop module imports cannot recover another import's healthy claim", async () => {
  const [firstModule, secondModule] = await Promise.all([
    import(new URL(`./desktop.ts?relay-owner=${crypto.randomUUID()}`, import.meta.url).href),
    import(new URL(`./desktop.ts?relay-owner=${crypto.randomUUID()}`, import.meta.url).href),
  ])
  const relay = new LocationInferenceRelay()
  let releaseBegin!: () => void
  let beginStarted!: () => void
  const beginGate = new Promise<void>((resolve) => (releaseBegin = resolve))
  const started = new Promise<void>((resolve) => (beginStarted = resolve))
  let recoverCalls = 0
  let inferenceCalls = 0
  const client = makeClient(
    relay,
    async () => {
      inferenceCalls++
      return result
    },
    {
      beforeBegin: async () => {
        beginStarted()
        await beginGate
      },
      recover: async () => {
        recoverCalls++
        return false
      },
    },
  )
  const signal = new AbortController().signal
  const first = new firstModule.DesktopInferenceRelay(() => client, signal)
  const second = new secondModule.DesktopInferenceRelay(() => client, signal)
  const pending = relay.forward(
    "ask",
    { prompt: "isolated relay claim", timeoutMs: 5_000 },
    new AbortController().signal,
  )

  try {
    await first.resync()
    await started
    const { requestID } = relay.discover().requests[0]!
    await second.resync()

    expect(relay.discover().requests).toEqual([{ requestID, state: "claimed" }])
    expect(recoverCalls).toBe(0)
    expect(inferenceCalls).toBe(0)

    releaseBegin()
    await expect(pending).resolves.toEqual(result)
    expect(inferenceCalls).toBe(1)
  } finally {
    releaseBegin()
    await Promise.all([first.close(), second.close()])
    relay.close()
  }
})
