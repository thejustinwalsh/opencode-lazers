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
