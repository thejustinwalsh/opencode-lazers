import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Session } from "@opencode/schema/session"
import type { Plugin } from "@opencode/plugin/effect"
import { DateTime, Effect, Queue, Stream } from "effect"
import { TaskRepository } from "../storage.ts"
import { RunnerStore } from "./store.ts"
import { DelegatedAgentCapacity } from "./delegated-agent-capacity.ts"
import { registerWorker } from "./roles.ts"

type Hook = (call: never) => Effect.Effect<void>

async function eventually(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Native lifecycle observation did not settle")
    await Bun.sleep(5)
  }
}

async function registered(
  run: (f: {
    capacity: DelegatedAgentCapacity
    before: Hook
    after: Hook
    events: Queue.Queue<unknown>
    observed: { busy?: DateTime.Utc }
    waiters: Array<{ finish: () => void; signal: AbortSignal }>
  }) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "lazers-native-capacity-"))
  const repository = new TaskRepository(join(root, "tasks.sqlite"), root)
  const store = new RunnerStore(repository)
  const capacity = new DelegatedAgentCapacity(repository, "native-capacity-test")
  await capacity.ready()
  const events = Effect.runSync(Queue.unbounded<unknown>())
  const observed: { busy?: DateTime.Utc } = {}
  const waiters: Array<{ finish: () => void; signal: AbortSignal }> = []
  let before!: Hook
  let after!: Hook
  const ctx = {
    agent: { transform: () => Effect.void },
    tool: {
      hook: (name: string, hook: Hook) => {
        if (name === "execute.before") before = hook
        if (name === "execute.after") after = hook
        return Effect.void
      },
    },
    session: {
      hook: () => Effect.void,
      get: () => Effect.succeed({ time: observed }),
      wait: () =>
        Effect.promise((signal) => new Promise<void>((finish) => waiters.push({ finish, signal }))),
    },
    event: { subscribe: () => Stream.fromQueue(events) },
  } as unknown as Plugin.Context
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerWorker(ctx, store, undefined, capacity)
          yield* Effect.promise(() => run({ capacity, before, after, events, observed, waiters }))
        }),
      ),
    )
  } finally {
    repository.close()
    rmSync(root, { recursive: true, force: true })
  }
  return waiters
}

const parent = Session.ID.create()
const child = Session.ID.create()
const call = (id: string, agent = "architect", sessionID?: string) => ({
  sessionID: parent,
  agent,
  tool: "subagent",
  id,
  input: {
    agent: "research",
    description: "native helper",
    background: true,
    ...(sessionID ? { sessionID } : {}),
  },
})

test("fresh Architect research is admitted without a plan, unrelated Build research is excluded", async () => {
  await registered(async (f) => {
    await Effect.runPromise(f.before(call("outside", "build") as never))
    expect(await f.capacity.settings()).toMatchObject({ active: 0 })
    await Effect.runPromise(f.before(call("fresh") as never))
    expect(await f.capacity.settings()).toMatchObject({ active: 1 })
  })
})

test("a newly created idle child cannot release its first execution before prompting", async () => {
  await registered(async (f) => {
    await Effect.runPromise(f.before(call("created") as never))
    await Effect.runPromise(
      Queue.offer(f.events, {
        type: "session.created",
        data: { sessionID: child, parentID: parent, agent: "research", title: "native helper" },
      }),
    )
    await eventually(async () => Boolean(await f.capacity.nativeExecution(child)))
    await Bun.sleep(170)
    expect(f.waiters).toHaveLength(0)
    expect(await f.capacity.settings()).toMatchObject({ active: 1 })
    // The real native tool result, not child creation, confirms which child ran.
    f.observed.busy = DateTime.makeUnsafe(Date.now() + 1)
    await Effect.runPromise(
      f.after({
        ...call("created"),
        status: "completed",
        result: { metadata: { sessionID: child, status: "running" } },
      } as never),
    )
    await eventually(() => f.waiters.length === 1)
    expect(await f.capacity.settings()).toMatchObject({ active: 1 })
    // Missing completion event: the native wait is sufficient for this generation.
    f.waiters[0]!.finish()
    await eventually(async () => (await f.capacity.settings()).active === 0)
  })
})

test.each([false, true])(
  "a delayed wait cannot release followup B (A released: %s)",
  async (released) => {
    const waiters = await registered(async (f) => {
      await Effect.runPromise(f.before(call("A") as never))
      f.observed.busy = DateTime.makeUnsafe(Date.now() + 1)
      await Effect.runPromise(
        f.after({
          ...call("A"),
          status: "completed",
          result: { metadata: { sessionID: child, status: "running" } },
        } as never),
      )
      await eventually(() => f.waiters.length === 1)
      const a = (await f.capacity.nativeExecution(child))!
      // A failed; a new call starts B before A's delayed waiter replies.
      if (released) await f.capacity.releaseNativeRequest(a.id)
      await Effect.runPromise(f.before(call("B", "architect", child) as never))
      const b = (await f.capacity.nativeExecution(child))!
      expect(b.id === a.id).toBe(!released)
      expect(b.key).not.toBe(a.key)
      if (released) f.observed.busy = DateTime.makeUnsafe(Date.now() + 1)
      else {
        // A running-child followup joins the first loop: native time.busy stays
        // unchanged, and time.idle does not exist until that first loop finishes.
        expect(b.createdAt).toBe(a.createdAt)
      }
      await Effect.runPromise(
        f.after({
          ...call("B", "architect", child),
          status: "completed",
          result: { metadata: { sessionID: child, status: "running" } },
        } as never),
      )
      await eventually(() => f.waiters.length === 2)
      f.waiters[0]!.finish()
      await Bun.sleep(10)
      expect(await f.capacity.nativeExecution(child)).toMatchObject({ id: b.id })
      expect(await f.capacity.settings()).toMatchObject({ active: 1 })
      // A late event is just a wake; it cannot settle B by child ID.
      await Effect.runPromise(
        Queue.offer(f.events, {
          type: "session.execution.failed",
          data: { sessionID: child },
        }),
      )
      await Bun.sleep(10)
      expect(await f.capacity.settings()).toMatchObject({ active: 1 })
      if (!released) {
        f.waiters[1]!.finish()
        await eventually(async () => (await f.capacity.settings()).active === 0)
      }
    })
    if (released) expect(waiters[1]!.signal.aborted).toBe(true)
    // Even a promise resolving after plugin disposal cannot touch the closed store.
    waiters[1]!.finish()
    await Bun.sleep(0)
  },
)
