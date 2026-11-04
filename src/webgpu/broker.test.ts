import { expect, test } from "bun:test"
import type { RpcHandlers } from "@opencode/plugin/effect/rpc"
import type { RpcClient } from "@opencode/client"
import { Effect } from "effect"
import { InferenceBroker } from "./broker.ts"
import { registerLocalInference } from "./server.ts"
import { LocalInference, RendererInference } from "./rpc.ts"
import type { InferenceJob, InferenceResult } from "./rpc.ts"
import { defaultFeatures } from "./features.ts"
import { SystemOneRequest } from "./system-one.ts"
import type { SystemOneOutput } from "./system-one.ts"

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

test("System One uses its bounded transport envelope without widening ordinary chat", async () => {
  const broker = new InferenceBroker()
  broker.attach("window")
  const payload = JSON.stringify({
    model: "d1-omni-2b",
    state: { shared: "x".repeat(7_026) },
    questions: Object.fromEntries(
      Array.from({ length: 14 }, (_, index) => [
        `check-${index}`,
        { type: "noul", instructions: `Question ${index}: Is the recorded behavior preserved?` },
      ]),
    ),
    timeoutMs: 60_000,
  })
  expect(payload.length).toBeGreaterThan(8_000)
  expect(payload.length).toBeLessThanOrEqual(64_000)
  const waiting = broker.generate(
    { ...request(payload), mode: "systemone" },
    new AbortController().signal,
  )
  const job = broker.poll("window").job!
  expect(job.mode).toBe("systemone")
  expect(job.prompt).toBe(payload)
  broker.complete("window", job.id, result("one complete result"))
  expect((await waiting).text).toBe("one complete result")

  const oversized = await broker.generate(
    { ...request("x".repeat(64_001)), mode: "systemone" },
    new AbortController().signal,
  )
  expect(oversized.error).toContain("System One transport payload")
  const oversizedChat = await broker.generate(
    request("x".repeat(8_001)),
    new AbortController().signal,
  )
  expect(oversizedChat.error).toContain("experiment limits")
  broker.close()
})

test("typed LocalInference.review forwards a measured request through the renderer mailbox", async () => {
  const stored = new Map<string, unknown>([["webgpu.features", defaultFeatures(true)]])
  let local!: RpcHandlers<typeof LocalInference>
  let renderer!: RpcHandlers<typeof RendererInference>
  const ctx = {
    options: {},
    location: { project: { canonical: "/synthetic" } },
    storage: {
      get: (key: string) => Effect.succeed(stored.get(key)),
      set: (key: string, value: unknown) =>
        Effect.sync(() => {
          stored.set(key, value)
        }),
    },
    permission: { assert: () => Effect.void },
    tool: {
      transform: () => Effect.succeed({ dispose: Effect.void }),
      reload: () => Effect.void,
    },
    agent: {
      transform: () => Effect.succeed({ dispose: Effect.void }),
      reload: () => Effect.void,
    },
    rpc: {
      register: (definition: { id: string }, handlers: unknown) =>
        Effect.sync(() => {
          if (definition.id === RendererInference.id) renderer = handlers as typeof renderer
          else local = handlers as typeof local
          return { dispose: Effect.void, events: { emit: () => Effect.void } }
        }),
    },
  } as unknown as Parameters<typeof registerLocalInference>[0]
  const client = new Proxy(
    {},
    {
      get: (_, key) =>
        key === "then"
          ? undefined
          : (input: unknown, options?: { signal?: AbortSignal }) => {
              const handler = renderer[key as keyof typeof renderer] as (
                input: unknown,
                context: never,
              ) => Effect.Effect<unknown>
              return Effect.runPromise(handler(input, {} as never), {
                signal: options?.signal,
              })
            },
    },
  ) as RpcClient<typeof RendererInference>

  const stateTextLength = 7_026 - JSON.stringify({ shared: "" }).length
  const input = SystemOneRequest.parse({
    model: "d1-omni-2b",
    state: { shared: "x".repeat(stateTextLength) },
    questions: Object.fromEntries(
      Array.from({ length: 14 }, (_, index) => [
        `check-${index}`,
        { type: "noul", instructions: `Question ${index}: Does the behavior remain preserved?` },
      ]),
    ),
    timeoutMs: 60_000,
  })
  expect(JSON.stringify(input.state)).toHaveLength(7_026)
  expect(JSON.stringify(input).length).toBeGreaterThan(8_000)
  expect(Object.keys(input.questions)).toHaveLength(14)

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* registerLocalInference(ctx, async () => client)
        yield* Effect.promise(async () => {
          await Effect.runPromise(renderer.attach({ owner: "renderer" }, {} as never))
          const review = Effect.runPromise(local.review(input, {} as never))
          let job: InferenceJob | null = null
          for (let attempt = 0; attempt < 20 && !job; attempt++) {
            job = (
              await Effect.runPromise(
                renderer.poll({ owner: "renderer", available: true }, {} as never),
              )
            ).job
            if (!job) await Promise.resolve()
          }
          expect(job).not.toBeNull()
          expect(job!.mode).toBe("systemone")
          expect(job!.feature).toBe("review")
          expect(job!.prompt).toBe(JSON.stringify(input))
          const output: SystemOneOutput = {
            model: "d1-omni-2b" as const,
            answers: Object.fromEntries(
              Object.keys(input.questions).map((name) => [
                name,
                { type: "noul" as const, noul: 0.95 },
              ]),
            ),
            usage: { input_tokens: 8_192, output_tokens: 0 as const },
          }
          await Effect.runPromise(
            renderer.complete(
              {
                owner: "renderer",
                id: job!.id,
                result: {
                  ok: true,
                  text: JSON.stringify(output),
                  error: "",
                  promptTokens: 8_192,
                  completionTokens: 0,
                },
              },
              {} as never,
            ),
          )
          expect(await review).toEqual(output)
        })
      }),
    ),
  )
})
