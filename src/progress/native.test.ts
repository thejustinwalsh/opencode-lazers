import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect, Fiber, Queue, Stream } from "effect"
import { firstAttemptID, makeFixture, secondAttemptID } from "../../test/trajectory/fixture.ts"
import { nativeLivenessFixture } from "../../test/runner-native-liveness/fixture.ts"
import { ProgressRecorder } from "./recorder.ts"
import { registerProgress } from "./native.ts"

type RegisteredTool = Parameters<ToolEditor["add"]>[0]

function callContext(sessionID: string, callID: string): Parameters<RegisteredTool["execute"]>[1] {
  return {
    sessionID: Session.ID.make(sessionID),
    agent: Agent.ID.make("lazers-implementor"),
    messageID: SessionMessage.ID.make("msg_worker_call"),
    id: Tool.CallID.make(callID),
    progress: () => Effect.void,
  }
}

function makeContext(
  fixture: ReturnType<typeof makeFixture>,
  options: {
    denied?: boolean
    events?: unknown[]
    holdEvents?: boolean
    liveEvents?: boolean
    eventFailure?: boolean
    messages?: unknown[]
    readContext?: () => Effect.Effect<unknown[]>
    synthetic?: (input: unknown) => Effect.Effect<unknown, unknown, never>
  } = {},
) {
  const tools = new Map<string, RegisteredTool>()
  const editor: ToolEditor = {
    add: (tool) => tools.set(tool.name, tool),
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    update: () => {},
    remove: () => {},
  }
  let afterHook: ((call: never) => Effect.Effect<void>) | undefined
  let idleHook: ((idle: never) => Effect.Effect<void>) | undefined
  let syntheticCalls = 0
  const eventQueue = Effect.runSync(Queue.unbounded<unknown>())
  const streamFailure = Symbol("fixture-stream-failure")
  const syntheticInputs: unknown[] = []
  const context = {
    permission: {
      assert: () => (options.denied ? Effect.fail(new Error("permission denied")) : Effect.void),
    },
    tool: {
      transform: (transform: (editor: ToolEditor) => void) =>
        Effect.sync(() => {
          transform(editor)
          return { dispose: Effect.void }
        }),
      hook: (name: string, callback: (call: never) => Effect.Effect<void>) => {
        if (name === "execute.after") afterHook = callback
        return Effect.succeed({ dispose: Effect.void })
      },
    },
    session: {
      hook: (name: string, callback: (idle: never) => Effect.Effect<void>) => {
        if (name === "experimental.idle") idleHook = callback
        return Effect.succeed({ dispose: Effect.void })
      },
      get: () =>
        Effect.succeed({
          id: "ses-accepted",
          projectID: "project",
          agent: "lazers-implementor",
          location: { directory: fixture.directory },
        }),
      context: () => options.readContext?.() ?? Effect.succeed(options.messages ?? []),
      synthetic: (input: unknown) => {
        syntheticCalls++
        syntheticInputs.push(input)
        return options.synthetic?.(input) ?? Effect.succeed({ id: (input as { id?: unknown }).id })
      },
    },
    event: {
      subscribe: () =>
        options.eventFailure
          ? Stream.fail(new Error("fixture event stream unavailable"))
          : options.liveEvents
            ? Stream.fromQueue(eventQueue).pipe(
                Stream.mapEffect((event) =>
                  event === streamFailure
                    ? Effect.fail(new Error("fixture stream lost"))
                    : Effect.succeed(event),
                ),
              )
            : options.holdEvents
              ? Stream.never
              : Stream.fromIterable(options.events ?? []),
    },
  } as unknown as Plugin.Context
  return {
    context,
    tools,
    after: () => afterHook,
    idle: () => idleHook,
    syntheticCalls: () => syntheticCalls,
    syntheticInputs: () => syntheticInputs,
    emitEvent: (event: unknown) => Effect.runPromise(Queue.offer(eventQueue, event)),
    failEvents: () => Effect.runPromise(Queue.offer(eventQueue, streamFailure)),
  }
}

function executionEvent(type: string, sessionID: string, sequence: number) {
  return {
    id: `event-${sequence}`,
    created: sequence,
    type,
    durable: { aggregateID: sessionID, seq: sequence, version: 1 },
    data: { sessionID },
  }
}

async function waitForNativeState(predicate: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Native progress event was not observed in time")
}

function toolEvent(type: string, eventID: string, callID: string) {
  return {
    id: eventID,
    type,
    created: type.endsWith("called") ? 100 : 110,
    data: {
      sessionID: "ses-accepted",
      assistantMessageID: "msg_worker_call",
      id: callID,
      executed: true,
      ...(type.endsWith("success")
        ? { content: [{ type: "text", text: "Progress recorded" }] }
        : { input: { message: "Never persist tool input" } }),
    },
  }
}

test("registered report tool, hook, native events, and recovery share one recorder", async () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(secondAttemptID),
    )
    const callID = "report-call-1"
    const ctx = makeContext(fixture, {
      events: [
        toolEvent("session.tool.called", "native-call", callID),
        toolEvent("session.tool.success", "native-success", callID),
      ],
      messages: [
        {
          id: "msg-worker-call",
          type: "assistant",
          time: { created: 90 },
          content: [
            {
              type: "tool",
              id: callID,
              name: "lazers_report_progress",
              state: {
                status: "completed",
                input: { message: "private model input field" },
                content: [{ type: "text", text: "Progress recorded" }],
              },
            },
          ],
        },
      ],
    })
    const recorder = new ProgressRecorder(fixture.store, "project")
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(ctx.context, recorder, "project")
          const report = ctx.tools.get("lazers_report_progress")!
          expect(report.options).toMatchObject({
            codemode: true,
            permission: "lazers_report_progress",
          })
          const result = yield* report.execute(
            { message: "Implemented and verified; committed changes are ready." },
            callContext("ses-accepted", callID),
          )
          expect(result.output).toMatchObject({ sequence: expect.any(Number) })
          yield* ctx.after()!({
            tool: "lazers_report_progress",
            sessionID: "ses-accepted",
            agent: "lazers-implementor",
            messageID: "msg_worker_call",
            id: callID,
            input: { message: "must not be captured as a tool input" },
            status: "completed",
            result: { content: [{ type: "text", text: "Progress recorded" }] },
          } as never)
          yield* Effect.sleep(25)
        }),
      ),
    )
    recorder.reconcileMessages("ses-accepted", [
      {
        id: "msg_worker_call",
        type: "assistant",
        time: { created: 90 },
        content: [
          {
            type: "tool",
            id: callID,
            name: "lazers_report_progress",
            state: {
              status: "completed",
              input: { message: "private model input field" },
              content: [{ type: "text", text: "Progress recorded" }],
            },
          },
        ],
      },
    ])
    const rows = fixture.store.progressFacts([secondAttemptID])
    const comment = rows.find((row) => row.call_id === callID)!
    expect(comment.kind).toBe("commentary")
    expect(JSON.parse(comment.payload).text).toBe(
      "Implemented and verified; committed changes are ready.",
    )
    expect(JSON.parse(comment.sources_json)).toEqual(
      expect.arrayContaining(["tool-commentary", "native-event", "recovery"]),
    )
    expect(rows.filter((row) => row.call_id === callID)).toHaveLength(1)
    expect(comment.payload).not.toContain("private model input field")
    expect(comment.payload).not.toContain("must not be captured as a tool input")
    expect(comment.payload).not.toContain("token fields")
  } finally {
    fixture.close()
  }
})

test("native permission denial and forged or foreign reports perform no writes", async () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(secondAttemptID),
    )
    const recorder = new ProgressRecorder(fixture.store, "project")
    const denied = makeContext(fixture, { denied: true })
    await Effect.runPromise(Effect.scoped(registerProgress(denied.context, recorder, "project")))
    const tool = denied.tools.get("lazers_report_progress")!
    await expect(
      Effect.runPromise(
        tool.execute({ message: "permission denied" }, callContext("ses-accepted", "denied-call")),
      ),
    ).rejects.toThrow("permission denied")
    expect(fixture.store.progressFacts([secondAttemptID])).toEqual([])

    const allowed = makeContext(fixture)
    await Effect.runPromise(Effect.scoped(registerProgress(allowed.context, recorder, "project")))
    const allowedTool = allowed.tools.get("lazers_report_progress")!
    await expect(
      Effect.runPromise(
        allowedTool.execute(
          { message: "forged", taskID: fixture.task.id },
          callContext("ses-accepted", "forged-input"),
        ),
      ),
    ).rejects.toThrow()
    await expect(
      Effect.runPromise(
        allowedTool.execute(
          { message: "foreign" },
          callContext("ses-not-assigned", "foreign-call"),
        ),
      ),
    ).rejects.toThrow("active assigned worker")
    expect(fixture.store.progressFacts([secondAttemptID])).toEqual([])
  } finally {
    fixture.close()
  }
})

test("idle handoff reminder is concise, persisted, and sent at most once per attempt", async () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(secondAttemptID),
    )
    const recorder = new ProgressRecorder(fixture.store, "project")
    const ctx = makeContext(fixture)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(ctx.context, recorder, "project")
          const idle = ctx.idle()!
          yield* idle({ sessionID: Session.ID.make("ses-accepted"), background: [] } as never)
          yield* idle({ sessionID: Session.ID.make("ses-accepted"), background: [] } as never)
        }),
      ),
    )
    expect(ctx.syntheticCalls()).toBe(1)
    const reminder = fixture.store
      .progressFacts([secondAttemptID])
      .find((row) => row.kind === "reminder")
    expect(reminder).toBeDefined()
    expect(JSON.parse(reminder!.payload).delivery).toBe("admitted")
    expect(JSON.parse(reminder!.payload).text).toContain("only any remaining concise handoff")
    const sent = ctx.syntheticInputs()[0] as Record<string, unknown>
    expect(sent.id).toBe(JSON.parse(reminder!.payload).nativeMessageID)
    expect(sent.delivery).toBe("steer")
    expect(sent.metadata).toMatchObject({
      lazersKind: "worker-progress-reminder",
      lazersAttemptID: secondAttemptID,
      lazersSessionID: "ses-accepted",
      lazersMessageID: sent.id,
    })
  } finally {
    fixture.close()
  }
})

test("independent listeners preserve each other while own loss and disposal invalidate observations", async () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const messages = [
      { id: "msg_current", type: "user" },
      {
        id: "msg_reply",
        type: "assistant",
        finish: "stop",
        content: [{ type: "text", text: "Completed." }],
      },
    ]
    const first = makeContext(fixture, { liveEvents: true, messages })
    const second = makeContext(fixture, { liveEvents: true, messages })
    const firstNative = nativeLivenessFixture({
      sessionID: "ses-accepted",
      directory: fixture.directory,
    })
    const secondNative = nativeLivenessFixture({
      sessionID: "ses_other_location",
      directory: fixture.directory,
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(first.context, recorder, "project")
          yield* Effect.promise(() =>
            first.emitEvent(executionEvent("session.execution.started", "ses-accepted", 10)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(
              async () =>
                (await firstNative.host.session("ses-accepted"))?.background?.state === "unknown",
            ),
          )
          yield* Effect.sleep(5)
          yield* first.idle()!({ sessionID: "ses-accepted", background: [] } as never)
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* registerProgress(second.context, recorder, "other-project")
              expect(
                (yield* Effect.promise(() => firstNative.host.session("ses-accepted")))?.background
                  ?.state,
              ).toBe("observed")
              yield* Effect.promise(() =>
                second.emitEvent(
                  executionEvent("session.execution.started", "ses_other_location", 20),
                ),
              )
              yield* Effect.sleep(5)
              yield* second.idle()!({ sessionID: "ses_other_location", background: [] } as never)
              expect(
                (yield* Effect.promise(() => secondNative.host.session("ses_other_location")))
                  ?.background?.state,
              ).toBe("observed")
              yield* Effect.promise(() => second.failEvents())
              yield* Effect.promise(() =>
                waitForNativeState(
                  async () =>
                    (await secondNative.host.session("ses_other_location"))?.background?.state ===
                    "unknown",
                ),
              )
              expect(
                (yield* Effect.promise(() => firstNative.host.session("ses-accepted")))?.background
                  ?.state,
              ).toBe("observed")
            }),
          )
          expect(
            (yield* Effect.promise(() => firstNative.host.session("ses-accepted")))?.background
              ?.state,
          ).toBe("observed")
          yield* Effect.promise(() => first.failEvents())
          yield* Effect.promise(() =>
            waitForNativeState(
              async () =>
                (await firstNative.host.session("ses-accepted"))?.background?.state === "unknown",
            ),
          )
          yield* first.idle()!({ sessionID: "ses-accepted", background: [] } as never)
          expect(
            (yield* Effect.promise(() => firstNative.host.session("ses-accepted")))?.background
              ?.state,
          ).toBe("unknown")
          yield* Effect.promise(() =>
            first.emitEvent(executionEvent("session.execution.started", "ses-accepted", 30)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(async () => {
              const background = (await firstNative.host.session("ses-accepted"))?.background
              return (
                background?.state === "unknown" &&
                background.reason.includes("foreground execution started")
              )
            }),
          )
          yield* first.idle()!({ sessionID: "ses-accepted", background: [] } as never)
          expect(
            (yield* Effect.promise(() => firstNative.host.session("ses-accepted")))?.background
              ?.state,
          ).toBe("observed")
        }),
      ),
    )
    expect((await firstNative.host.session("ses-accepted"))?.background).toMatchObject({
      state: "unknown",
      reason: "Native idle hook listener was disposed",
    })
  } finally {
    fixture.close()
  }
})

test.each(["msg_initial", "msg_resumed"])(
  "same-process listener replacement accepts only a fresh idle report for %s",
  async (inputID) => {
    const fixture = makeFixture()
    try {
      const recorder = new ProgressRecorder(fixture.store, "project")
      const messages = [
        { id: inputID, type: "user" },
        { id: "msg_reply", type: "assistant", content: [{ type: "text", text: "Completed." }] },
      ]
      const old = makeContext(fixture, { liveEvents: true, messages })
      const next = makeContext(fixture, { liveEvents: true, messages })
      const native = nativeLivenessFixture({
        sessionID: "ses-accepted",
        directory: fixture.directory,
      })
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* registerProgress(old.context, recorder, "project")
            yield* Effect.promise(() =>
              old.emitEvent(executionEvent("session.execution.started", "ses-accepted", 20)),
            )
            yield* Effect.promise(() =>
              waitForNativeState(
                async () =>
                  (await native.host.session("ses-accepted"))?.background?.state === "unknown",
              ),
            )
            yield* Effect.sleep(5)
          }),
        ),
      )
      expect((await native.host.session("ses-accepted"))?.background?.state).toBe("unknown")
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* registerProgress(next.context, recorder, "project")
            // No new busy period or replayed start: replacement happens inside the existing execution.
            yield* next.idle()!({ sessionID: "ses-accepted", background: [] } as never)
            expect(
              (yield* Effect.promise(() => native.host.session("ses-accepted")))?.background,
            ).toMatchObject({
              state: "observed",
              inputID,
              executionStartSequence: 20,
            })
            yield* Effect.promise(() =>
              next.emitEvent(executionEvent("session.execution.succeeded", "ses-accepted", 21)),
            )
            yield* Effect.promise(() =>
              waitForNativeState(async () => {
                const background = (await native.host.session("ses-accepted"))?.background
                return background?.state === "observed" && background.terminalSequence === 21
              }),
            )
          }),
        ),
      )
      expect(next.syntheticCalls()).toBe(0)
    } finally {
      fixture.close()
    }
  },
)

test.each(["idle", "success-input-changed", "success-owned"])(
  "a suspended %s callback and old observer disposal preserve a newer same-session report",
  async (stage) => {
    const fixture = makeFixture()
    try {
      const recorder = new ProgressRecorder(fixture.store, "project")
      const oldMessages: unknown[] = [
        { id: "msg_old_input", type: "user" },
        {
          id: "msg_old_reply",
          type: "assistant",
          finish: "stop",
          content: [{ type: "text", text: "Completed." }],
        },
      ]
      const newMessages: unknown[] = [
        { id: "msg_new_input", type: "user" },
        {
          id: "msg_new_reply",
          type: "assistant",
          finish: "stop",
          content: [{ type: "text", text: "Completed." }],
        },
      ]
      const entered = Promise.withResolvers<void>()
      const released = Promise.withResolvers<unknown[]>()
      const ready = Promise.withResolvers<void>()
      const terminalProcessed = Promise.withResolvers<void>()
      let suspend = false
      const old = makeContext(fixture, {
        liveEvents: true,
        messages: oldMessages,
        readContext: () => {
          if (!suspend) return Effect.succeed(oldMessages)
          suspend = false
          return Effect.promise(() => {
            entered.resolve()
            return released.promise
          })
        },
      })
      const next = makeContext(fixture, { liveEvents: true, messages: newMessages })
      const native = nativeLivenessFixture({
        sessionID: "ses-accepted",
        directory: fixture.directory,
      })
      const record = recorder.recordNativeEvent.bind(recorder)
      recorder.recordNativeEvent = (event) => {
        const result = record(event)
        if ((event as { id?: string }).id === "event-21") terminalProcessed.resolve()
        return result
      }
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const oldFiber = yield* Effect.forkScoped(
              Effect.scoped(
                Effect.gen(function* () {
                  yield* registerProgress(old.context, recorder, "project")
                  ready.resolve()
                  yield* Effect.never
                }),
              ),
            )
            yield* Effect.promise(() => ready.promise)
            yield* Effect.promise(() =>
              old.emitEvent(executionEvent("session.execution.started", "ses-accepted", 20)),
            )
            yield* Effect.promise(() =>
              waitForNativeState(async () => {
                const background = (await native.host.session("ses-accepted"))?.background
                return (
                  background?.state === "unknown" &&
                  background.reason.includes("foreground execution started")
                )
              }),
            )
            if (stage !== "idle")
              yield* old.idle()!({ sessionID: "ses-accepted", background: [] } as never)
            suspend = true
            const idleFiber =
              stage === "idle"
                ? yield* Effect.forkScoped(
                    old.idle()!({ sessionID: "ses-accepted", background: [] } as never),
                  )
                : undefined
            if (stage !== "idle")
              yield* Effect.promise(() =>
                old.emitEvent(executionEvent("session.execution.succeeded", "ses-accepted", 21)),
              )
            yield* Effect.promise(() => entered.promise)
            yield* registerProgress(next.context, recorder, "project")
            yield* Effect.promise(() =>
              next.emitEvent(executionEvent("session.execution.started", "ses-accepted", 40)),
            )
            yield* Effect.sleep(5)
            yield* next.idle()!({ sessionID: "ses-accepted", background: [] } as never)
            expect(
              (yield* Effect.promise(() => native.host.session("ses-accepted")))?.background,
            ).toMatchObject({
              state: "observed",
              inputID: "msg_new_input",
              executionStartSequence: 40,
            })
            released.resolve(stage === "success-input-changed" ? newMessages : oldMessages)
            if (idleFiber) yield* Fiber.join(idleFiber)
            else yield* Effect.promise(() => terminalProcessed.promise)
            expect(
              (yield* Effect.promise(() => native.host.session("ses-accepted")))?.background,
            ).toMatchObject({
              state: "observed",
              inputID: "msg_new_input",
              executionStartSequence: 40,
            })
            yield* Fiber.interrupt(oldFiber)
            expect(
              (yield* Effect.promise(() => native.host.session("ses-accepted")))?.background,
            ).toMatchObject({
              state: "observed",
              inputID: "msg_new_input",
              executionStartSequence: 40,
            })
            yield* Effect.promise(() => next.failEvents())
            yield* Effect.promise(() =>
              waitForNativeState(
                async () =>
                  (await native.host.session("ses-accepted"))?.background?.state === "unknown",
              ),
            )
          }),
        ),
      )
    } finally {
      fixture.close()
    }
  },
)

test.each([
  "session.shell.started",
  "session.execution.started",
  "session.inbox.enqueued",
  "session.execution.failed",
])("queued older %s cannot replace another listener's newer report", async (type) => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const messages = [
      { id: "msg_current", type: "user" },
      {
        id: "msg_reply",
        type: "assistant",
        finish: "stop",
        content: [{ type: "text", text: "Completed." }],
      },
    ]
    const old = makeContext(fixture, { liveEvents: true, messages })
    const next = makeContext(fixture, { liveEvents: true, messages })
    const native = nativeLivenessFixture({
      sessionID: "ses-accepted",
      directory: fixture.directory,
    })
    const processed = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>()
    const record = recorder.recordNativeEvent.bind(recorder)
    recorder.recordNativeEvent = (event) => {
      const result = record(event)
      const sequence = (event as { durable?: { seq?: number } }).durable?.seq
      if (sequence !== undefined) processed.get(sequence)?.resolve()
      return result
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(old.context, recorder, "project")
          yield* registerProgress(next.context, recorder, "project")
          for (const [context, sequence] of [
            [old, 20],
            [next, 40],
          ] as const) {
            const done = Promise.withResolvers<void>()
            processed.set(sequence, done)
            yield* Effect.promise(() =>
              context.emitEvent(
                executionEvent("session.execution.started", "ses-accepted", sequence),
              ),
            )
            yield* Effect.promise(() => done.promise)
            yield* context.idle()!({ sessionID: "ses-accepted", background: [] } as never)
          }
          expect(
            (yield* Effect.promise(() => native.host.session("ses-accepted")))?.background,
          ).toMatchObject({ state: "observed", executionStartSequence: 40 })
          const stale = Promise.withResolvers<void>()
          processed.set(22, stale)
          yield* Effect.promise(() => old.emitEvent(executionEvent(type, "ses-accepted", 22)))
          yield* Effect.promise(() => stale.promise)
          expect(
            (yield* Effect.promise(() => native.host.session("ses-accepted")))?.background,
          ).toMatchObject({ state: "observed", executionStartSequence: 40 })
          const fresh = Promise.withResolvers<void>()
          processed.set(42, fresh)
          yield* Effect.promise(() =>
            old.emitEvent(executionEvent("session.execution.started", "ses-accepted", 42)),
          )
          yield* Effect.promise(() => fresh.promise)
          expect(
            (yield* Effect.promise(() => native.host.session("ses-accepted")))?.background?.state,
          ).toBe("unknown")
        }),
      ),
    )
  } finally {
    fixture.close()
  }
})

test("registered native idle order preserves matching success and ignores delayed older terminal events", async () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(secondAttemptID),
    )
    const recorder = new ProgressRecorder(fixture.store, "project")
    const sessionID = "ses-accepted"
    const messages: unknown[] = [
      { id: "msg_turn_old", type: "user" },
      {
        id: "msg_handoff_old",
        type: "assistant",
        finish: "stop",
        content: [{ type: "text", text: "The original turn completed." }],
      },
    ]
    const ctx = makeContext(fixture, { liveEvents: true, messages })
    const native = nativeLivenessFixture({ sessionID, directory: fixture.directory })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(ctx.context, recorder, "project")
          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.execution.started", sessionID, 20)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(async () => {
              const background = (await native.host.session(sessionID))?.background
              return (
                background?.state === "unknown" &&
                background.reason.includes("foreground execution started")
              )
            }),
          )
          yield* ctx.idle()!({
            sessionID: Session.ID.make(sessionID),
            background: [],
          } as never)
          yield* Effect.sleep(5)
          const firstIdle = yield* Effect.promise(() => native.host.session(sessionID))
          expect(firstIdle?.background).toMatchObject({
            state: "observed",
            inputID: "msg_turn_old",
            executionStartSequence: 20,
            eventSequence: 20,
            count: 0,
          })

          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.execution.succeeded", sessionID, 21)),
          )
          yield* Effect.sleep(5)
          const firstSuccess = yield* Effect.promise(() => native.host.session(sessionID))
          expect(firstSuccess?.background).toMatchObject({
            state: "observed",
            inputID: "msg_turn_old",
            executionStartSequence: 20,
            eventSequence: 20,
            terminalSequence: 21,
            count: 0,
          })

          messages.push(
            { id: "msg_turn_new", type: "synthetic" },
            {
              id: "msg_handoff_new",
              type: "assistant",
              finish: "stop",
              content: [{ type: "text", text: "The newer turn completed." }],
            },
          )
          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.execution.started", sessionID, 22)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(async () => {
              const background = (await native.host.session(sessionID))?.background
              return (
                background?.state === "unknown" &&
                background.reason.includes("foreground execution started")
              )
            }),
          )
          yield* ctx.idle()!({
            sessionID: Session.ID.make(sessionID),
            background: [],
          } as never)
          yield* Effect.sleep(5)
          const secondIdle = yield* Effect.promise(() => native.host.session(sessionID))
          expect(secondIdle?.background).toMatchObject({
            state: "observed",
            inputID: "msg_turn_new",
            executionStartSequence: 22,
            eventSequence: 22,
            count: 0,
          })

          // Event sequence 21 belongs to the earlier execution, despite arriving late.
          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.execution.succeeded", sessionID, 21)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(async () => {
              const background = (await native.host.session(sessionID))?.background
              return background?.state === "observed" && background.staleEventSequence === 21
            }),
          )
          const afterDelayedSuccess = yield* Effect.promise(() => native.host.session(sessionID))
          expect(afterDelayedSuccess?.background).toMatchObject({
            state: "observed",
            inputID: "msg_turn_new",
            executionStartSequence: 22,
            eventSequence: 22,
            count: 0,
          })

          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.execution.succeeded", sessionID, 23)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(async () => {
              const background = (await native.host.session(sessionID))?.background
              return background?.state === "observed" && background.terminalSequence === 23
            }),
          )
          const afterCurrentSuccess = yield* Effect.promise(() => native.host.session(sessionID))
          expect(afterCurrentSuccess?.background).toMatchObject({
            state: "observed",
            inputID: "msg_turn_new",
            executionStartSequence: 22,
            eventSequence: 22,
            count: 0,
          })

          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.shell.started", sessionID, 24)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(async () => {
              const background = (await native.host.session(sessionID))?.background
              return (
                background?.state === "unknown" &&
                background.reason.includes("session.shell.started")
              )
            }),
          )
          const afterShellStart = yield* Effect.promise(() => native.host.session(sessionID))
          expect(afterShellStart?.background).toMatchObject({
            state: "unknown",
            reason:
              "Native session.shell.started was observed after the last experimental.idle background report",
          })
        }),
      ),
    )
  } finally {
    fixture.close()
  }
})

test("early assistant commentary followed by tools is not a final handoff", async () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(secondAttemptID),
    )
    const recorder = new ProgressRecorder(fixture.store, "project")
    recorder.report({
      sessionID: "ses-accepted",
      agent: "lazers-implementor",
      callID: "early-tool-commentary",
      messageID: "msg_early_commentary",
      message: "The first change is underway; more work remains.",
    })
    const ctx = makeContext(fixture, {
      messages: [
        { id: "prompt", type: "user", text: "Implement the task." },
        {
          id: "early-commentary",
          type: "assistant",
          finish: "stop",
          content: [{ type: "text", text: "I will make the changes now." }],
        },
        {
          id: "later-tool-call",
          type: "assistant",
          finish: "tool-calls",
          content: [{ type: "tool", id: "call", name: "Bash", state: { status: "completed" } }],
        },
        { id: "tool-result", type: "tool", content: "The test command completed." },
      ],
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(ctx.context, recorder, "project")
          const idle = ctx.idle()!
          yield* idle({ sessionID: Session.ID.make("ses-accepted"), background: [] } as never)
          yield* idle({ sessionID: Session.ID.make("ses-accepted"), background: [] } as never)
        }),
      ),
    )
    expect(ctx.syntheticCalls()).toBe(1)
    expect(
      fixture.store.progressFacts([secondAttemptID]).some((row) => row.kind === "commentary"),
    ).toBe(true)
  } finally {
    fixture.close()
  }
})

test("final handoff after later tools suppresses reminder; non-final tool commentary does not", async () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(secondAttemptID),
    )
    const recorder = new ProgressRecorder(fixture.store, "project")
    const ctx = makeContext(fixture, {
      messages: [
        { id: "prompt", type: "user", text: "Implement the task." },
        {
          id: "early-commentary",
          type: "assistant",
          finish: "stop",
          content: [{ type: "text", text: "I will make the changes now." }],
        },
        {
          id: "tool-call",
          type: "assistant",
          finish: "tool-calls",
          content: [{ type: "tool", id: "call", name: "Bash", state: { status: "completed" } }],
        },
        {
          id: "final-handoff",
          type: "assistant",
          finish: "stop",
          content: [{ type: "text", text: "Implemented, verified, and committed." }],
        },
      ],
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(ctx.context, recorder, "project")
          const idle = ctx.idle()!
          yield* idle({ sessionID: Session.ID.make("ses-accepted"), background: [] } as never)
          yield* idle({ sessionID: Session.ID.make("ses-accepted"), background: [] } as never)
        }),
      ),
    )
    expect(ctx.syntheticCalls()).toBe(0)
    expect(
      fixture.store.progressFacts([secondAttemptID]).filter((row) => row.kind === "reminder"),
    ).toHaveLength(0)
  } finally {
    fixture.close()
  }
})

test("same-execution reentrant idle cannot recursively admit more than one synthetic reminder", async () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(secondAttemptID),
    )
    const recorder = new ProgressRecorder(fixture.store, "project")
    let reenter: ((idle: never) => Effect.Effect<void>) | undefined
    const context = makeContext(fixture, {
      synthetic: (input) =>
        Effect.tryPromise({
          try: async () => {
            if (reenter)
              await Effect.runPromise(
                reenter({
                  sessionID: Session.ID.make("ses-accepted"),
                  background: [],
                } as never),
              )
            return { id: (input as { id?: unknown }).id }
          },
          catch: (error) => error,
        }),
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(context.context, recorder, "project")
          reenter = context.idle()
          yield* reenter!({ sessionID: Session.ID.make("ses-accepted"), background: [] } as never)
        }),
      ),
    )
    expect(context.syntheticCalls()).toBe(1)
    expect(
      fixture.store.progressFacts([secondAttemptID]).filter((row) => row.kind === "reminder"),
    ).toHaveLength(1)
  } finally {
    fixture.close()
  }
})

test("concurrent idle hooks claim and admit only one bounded reminder", async () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(secondAttemptID),
    )
    const recorder = new ProgressRecorder(fixture.store, "project")
    const ctx = makeContext(fixture)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(ctx.context, recorder, "project")
          const idle = ctx.idle()!
          yield* Effect.all(
            [
              idle({ sessionID: Session.ID.make("ses-accepted"), background: [] } as never),
              idle({ sessionID: Session.ID.make("ses-accepted"), background: [] } as never),
            ],
            { concurrency: "unbounded" },
          )
        }),
      ),
    )
    await Effect.runPromise(
      ctx.idle()!({ sessionID: Session.ID.make("ses-accepted"), background: [] } as never),
    )
    expect(ctx.syntheticCalls()).toBe(1)
    expect(
      fixture.store.progressFacts([secondAttemptID]).filter((row) => row.kind === "reminder"),
    ).toHaveLength(1)
  } finally {
    fixture.close()
  }
})

test("unknown synthetic admission is reconciled by exact stable native identity without resend", async () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(secondAttemptID),
    )
    const recorder = new ProgressRecorder(fixture.store, "project")
    const ctx = makeContext(fixture, {
      synthetic: () => Effect.fail(new Error("response lost after admission")),
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(ctx.context, recorder, "project")
          const idle = ctx.idle()!
          yield* idle({ sessionID: Session.ID.make("ses-accepted"), background: [] } as never)
          yield* idle({ sessionID: Session.ID.make("ses-accepted"), background: [] } as never)
        }),
      ),
    )
    const reminder = fixture.store
      .progressFacts([secondAttemptID])
      .find((row) => row.kind === "reminder")!
    expect(JSON.parse(reminder.payload).delivery).toBe("unknown")
    const payload = JSON.parse(reminder.payload) as Record<string, unknown>
    const nativeMessageID = payload.nativeMessageID as string
    const ownership = payload.ownership
    const reloaded = new ProgressRecorder(fixture.store, "project")
    reloaded.reconcileMessages("ses-accepted", [
      {
        id: nativeMessageID,
        type: "synthetic",
        text: "Provide only any remaining concise handoff.",
        metadata: ownership,
      },
    ])
    const recovered = fixture.store
      .progressFacts([secondAttemptID])
      .find((row) => row.kind === "reminder")!
    expect(JSON.parse(recovered.payload).delivery).toBe("admitted")
    expect(ctx.syntheticCalls()).toBe(1)
  } finally {
    fixture.close()
  }
})

test("confirmed rejection can retry once with the same native ID; then it is bounded", async () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(secondAttemptID),
    )
    const recorder = new ProgressRecorder(fixture.store, "project")
    let reject = true
    const ctx = makeContext(fixture, {
      synthetic: (input) => {
        if (reject) {
          reject = false
          return Effect.fail({ _tag: "InvalidRequestError", message: "explicit rejection" })
        }
        return Effect.succeed({ id: (input as { id?: unknown }).id })
      },
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(ctx.context, recorder, "project")
          const idle = ctx.idle()!
          yield* idle({ sessionID: Session.ID.make("ses-accepted"), background: [] } as never)
          yield* idle({ sessionID: Session.ID.make("ses-accepted"), background: [] } as never)
          yield* idle({ sessionID: Session.ID.make("ses-accepted"), background: [] } as never)
        }),
      ),
    )
    expect(ctx.syntheticCalls()).toBe(2)
    const submittedIDs = ctx.syntheticInputs().map((input) => (input as { id: string }).id)
    expect(submittedIDs[0]).toBe(submittedIDs[1])
    const reminder = fixture.store
      .progressFacts([secondAttemptID])
      .find((row) => row.kind === "reminder")!
    expect(JSON.parse(reminder.payload)).toMatchObject({ delivery: "admitted", deliveryAttempt: 2 })
  } finally {
    fixture.close()
  }
})

test("reminder completion stays bound to its claimed attempt, session and message across cancellation races", () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(secondAttemptID),
    )
    const recorder = new ProgressRecorder(fixture.store, "project")
    const claim = recorder.claimReminder(
      "ses-accepted",
      "A concise handoff is needed.",
      "msg_stable_reminder",
    )!
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='cancelled' WHERE id=?").run(secondAttemptID),
    )
    expect(recorder.finishReminder(claim, "admitted")).toBe(true)
    const row = fixture.store
      .progressFacts([secondAttemptID])
      .find((fact) => fact.kind === "reminder")!
    expect(JSON.parse(row.payload).delivery).toBe("admitted")
    const forged = { ...claim, sessionID: "ses-other", attemptID: fixture.attempts[0]!.id }
    expect(recorder.finishReminder(forged, "rejected")).toBe(false)
    expect(
      JSON.parse(
        fixture.store.progressFacts([secondAttemptID]).find((fact) => fact.kind === "reminder")!
          .payload,
      ).delivery,
    ).toBe("admitted")

    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(firstAttemptID),
    )
    const reassignmentClaim = recorder.claimReminder(
      "ses-failed",
      "A concise handoff is needed.",
      "msg_reassigned_reminder",
    )!
    fixture.store.atomic((db) =>
      db
        .query("UPDATE runner_attempts SET session_id='ses-reassigned' WHERE id=?")
        .run(firstAttemptID),
    )
    expect(recorder.finishReminder(reassignmentClaim, "admitted")).toBe(false)
    expect(
      JSON.parse(
        fixture.store.progressFacts([firstAttemptID]).find((fact) => fact.kind === "reminder")!
          .payload,
      ).delivery,
    ).toBe("dispatching")
  } finally {
    fixture.close()
  }
})
