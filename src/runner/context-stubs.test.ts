import { expect, test } from "bun:test"
import { Message } from "@opencode/ai/effect"
import { Schema } from "effect"
import { Delivery, GuidanceLedger, runbook } from "../guidance/index.ts"
import { FallowAcceptance } from "../audit/contract.ts"
import { divergenceReason } from "./scope.ts"
import { StubHorizons } from "./context-horizon.ts"
import { stubSuperseded } from "./context-stubs.ts"
import { registerArchitectContextStubs } from "./roles.ts"
import { Effect } from "effect"
import {
  bundle,
  call,
  coalesced,
  errorResult,
  measuredSession,
  notice,
  planID,
  result,
  sizeOf,
  taskID,
  textOf,
  user,
  assistantText,
  type Msg,
} from "./context-stubs.fixtures.ts"

const run = (messages: Msg[], horizon: string | undefined) => stubSuperseded(messages, { horizon })
const isStub = (message: Msg) => textOf(message).startsWith("[lz-stub notice")

test("an older notice of a plan is stubbed once a newer one is in the window; the newest stays whole", () => {
  const messages = [
    user("u1", notice("blocked", 1, 1)),
    user("u2", notice("blocked", 2, 1)),
    user("u3", notice("blocked", 1, 2)),
    user("u4", notice("accepted", 1, 3)),
  ]
  const out = run(messages, "u4")
  expect(out.stubbed).toBe(2)
  expect(textOf(out.messages[0]!)).toBe(
    `[lz-stub notice blocked v1, superseded by a newer one: lz-inspect-plan {"planID":"${planID(1)}"}]`,
  )
  expect(textOf(out.messages[1]!)).toBe(textOf(messages[1]!)) // the newest notice of plan 2
  expect(isStub(out.messages[2]!)).toBe(true)
  expect(textOf(out.messages[3]!)).toBe(textOf(messages[3]!)) // the newest of plan 1
  expect(out.saved).toBeGreaterThan(0)
})

test("held kinds are never stubbed; task-accepted is replaced by its task or the plan's closing notice only", () => {
  const messages = [
    user("u1", notice("queue-review", 1, 1)),
    user("u2", notice("retained-verification-failed", 1, 1)),
    user("u3", notice("task-accepted", 1, 1, { taskID: taskID(1) })),
    user("u4", notice("task-accepted", 1, 2, { taskID: taskID(2) })),
    user("u5", notice("blocked", 1, 3)),
    user("u6", notice("queue-review", 1, 4)),
  ]
  // A blocked notice and another queue review do not answer a task-accepted or a held notice.
  expect(run(messages, "u6").stubbed).toBe(0)
  const closed = [...messages, user("u7", notice("task-accepted", 1, 5, { taskID: taskID(1) }))]
  const out = run(closed, "u7")
  expect(isStub(out.messages[2]!)).toBe(true) // same plan and task, newer
  expect(isStub(out.messages[3]!)).toBe(false) // a different task
  expect(isStub(out.messages[4]!)).toBe(true) // blocked, replaced by any later outcome
  const integrated = [...closed, user("u8", notice("integrated", 1, 6))]
  const done = run(integrated, "u8")
  expect(isStub(done.messages[3]!)).toBe(true) // integrated answers every accepted task
  expect(isStub(done.messages[0]!)).toBe(false)
  expect(isStub(done.messages[1]!)).toBe(false)
  expect(isStub(done.messages[5]!)).toBe(false)
})

test("a coalesced notice has only its superseded plan sections stubbed", () => {
  const messages = [
    user(
      "u1",
      coalesced([
        { status: "blocked", plan: 1, version: 1 },
        { status: "blocked", plan: 2, version: 1 },
      ]),
    ),
    user("u2", notice("integrated", 1, 2)),
  ]
  const out = run(messages, "u2")
  const text = textOf(out.messages[0]!)
  expect(text).toContain("LAZERS outcomes · ONS: 2 updates across 2 plans")
  expect(text).toContain("[lz-stub notice blocked v1, superseded by a newer one")
  expect(text).not.toContain(`plan ${planID(1)} ---`)
  expect(text).toContain(`--- plan ${planID(2)} ---`)
  expect(text).toContain(`[lz-notice kind=blocked plan=${planID(2)} v=1]`)
})

test("a newer recovery bundle replaces an older one; the runbook stays while it is the only whole copy", () => {
  const first = bundle(1, 1, true)
  const second = bundle(1, 2) // no worker concern: no concern runbooks in it
  const messages = [user("u1", first), user("u2", second), user("u3", "go on")]
  const out = run(messages, "u3")
  // The recovery-bundle runbook is in both, but worker-concerns and recovery-controls only in the
  // first: it is their only whole copy, so the superseded bundle stays whole.
  expect(textOf(out.messages[0]!)).toBe(textOf(messages[0]!))
  expect(out.stubbed).toBe(0)
  // A third bundle with the concern runbooks makes the first a duplicate.
  const withThird = [...messages, user("u4", bundle(1, 3, true))]
  const next = run(withThird, "u4")
  expect(isStub(next.messages[0]!)).toBe(true)
  expect(isStub(next.messages[1]!)).toBe(true)
  expect(isStub(next.messages[3]!)).toBe(false)
})

const suppression = FallowAcceptance.parse({
  package: {
    verdict: "warn",
    base: "a",
    config: { source: "repo", classesNotChecked: [] },
    thresholds: { cyclomatic: 20, cognitive: 15 },
    findings: [
      {
        id: "f1",
        rule: "added-suppression",
        class: "dead-code",
        severity: "warn",
        attribution: "introduced",
        file: "src/a.ts",
        line: 3,
        message: "suppression added",
        suppression: { kinds: ["unused-export"], reason: "consumed by LZ-1" },
      },
    ],
    summary: { errors: 0, warnings: 1, inherited: 0 },
    timings: { elapsedMs: 1 },
  },
})

test("a runbook's first delivery stays whole while it is the only copy (GuidanceLedger once-per-plan)", () => {
  const ledger = new GuidanceLedger()
  const send = (version: number, delivery: Delivery) =>
    coalesced(
      [
        {
          status: "task-accepted",
          plan: 1,
          version,
          extra: { taskID: taskID(1), fallow: suppression },
        },
      ],
      delivery,
    )
  const firstDelivery = new Delivery("s", ledger)
  const first = send(1, firstDelivery)
  firstDelivery.commit()
  const secondDelivery = new Delivery("s", ledger)
  const second = send(2, secondDelivery)
  secondDelivery.commit()
  expect(first).toContain(runbook("fallow-suppressions"))
  expect(second).not.toContain(runbook("fallow-suppressions")) // a pointer follows
  const messages = [user("u1", first), user("u2", second), user("u3", "ok")]
  const out = run(messages, "u3")
  // The second notice is the newest of its key; the first is the only whole copy of the runbook.
  expect(out.stubbed).toBe(0)
  // After a restart the ledger is empty and a later notice carries the runbook again.
  const third = send(3, new Delivery("s", new GuidanceLedger()))
  const restarted = run([...messages, user("u4", third)], "u4")
  expect(isStub(restarted.messages[0]!)).toBe(true)
  expect(isStub(restarted.messages[1]!)).toBe(true)
  expect(textOf(restarted.messages[3]!)).toBe(third)
})

test("a scope-divergence runbook in an older blocked notice survives a newer notice without it", () => {
  const reason = divergenceReason({
    attemptID: "a",
    created: [],
    missingExpected: [],
    divergences: [{ path: "src/x.ts", status: "modified", added: 1, removed: 0, scopedBy: [] }],
    accepted: [],
    warnings: [],
  })
  const older = notice("blocked", 1, 1, { reason })
  expect(older).toContain(runbook("scope-divergence"))
  const messages = [user("u1", older), user("u2", notice("blocked", 1, 2)), user("u3", "ok")]
  expect(run(messages, "u3").stubbed).toBe(0)
  // A newer divergence notice carries its own copy, so the older one is a duplicate.
  const again = [...messages, user("u4", notice("blocked", 1, 3, { reason }))]
  const out = run(again, "u4")
  expect(isStub(out.messages[0]!)).toBe(true)
  expect(isStub(out.messages[1]!)).toBe(true)
})

test("applying twice is applying once", () => {
  const messages = measuredSession().slice(0, 400)
  const horizon = messages.findLast((m) => m.role === "user")!.id!
  const once = run(messages, horizon)
  expect(once.stubbed).toBeGreaterThan(0)
  const twice = run(once.messages, horizon)
  expect(twice.stubbed).toBe(0)
  expect(JSON.stringify(twice.messages)).toBe(JSON.stringify(once.messages))
})

test("same messages and horizon give identical bytes; a later message changes nothing before the horizon", () => {
  const messages = measuredSession().slice(0, 300)
  const horizon = messages.findLast((m) => m.role === "user")!.id!
  const at = messages.findIndex((m) => m.id === horizon)
  const first = JSON.stringify(run(messages, horizon).messages)
  expect(JSON.stringify(run(messages, horizon).messages)).toBe(first)
  expect(JSON.stringify(run(structuredClone(messages), horizon).messages)).toBe(first)
  // New messages after the horizon, including a newer notice for every plan and a runbook copy.
  const grown = [
    ...messages,
    ...Array.from({ length: 75 }, (_, i) => user(`late${i}`, notice("integrated", i + 1, 99))),
    user("lateRunbook", runbook("recovery-bundle")),
  ]
  const grownOut = run(grown, horizon).messages
  expect(JSON.stringify(grownOut.slice(0, at + 1))).toBe(
    JSON.stringify(run(messages, horizon).messages.slice(0, at + 1)),
  )
  // Past the horizon nothing is rewritten.
  expect(JSON.stringify(grownOut.slice(at + 1))).toBe(JSON.stringify(grown.slice(at + 1)))
})

test("a notice whose newer copy lies beyond the horizon is not stubbed; it is once the horizon passes it", () => {
  const messages = [
    user("u1", notice("blocked", 1, 1)),
    user("u2", notice("blocked", 2, 1)),
    user("u3", notice("blocked", 1, 2)),
  ]
  expect(run(messages, "u2").stubbed).toBe(0)
  expect(run(messages, undefined).stubbed).toBe(0)
  expect(run(messages, "missing").stubbed).toBe(0)
  expect(isStub(run(messages, "u3").messages[0]!)).toBe(true)
})

test("the newest read of a call stays whole; an older one for the same call is stubbed, a different call is not", () => {
  const plan = { planID: planID(1) }
  const body = (n: number) => JSON.stringify({ planID: planID(1), n, text: "z".repeat(900) })
  const messages: Msg[] = [
    user("u1", "go"),
    call("a1", "c1", "lz-inspect-plan", plan),
    result("c1", "lz-inspect-plan", body(1)),
    call("a2", "c2", "lz-inspect-plan", { ...plan, full: true }),
    result("c2", "lz-inspect-plan", body(2)),
    call("a3", "c3", "lz-get-task", { taskID: taskID(1) }),
    result("c3", "lz-get-task", body(3)),
    call("a4", "c4", "lz-inspect-plan", plan),
    result("c4", "lz-inspect-plan", body(4)),
    user("u2", "next"),
  ]
  const out = run(messages, "u2")
  expect(out.stubbed).toBe(1)
  const stubbed = out.messages[2] as {
    content: Array<{ id: string; name: string; result: { type: string; value: string } }>
  }
  expect(stubbed.content[0]!.id).toBe("c1")
  expect(stubbed.content[0]!.name).toBe("lz-inspect-plan")
  expect(stubbed.content[0]!.result.type).toBe("text")
  expect(stubbed.content[0]!.result.value).toBe(
    `[lz-stub earlier lz-inspect-plan result, superseded by a newer read: lz-inspect-plan {"planID":"${planID(1)}"}]`,
  )
  for (const i of [4, 6, 8]) expect(out.messages[i]).toBe(messages[i]!)
  // The calls are untouched, so every result still pairs with its call.
  expect(out.messages[1]).toBe(messages[1]!)
})

test("an error result is never stubbed and does not stand in as the newer read", () => {
  const body = JSON.stringify({ text: "z".repeat(900) })
  const messages: Msg[] = [
    user("u1", "go"),
    call("a1", "c1", "lz-inspect-plan", { planID: planID(1) }),
    result("c1", "lz-inspect-plan", body),
    call("a2", "c2", "lz-inspect-plan", { planID: planID(1) }),
    errorResult("c2", "lz-inspect-plan", "database is locked"),
    user("u2", "next"),
  ]
  expect(run(messages, "u2").stubbed).toBe(0)
})

test("Code Mode: a program calling one read tool is keyed by tool, entity and program shape", () => {
  const code = (id: string, extra = "") =>
    `const p = await tools["lz-inspect-plan"]({ planID: "${id}"${extra} });\nreturn p.state`
  const out1 = "z".repeat(800)
  const messages: Msg[] = [
    user("u1", "go"),
    call("a1", "c1", "execute", { code: code(planID(1)) }),
    result("c1", "execute", out1),
    call("a2", "c2", "execute", { code: code(planID(1), ", full: true") }),
    result("c2", "execute", out1),
    call("a3", "c3", "execute", {
      code: `await tools["lz-inspect-plan"]({planID:"${planID(1)}"}); await tools.read({})`,
    }),
    result("c3", "execute", out1),
    call("a4", "c4", "execute", { code: code(planID(1)) }),
    result("c4", "execute", out1),
    user("u2", "next"),
  ]
  const out = run(messages, "u2")
  expect(out.stubbed).toBe(1)
  const first = out.messages[2] as { content: Array<{ result: { value: string } }> }
  expect(first.content[0]!.result.value).toContain("the lz-inspect-plan call above")
  // The program stays, so the exact call to repeat is still in the conversation.
  expect(out.messages[1]).toBe(messages[1]!)
})

test("a successful submission's input becomes 'stored as' its reference; a failed one keeps its input", () => {
  const spec = { idempotencyKey: "key-1", objective: "y".repeat(3000), writeScope: ["src/**"] }
  const receipt = JSON.stringify({
    status: "submitted",
    taskID: taskID(1),
    reference: "ONS-9",
    revision: 1,
  })
  const plan = { requestID: "plan-1", objective: "p".repeat(3000), nodes: [] }
  const messages: Msg[] = [
    user("u1", "go"),
    call("a1", "c1", "lz-submit-task", spec),
    result("c1", "lz-submit-task", receipt),
    call("a2", "c2", "lz-submit-plan", plan),
    result(
      "c2",
      "lz-submit-plan",
      JSON.stringify({ status: "submitted", planID: planID(5), version: 1, admitted: true }),
    ),
    call("a3", "c3", "lz-submit-task", { ...spec, idempotencyKey: "key-2" }),
    errorResult("c3", "lz-submit-task", "Invalid input"),
    call("a4", "c4", "lz-submit-task", { ...spec, idempotencyKey: "key-3" }),
    result("c4", "lz-submit-task", JSON.stringify({ status: "invalid", fields: ["x"] })),
    user("u2", "next"),
  ]
  const out = run(messages, "u2")
  expect(out.stubbed).toBe(2)
  const task = out.messages[1] as {
    content: Array<{ id: string; name: string; input: Record<string, unknown> }>
  }
  expect(task.content[0]!.id).toBe("c1")
  expect(task.content[0]!.name).toBe("lz-submit-task")
  expect(task.content[0]!.input).toEqual({
    idempotencyKey: "key-1",
    "lz-stub": `lz-submit-task input elided: stored as task ONS-9 (${taskID(1)}); read it back with lz-get-task {"taskID":"${taskID(1)}"}`,
  })
  // The wire format needs an object that survives JSON round trips.
  expect(JSON.parse(JSON.stringify(task.content[0]!.input))).toEqual(task.content[0]!.input)
  const planCall = out.messages[3] as { content: Array<{ input: Record<string, unknown> }> }
  expect(planCall.content[0]!.input.requestID).toBe("plan-1")
  expect(String(planCall.content[0]!.input["lz-stub"])).toContain(`stored as plan ${planID(5)} v1`)
  expect(out.messages[5]).toBe(messages[5]!)
  expect(out.messages[7]).toBe(messages[7]!)
})

test("Code Mode submission: the program becomes a comment naming the reference", () => {
  const code = `return await tools["lz-submit-task"](${JSON.stringify({ idempotencyKey: "k", objective: "y".repeat(2000) })})`
  const messages: Msg[] = [
    user("u1", "go"),
    call("a1", "c1", "execute", { code }),
    result(
      "c1",
      "execute",
      JSON.stringify({ status: "submitted", taskID: taskID(1), reference: "ONS-9" }),
    ),
    user("u2", "next"),
  ]
  const out = run(messages, "u2")
  const part = (out.messages[1] as { content: Array<{ id: string; input: { code: string } }> })
    .content[0]!
  expect(part.id).toBe("c1")
  expect(
    part.input.code.startsWith("// [lz-stub] lz-submit-task input elided: stored as task ONS-9"),
  ).toBe(true)
  expect(part.input.code).not.toContain("\n")
  // A program that also touches other tools, or returns something that is not a receipt, is left alone.
  const mixed = [
    messages[0]!,
    call("a1", "c1", "execute", { code: `${code}; await tools.read({})` }),
    messages[2]!,
    messages[3]!,
  ]
  expect(run(mixed, "u2").stubbed).toBe(0)
})

test("a stub is never longer than what it replaces", () => {
  const messages = [
    user("u1", notice("blocked", 1, 1).slice(0, 40)),
    user("u2", notice("blocked", 1, 2)),
    user("u3", "x"),
  ]
  // No marker line survives a cut, so there is nothing to stub; and a tiny result stays whole.
  expect(run(messages, "u3").stubbed).toBe(0)
  const small: Msg[] = [
    user("u1", "go"),
    call("a1", "c1", "lz-get-task", { taskID: taskID(1) }),
    result("c1", "lz-get-task", "ok"),
    call("a2", "c2", "lz-get-task", { taskID: taskID(1) }),
    result("c2", "lz-get-task", "ok"),
    user("u2", "x"),
  ]
  expect(run(small, "u2").stubbed).toBe(0)
})

test("class-built messages keep their class and fields; tool-call and result ids still pair", () => {
  const big = JSON.stringify({ text: "z".repeat(900) })
  const messages = [
    Message.make({ id: "u1", role: "user", content: notice("blocked", 1, 1) }),
    Message.make({ id: "u2", role: "user", content: notice("blocked", 1, 2) }),
    Message.make({
      id: "a1",
      role: "assistant",
      content: [
        { type: "tool-call", id: "c1", name: "lz-inspect-plan", input: { planID: planID(1) } },
      ],
    }),
    Message.tool({
      id: "c1",
      name: "lz-inspect-plan",
      result: { type: "text" as const, value: big },
    }),
    Message.make({
      id: "a2",
      role: "assistant",
      content: [
        { type: "tool-call", id: "c2", name: "lz-inspect-plan", input: { planID: planID(1) } },
      ],
    }),
    Message.tool({
      id: "c2",
      name: "lz-inspect-plan",
      result: { type: "text" as const, value: big },
    }),
    Message.make({ id: "u3", role: "user", content: "next" }),
  ]
  const out = stubSuperseded(messages, { horizon: "u3" })
  expect(out.stubbed).toBe(2)
  for (const message of out.messages) expect(Schema.is(Message)(message)).toBe(true)
  expect(Object.getPrototypeOf(out.messages[0]!)).toBe(Object.getPrototypeOf(messages[0]!))
  expect(out.messages[0]!.id).toBe("u1")
  expect(out.messages[3]!.role).toBe("tool")
  const ids = out.messages.flatMap((m) => (m.role === "tool" ? m.content.map((p) => p.id) : []))
  expect(ids).toEqual(["c1", "c2"])
  // The inputs given are not modified.
  expect(JSON.stringify(messages[3])).toContain("zzzz")
})

test("the horizon advances on first sight, a cold gap and compaction, and holds between", () => {
  let now = 1_000_000
  const horizons = new StubHorizons(300_000, () => now)
  const turn = (n: number): Msg[] => [
    user("u0", "a"),
    assistantText("a0", "b"),
    ...Array.from({ length: n }, (_, i) => user(`u${i + 1}`, "x")),
  ]
  expect(horizons.horizonFor("s", turn(1))).toEqual({ horizon: "u1", advanced: "first-request" })
  now += 60_000
  // Warm: more messages arrive, the horizon does not move.
  expect(horizons.horizonFor("s", turn(3))).toEqual({ horizon: "u1", advanced: undefined })
  now += 299_000
  expect(horizons.horizonFor("s", turn(4)).advanced).toBeUndefined()
  // A gap longer than the cache window advances it to the newest turn start.
  now += 300_001
  expect(horizons.horizonFor("s", turn(5))).toEqual({ horizon: "u5", advanced: "cache-cold" })
  // Compaction: the old first message and horizon are gone.
  now += 1_000
  const compacted = [user("ck", "<conversation-checkpoint>"), user("u5", "x"), user("u6", "y")]
  expect(horizons.horizonFor("s", compacted)).toEqual({ horizon: "u6", advanced: "prefix-changed" })
  // Another session is independent, and starts with its own advance.
  expect(horizons.horizonFor("t", turn(2)).advanced).toBe("first-request")
})

test("the turn in progress is never inside the window", () => {
  const messages: Msg[] = [
    user("u1", notice("blocked", 1, 1)),
    user("u2", notice("blocked", 1, 2)),
    call("a1", "c1", "lz-submit-task", { idempotencyKey: "k", objective: "y".repeat(3000) }),
    result(
      "c1",
      "lz-submit-task",
      JSON.stringify({ status: "submitted", taskID: taskID(1), reference: "ONS-1" }),
    ),
  ]
  const horizons = new StubHorizons(300_000, () => 0)
  const { horizon } = horizons.horizonFor("s", messages)
  expect(horizon).toBe("u2")
  const out = run(messages, horizon)
  expect(isStub(out.messages[0]!)).toBe(true)
  expect(out.messages[2]).toBe(messages[2]!)
})

// The hook ---------------------------------------------------------------------------------------

type ContextEvent = { agent: string; sessionID: string; messages: Msg[] }

function hooked(options: Parameters<typeof registerArchitectContextStubs>[1] = {}) {
  let handler: ((event: ContextEvent) => Effect.Effect<void>) | undefined
  const ctx = {
    session: {
      hook: (name: string, callback: (event: ContextEvent) => Effect.Effect<void>) => {
        if (name === "context") handler = callback
        return Effect.void
      },
    },
  }
  Effect.runSync(Effect.scoped(registerArchitectContextStubs(ctx as never, options)))
  return (event: ContextEvent) => Effect.runSync(handler!(event))
}

test("the Architect's request is stubbed in place; a worker's request is untouched", () => {
  const send = hooked()
  const make = (agent: string): ContextEvent => ({
    agent,
    sessionID: agent,
    messages: [
      user("u1", notice("blocked", 1, 1)),
      user("u2", notice("blocked", 1, 2)),
      user("u3", "go"),
    ],
  })
  const architect = make("architect")
  const array = architect.messages
  send(architect)
  expect(architect.messages).toBe(array)
  expect(isStub(architect.messages[0]!)).toBe(true)
  const worker = make("lazers-implementor")
  const before = JSON.stringify(worker.messages)
  send(worker)
  expect(JSON.stringify(worker.messages)).toBe(before)
})

test("a failure leaves the messages untouched, is logged once, and never throws", () => {
  const logs: string[] = []
  const send = hooked({ log: (message) => logs.push(message) })
  const broken = {
    agent: "architect",
    sessionID: "s",
    get messages(): Msg[] {
      throw new Error("boom")
    },
  } as unknown as ContextEvent
  expect(() => send(broken)).not.toThrow()
  expect(() => send(broken)).not.toThrow()
  expect(logs).toHaveLength(1)
  // Malformed content (a part that is not an object) is handled too.
  const odd: ContextEvent = {
    agent: "architect",
    sessionID: "s2",
    messages: [{ id: "u1", role: "user", content: [null, 3, "x"] }, user("u2", "go")],
  }
  const before = JSON.stringify(odd.messages)
  expect(() => send(odd)).not.toThrow()
  expect(JSON.stringify(odd.messages)).toBe(before)
})

test("synthetic session shaped like the measured one: 551 notices over 75 plans", () => {
  const messages = measuredSession()
  const notices = messages.filter((m) => textOf(m).startsWith("LAZERS outcome"))
  expect(notices).toHaveLength(551)
  expect(new Set(notices.map((m) => textOf(m).match(/plan=([0-9a-f-]+)/)![1])).size).toBe(75)
  const horizon = messages.findLast((m) => m.role === "user")!.id!
  const out = run(messages, horizon)
  const stubs = out.messages.filter(isStub).length
  expect(stubs).toBeGreaterThan(300)
  expect(sizeOf(out.messages)).toBeLessThan(sizeOf(messages))
})
