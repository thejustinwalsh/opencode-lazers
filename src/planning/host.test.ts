import { expect, test } from "bun:test"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { DateTime, Effect } from "effect"
import { planningHost, planningModel } from "./host.ts"

type Call = { method: string; input: Record<string, unknown> }

function stub(overrides: Record<string, (input: never) => unknown> = {}) {
  const calls: Call[] = []
  const wrap =
    (method: string, fallback: (input: never) => unknown) => (input: Record<string, unknown>) => {
      calls.push({ method, input })
      return Effect.suspend(() => {
        try {
          return Effect.succeed(fallback(input as never))
        } catch (error) {
          return Effect.fail(error)
        }
      })
    }
  const session = {
    create: wrap("create", overrides.create ?? (() => undefined)),
    get: wrap("get", overrides.get ?? (() => ({ time: { updated: DateTime.makeUnsafe(5) } }))),
    prompt: wrap("prompt", overrides.prompt ?? (() => undefined)),
    context: wrap("context", overrides.context ?? (() => [])),
    interrupt: wrap("interrupt", overrides.interrupt ?? (() => undefined)),
  }
  return { calls, host: planningHost({ session } as never) }
}

const SID = Session.ID.create()
const PARENT = Session.ID.create()
const CHILD = Session.ID.create()
const MID = SessionMessage.ID.create()
const notFound = { _tag: "SessionNotFoundError" }
const at = (ms: number) => DateTime.makeUnsafe(ms)

test("create passes the exact id, parent, agent, route and title", async () => {
  const { host, calls } = stub()
  const result = await host.create({
    id: CHILD,
    parentID: PARENT,
    agent: "lazers-planning-grounding",
    model: { providerID: "openrouter", id: "m", variant: "high" },
    directory: "/repo",
    title: "Planning: grounding",
  })
  expect(result).toBe("created")
  expect(calls[0]!.input).toMatchObject({
    id: CHILD,
    parentID: PARENT,
    agent: "lazers-planning-grounding",
    model: { providerID: "openrouter", id: "m", variant: "high" },
    location: { directory: "/repo" },
    title: "Planning: grounding",
    metadata: { lazersPlanningRun: CHILD },
  })
})

test("create without a model leaves the agent's registered route in force", async () => {
  const { host, calls } = stub()
  await host.create({ id: CHILD, parentID: PARENT, agent: "x", directory: "/r", title: "t" })
  expect("model" in calls[0]!.input).toBe(false)
})

test("a create that fails because the session exists returns exists", async () => {
  const { host } = stub({
    create: () => {
      throw new Error("duplicate")
    },
  })
  expect(
    await host.create({ id: CHILD, parentID: PARENT, agent: "x", directory: "/r", title: "t" }),
  ).toBe("exists")
})

test("a create that fails with no such session surfaces the error", async () => {
  const { host } = stub({
    create: () => {
      throw new Error("boom")
    },
    get: () => {
      throw notFound
    },
  })
  await expect(
    host.create({ id: CHILD, parentID: PARENT, agent: "x", directory: "/r", title: "t" }),
  ).rejects.toThrow("boom")
})

test("prompt sends the message id and text to the session", async () => {
  const { host, calls } = stub()
  await host.prompt({ sessionID: SID, messageID: MID, text: "go", directory: "/r" })
  expect(calls[0]).toEqual({ method: "prompt", input: { sessionID: SID, id: MID, text: "go" } })
})

test("observe on a missing session is not found", async () => {
  const { host } = stub({
    get: () => {
      throw notFound
    },
  })
  expect(await host.observe(SID)).toEqual({ found: false })
})

test("observe reads updated, busy, idle and the last outcome", async () => {
  const { host } = stub({
    get: () => ({
      time: { updated: at(30), busy: at(10), idle: at(20) },
      outcome: "succeeded",
    }),
  })
  expect(await host.observe(SID)).toEqual({
    found: true,
    updatedAt: 30,
    busyAt: 10,
    idleAt: 20,
    outcome: "succeeded",
  })
  const fresh = stub()
  expect(await fresh.host.observe(SID)).toEqual({ found: true, updatedAt: 5 })
})

const assistant = (text: string | null, finish: string, input: number, output: number) => ({
  type: "assistant",
  model: { providerID: "p", id: "m" },
  content: text === null ? [{ type: "tool", name: "read" }] : [{ type: "text", text }],
  finish,
  tokens: { input, output, reasoning: 0, cache: { read: 7, write: 0 } },
})

test("reply returns the last assistant text, length finish and summed tokens", async () => {
  const { host } = stub({
    context: () => [
      assistant("old run", "stop", 1000, 1000),
      { type: "user" },
      assistant(null, "tool-calls", 10, 2),
      assistant('{"a":1', "length", 20, 5),
    ],
  })
  expect(await host.reply(SID)).toEqual({
    text: '{"a":1',
    finish: "length",
    inputTokens: 30,
    outputTokens: 7,
    cacheReadTokens: 14,
    model: { providerID: "p", id: "m" },
  })
})

test("reply is undefined while no assistant text exists", async () => {
  const { host } = stub({ context: () => [{ type: "user" }] })
  expect(await host.reply(SID)).toBeUndefined()
})

test("interrupt targets the session", async () => {
  const { host, calls } = stub()
  await host.interrupt(SID)
  expect(calls[0]).toEqual({ method: "interrupt", input: { sessionID: SID } })
})

test("the planning model is the shared route, else the Implementor's, else none", () => {
  const route = (id: string) => ({
    route: { providerID: id, id: "m" },
    scope: "shared" as const,
    revision: 1,
  })
  expect(planningModel((agent) => (agent === "lazers-planning" ? route("a") : route("b")))).toEqual(
    { providerID: "a", id: "m" },
  )
  expect(planningModel((agent) => (agent === "lazers-implementor" ? route("b") : null))).toEqual({
    providerID: "b",
    id: "m",
  })
  expect(planningModel(() => null)).toBeUndefined()
  expect(planningModel()).toBeUndefined()
})
