import { expect, test } from "bun:test"
import { InferenceBroker } from "./broker.ts"
import type { InferenceResult } from "./rpc.ts"

const request = (prompt: string) => ({ prompt, maxTokens: 16, timeoutMs: 1_000 })
const result = (text: string): InferenceResult => ({
  ok: true,
  text,
  error: "",
  promptTokens: 4,
  completionTokens: 2,
})

test("FIFO requests run serially, and a polling busy renderer cannot consume the next job", async () => {
  const broker = new InferenceBroker()
  broker.attach("window")
  const first = broker.generate(request("first"), new AbortController().signal)
  const second = broker.generate(request("second"), new AbortController().signal)
  const a = broker.poll("window").job!
  expect(a.prompt).toBe("first")
  expect(broker.poll("window").job).toBeNull()
  broker.complete("window", a.id, result("one"))
  expect(broker.poll("window", false).job).toBeNull()
  const b = broker.poll("window").job!
  expect(b.prompt).toBe("second")
  broker.complete("window", b.id, result("two"))
  expect((await first).text).toBe("one")
  expect((await second).text).toBe("two")
  broker.close()
})

test("queued cancellation removes only that request; active cancellation waits for renderer acknowledgement", async () => {
  const broker = new InferenceBroker()
  broker.attach("window")
  const queuedAbort = new AbortController()
  const activeAbort = new AbortController()
  const first = broker.generate(request("first"), activeAbort.signal)
  const second = broker.generate(request("second"), queuedAbort.signal)
  queuedAbort.abort()
  expect((await second).ok).toBe(false)
  const job = broker.poll("window").job!
  activeAbort.abort()
  expect((await first).error).toContain("cancelled")
  const third = broker.generate(request("third"), new AbortController().signal)
  expect(broker.poll("window")).toEqual({ job: null, cancelID: job.id })
  broker.complete("window", job.id, result("late"))
  const next = broker.poll("window").job!
  expect(next.prompt).toBe("third")
  broker.complete("window", next.id, result("three"))
  expect((await third).text).toBe("three")
  broker.close()
})

test("queue capacity and ownership are enforced; heartbeat loss fails only delivered work", async () => {
  let now = 0
  const broker = new InferenceBroker(() => now, 15_000)
  broker.attach("window")
  expect(() => broker.attach("another-window")).toThrow()
  const waiting = Array.from({ length: 8 }, (_, index) =>
    broker.generate(request(String(index)), new AbortController().signal),
  )
  expect(
    (await broker.generate(request("overflow"), new AbortController().signal)).error,
  ).toContain("full")
  expect(() => broker.complete("wrong-owner", "id", result("wrong"))).toThrow()
  const delivered = broker.poll("window").job!
  now = 15_001
  broker.expire()
  expect((await waiting[0]!).error).toContain("heartbeat")
  broker.attach("replacement")
  expect(() => broker.complete("window", delivered.id, result("late"))).toThrow()
  for (let i = 1; i < waiting.length; i++) {
    const job = broker.poll("replacement").job!
    expect(job.prompt).toBe(String(i))
    broker.complete("replacement", job.id, result("recovered"))
    expect((await waiting[i]!).text).toBe("recovered")
  }
  broker.close()
})

test("idle unload preserves a racing queued request; failed model loading fails the waiters", async () => {
  const broker = new InferenceBroker()
  broker.attach("idle")
  const waiting = broker.generate(request("racing request"), new AbortController().signal)
  broker.detach("idle")
  expect(broker.demand().requested).toBe(true)
  broker.attach("new")
  const job = broker.poll("new").job!
  broker.complete("new", job.id, result("served once"))
  expect((await waiting).text).toBe("served once")
  const failure = broker.generate(request("failed load"), new AbortController().signal)
  broker.detach("new", "Model checksum mismatch")
  expect((await failure).error).toContain("checksum")
  expect(broker.demand().requested).toBe(false)
})

test("deadlines include time waiting in the queue and release capacity", async () => {
  const broker = new InferenceBroker()
  broker.attach("window")
  const waiting = broker.generate(request("never taken"), new AbortController().signal)
  expect((await waiting).error).toContain("deadline")
  expect(broker.poll("window").job).toBeNull()
  broker.close()
})

test("a cold request queues before renderer attachment and wakes on demand", async () => {
  const broker = new InferenceBroker()
  const pending = broker.generate(request("cold"), new AbortController().signal)
  expect(broker.demand().requested).toBe(true)
  broker.attach("auto-loaded")
  const job = broker.poll("auto-loaded").job!
  expect(job.prompt).toBe("cold")
  broker.complete("auto-loaded", job.id, result("warm"))
  expect((await pending).text).toBe("warm")
  expect(broker.demand().requested).toBe(false)
  broker.close()
})
