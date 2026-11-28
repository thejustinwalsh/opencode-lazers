import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { registerWorker } from "./roles.ts"
import { capacityLimit, fixture, runPlan, useRuntimeFixtureCleanup } from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

test("native idle releases the task slot and a primary model request waits for a slot in the same session", async () => {
  const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
  await capacityLimit(f, 1)
  await runPlan(f)
  await f.runtime.tick()
  const attempt = f.store.attempts(f.receipt.planID)[0]!
  type Hook = (value: never) => Effect.Effect<void>
  const hooks = new Map<string, Hook>()
  const ctx = {
    agent: { transform: () => Effect.void },
    tool: { hook: () => Effect.void },
    session: {
      hook: (name: string, hook: Hook) => {
        hooks.set(name, hook)
        return Effect.void
      },
      get: () => Effect.succeed({ time: {} }),
    },
    event: { subscribe: () => Stream.never },
  } as unknown as Plugin.Context
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* registerWorker(ctx, f.store, undefined, f.runtime.delegatedAgentCapacity)
        const idle = hooks.get("experimental.idle")!
        yield* idle({
          sessionID: attempt.session_id,
          background: [{ kind: "shell", sessionID: attempt.session_id }],
        } as never)
        expect(
          (yield* Effect.promise(() => f.runtime.delegatedAgentCapacity.settings())).active,
        ).toBe(1)
        yield* idle({ sessionID: attempt.session_id, background: [] } as never)
        expect(
          (yield* Effect.promise(() => f.runtime.delegatedAgentCapacity.settings())).active,
        ).toBe(0)
        const helper = yield* Effect.promise(() =>
          f.runtime.delegatedAgentCapacity.ensureNativeQueued({
            parentSessionID: "owner",
            toolCallID: "research",
            agent: "research",
            description: "Independent work",
          }),
        )
        yield* Effect.promise(() =>
          f.runtime.delegatedAgentCapacity.waitForNative(helper, AbortSignal.timeout(1000)),
        )
        yield* hooks.get("model.request")!({
          sessionID: attempt.session_id,
          kind: "title",
        } as never)
        let resumed = false
        const turn = Effect.runPromise(
          hooks.get("model.request")!({ sessionID: attempt.session_id, kind: "primary" } as never),
        ).then(() => {
          resumed = true
        })
        yield* Effect.promise(() => Bun.sleep(10))
        expect(resumed).toBe(false)
        yield* Effect.promise(() => f.runtime.delegatedAgentCapacity.releaseNativeRequest(helper))
        yield* Effect.promise(() => turn)
        expect(resumed).toBe(true)
        expect(
          (yield* Effect.promise(() => f.runtime.delegatedAgentCapacity.settings())).active,
        ).toBe(1)
        expect(f.store.attempts(f.receipt.planID).map((a) => a.id)).toEqual([attempt.id])
      }),
    ),
  )
})
