import { expect, test } from "bun:test"
import { Effect } from "effect"
import { registerBudget } from "../../src/budget/server.ts"
import type { Usage } from "../../src/budget/contract.ts"
import type { UsageFetch } from "../../src/budget/usage.ts"
import { localWeek } from "../../src/budget/usage.ts"

test("private baselines survive registration/restart, coalesce reads and isolate rotations", async () => {
  const stored = new Map<string, unknown>()
  let key = "test-only-connection-a"
  let credit = 100
  let byok = 20
  let calls = 0
  let rotateDuringRead = false
  const fetcher: UsageFetch = async () => {
    calls++
    if (rotateDuringRead) key = "test-only-connection-c"
    return Response.json({
      data: { usage: credit, byok_usage: byok, limit: 300, usage_weekly: 9999 },
    })
  }
  const open = async () => {
    let read: (input: {
      provider: "openrouter"
      start: number
      end: number
      timezone: string
    }) => Effect.Effect<Usage> = () => Effect.die("not registered")
    const ctx = {
      integration: {
        connection: {
          active: () => Effect.succeed({}),
          resolve: () => Effect.succeed({ type: "key", key }),
        },
      },
      storage: {
        get: (name: string) => Effect.succeed(stored.get(name)),
        set: (name: string, value: unknown) =>
          Effect.sync(() => {
            stored.set(name, structuredClone(value))
          }),
      },
      rpc: {
        register: (_definition: unknown, handlers: { read: typeof read }) => {
          read = handlers.read
          return Effect.succeed({})
        },
      },
    }
    await Effect.runPromise(Effect.scoped(registerBudget(ctx as never, fetcher)))
    return () => Effect.runPromise(read({ provider: "openrouter", ...localWeek() }))
  }
  let read = await open()
  const [first, same] = await Promise.all([read(), read()])
  expect(calls).toBe(1)
  expect(first).toEqual(same)
  expect(first.creditUSD).toBeNull()
  expect(stored.size).toBe(1)
  expect(JSON.stringify([...stored])).not.toContain(key)
  credit += 120.4
  byok += 60.2
  read = await open()
  const tracked = await read()
  expect(tracked.status).toBe("available")
  expect(tracked.creditUSD).toBeCloseTo(120.4)
  expect(tracked.byokUSD).toBeCloseTo(60.2)
  expect(tracked.coverageStart).toBe(first.coverageStart)
  expect(JSON.stringify(tracked)).not.toContain("9999")
  key = "test-only-connection-b"
  const rotated = await read()
  expect(rotated.creditUSD).toBeNull()
  expect(rotated.status).toBe("unavailable")
  expect(stored.size).toBe(2)
  read = await open()
  rotateDuringRead = true
  expect((await read()).reason).toContain("connection changed")
})

test("backend failures return a fixed sanitized unavailable response", async () => {
  let read: (() => Effect.Effect<Usage>) | undefined
  await Effect.runPromise(
    registerBudget({
      integration: {
        connection: {
          active: () => Effect.die("raw authorization payload"),
          resolve: () => Effect.void,
        },
      },
      rpc: {
        register: (
          _: unknown,
          handlers: {
            read: (
              input: { provider: "openrouter" } & ReturnType<typeof localWeek>,
            ) => Effect.Effect<Usage>
          },
        ) => {
          read = () => handlers.read({ provider: "openrouter", ...localWeek() })
          return Effect.succeed({})
        },
      },
    } as never).pipe(Effect.scoped),
  )
  const value = await Effect.runPromise(read!())
  expect(value.status).toBe("unavailable")
  expect(value.creditUSD).toBeNull()
  expect(JSON.stringify(value)).not.toContain("authorization")
})

type ReadInput = ReturnType<typeof localWeek> & { provider: "go" | "openrouter" }
async function registeredReads(
  stored: Map<string, unknown>,
  fetcher: UsageFetch,
  run: (read: (input: ReadInput, signal?: AbortSignal) => Promise<Usage>) => Promise<void>,
) {
  let handler: (input: ReadInput) => Effect.Effect<Usage> = () => Effect.die("not registered")
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* registerBudget(
          {
            integration: {
              connection: {
                active: () => Effect.succeed({}),
                resolve: () => Effect.succeed({ type: "key", key: "test-only-shared-connection" }),
              },
            },
            storage: {
              get: (name: string) => Effect.succeed(stored.get(name)),
              set: (name: string, value: unknown) =>
                Effect.sync(() => {
                  stored.set(name, structuredClone(value))
                }),
            },
            rpc: {
              register: (_: unknown, handlers: { read: typeof handler }) => {
                handler = handlers.read
                return Effect.succeed({})
              },
            },
          } as never,
          fetcher,
        )
        yield* Effect.promise(() =>
          run((input, signal) => Effect.runPromise(handler(input), { signal })),
        )
      }),
    ),
  )
}

test("registered shared RPC survives first caller cancellation and cancels only its last reader", async () => {
  const started = Promise.withResolvers<AbortSignal>()
  const finish = Promise.withResolvers<Response>()
  let calls = 0
  const body = {
    usage: {
      monthly: { percent: 64.5, status: "ok", resetsAt: "2026-12-01T00:00:00Z" },
      rolling: { percent: 12, status: "ok", resetsAt: "2026-12-01T00:00:00Z" },
    },
  }
  await registeredReads(
    new Map(),
    async (_url, options) => {
      calls++
      started.resolve(options.signal as AbortSignal)
      return finish.promise
    },
    async (read) => {
      const input: ReadInput = { provider: "go", ...localWeek() }
      const first = new AbortController()
      const second = new AbortController()
      const cancelled = read(input, first.signal).catch(() => undefined)
      const remaining = read(input, second.signal)
      const operationSignal = await started.promise
      first.abort()
      await cancelled
      expect(operationSignal.aborted).toBe(false)
      finish.resolve(Response.json(body))
      expect(await remaining).toMatchObject({ status: "available", monthly: { percent: 64.5 } })
      expect(calls).toBe(1)
    },
  )

  const lastStarted = Promise.withResolvers<AbortSignal>()
  const aborted = Promise.withResolvers<void>()
  let attempts = 0
  await registeredReads(
    new Map(),
    async (_url, options) => {
      attempts++
      if (attempts > 1) return Response.json(body)
      const signal = options.signal as AbortSignal
      lastStarted.resolve(signal)
      return new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted.resolve()
            reject(new Error("Request cancelled"))
          },
          { once: true },
        ),
      )
    },
    async (read) => {
      const controller = new AbortController()
      const input: ReadInput = { provider: "go", ...localWeek() }
      const pending = read(input, controller.signal).catch(() => undefined)
      const operationSignal = await lastStarted.promise
      controller.abort()
      await pending
      await aborted.promise
      expect(operationSignal.aborted).toBe(true)
      expect((await read(input)).status).toBe("available")
      expect(attempts).toBe(2)
    },
  )
})

test("registered alternating-timezone readers retain independent baselines across restart", async () => {
  function weekIn(timezone: string) {
    const previous = process.env.TZ
    try {
      process.env.TZ = timezone
      return localWeek()
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  }
  const detroit: ReadInput = { provider: "openrouter", ...weekIn("America/Detroit") }
  const tokyo: ReadInput = { provider: "openrouter", ...weekIn("Asia/Tokyo") }
  const stored = new Map<string, unknown>()
  let credit = 100
  let byok = 20
  const readAfterRestart = async (input: ReadInput) => {
    let usage: Usage | undefined
    await registeredReads(
      stored,
      async () => Response.json({ data: { usage: credit, byok_usage: byok } }),
      async (read) => {
        usage = await read(input)
      },
    )
    return usage!
  }
  expect((await readAfterRestart(detroit)).creditUSD).toBeNull()
  credit = 120
  byok = 25
  expect((await readAfterRestart(tokyo)).creditUSD).toBeNull()
  credit = 140
  byok = 30
  expect(await readAfterRestart(detroit)).toMatchObject({
    status: "available",
    creditUSD: 40,
    byokUSD: 10,
  })
  credit = 150
  byok = 35
  expect(await readAfterRestart(tokyo)).toMatchObject({
    status: "available",
    creditUSD: 30,
    byokUSD: 10,
  })
  expect(stored.size).toBe(2)
  expect(
    [...stored.values()].map((value) => (value as { timezone: string }).timezone).sort(),
  ).toEqual(["America/Detroit", "Asia/Tokyo"])
})
