import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { DateTime, Effect, Exit, Fiber, Queue, Scope, Stream } from "effect"
import { firstAttemptID, makeFixture, secondAttemptID } from "../../test/trajectory/fixture.ts"
import { RunnerStore } from "../runner/store.ts"
import { TaskRepository } from "../storage.ts"
import { ProgressRecorder } from "./recorder.ts"
import { progressReconstructionDiagnostics } from "./reconstruction.ts"
import { registerProgress as registerNativeProgress } from "./native.ts"
import type { HostMessageClient } from "../core/host-messages.ts"

/** Each fixture context's host message client, paging the same messages its context serves. */
const fixtureMessages = new WeakMap<object, HostMessageClient>()

function registerProgress(
  ctx: Plugin.Context,
  recorder: ProgressRecorder,
  projectID: string,
  sourceChanged?: (sessionID?: string) => void,
  workerIdle?: () => void,
) {
  return registerNativeProgress(
    ctx,
    recorder,
    projectID,
    sourceChanged,
    workerIdle,
    fixtureMessages.get(ctx)!,
  )
}

type RegisteredTool = Parameters<ToolEditor["add"]>[0]

function testObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

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
    readContext?: (sessionID: string) => Effect.Effect<unknown[], unknown, never>
    readSession?: (sessionID: string) => Effect.Effect<unknown, unknown, never>
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
  let beforeHook: ((call: never) => Effect.Effect<void>) | undefined
  let idleHook: ((idle: never) => Effect.Effect<void>) | undefined
  let syntheticCalls = 0
  let subscriptionCount = 0
  const eventQueue = Effect.runSync(Queue.unbounded<unknown>())
  const streamFailure = Symbol("fixture-stream-failure")
  const streamEnd = Symbol("fixture-stream-end")
  const syntheticInputs: unknown[] = []
  const sessionAssignments = new Map<
    string,
    {
      projectID: string
      attemptID: string
      sessionID: string
      assignedMessageID: string
      workspace: string
    }
  >([
    [
      "ses-failed",
      {
        projectID: "project",
        attemptID: firstAttemptID,
        sessionID: "ses-failed",
        assignedMessageID: "msg-first",
        workspace: fixture.directory,
      },
    ],
    [
      "ses-accepted",
      {
        projectID: "project",
        attemptID: secondAttemptID,
        sessionID: "ses-accepted",
        assignedMessageID: "msg-second",
        workspace: fixture.directory,
      },
    ],
  ] as const)
  const messages: unknown[] = options.messages ?? [{ id: "msg-second", type: "user" }]
  let wholeConversationReads = 0
  const listCalls: { cursor?: string; order?: string; limit?: number }[] = []
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
        if (name === "execute.before") beforeHook = callback
        return Effect.succeed({ dispose: Effect.void })
      },
    },
    session: {
      hook: (name: string, callback: (idle: never) => Effect.Effect<void>) => {
        if (name === "experimental.idle") idleHook = callback
        return Effect.succeed({ dispose: Effect.void })
      },
      get: ({ sessionID }: { sessionID: string }) => {
        const sessionAssignment = sessionAssignments.get(sessionID)
        return (
          options.readSession?.(sessionID) ??
          Effect.succeed({
            id: sessionID,
            projectID: "project",
            agent: "lazers-implementor",
            location: { directory: fixture.directory },
            ...(sessionAssignment
              ? { metadata: { lazersAttemptID: sessionAssignment.attemptID } }
              : {}),
            outcome: "succeeded",
          })
        )
      },
      // Progress never reads the whole conversation: any call here is a regression.
      context: ({ sessionID }: { sessionID: string }) => {
        wholeConversationReads++
        return options.readContext?.(sessionID) ?? Effect.succeed(messages)
      },
      synthetic: (input: unknown) => {
        syntheticCalls++
        syntheticInputs.push(input)
        return options.synthetic?.(input) ?? Effect.succeed({ id: (input as { id?: unknown }).id })
      },
    },
    event: {
      subscribe: () => {
        subscriptionCount++
        return options.eventFailure
          ? Stream.fail(new Error("fixture event stream unavailable"))
          : options.liveEvents
            ? Stream.fromQueue(eventQueue).pipe(
                Stream.takeWhile((event) => event !== streamEnd),
                Stream.mapEffect((event) =>
                  event === streamFailure
                    ? Effect.fail(new Error("fixture stream lost"))
                    : Effect.succeed(event),
                ),
              )
            : options.holdEvents
              ? Stream.never
              : Stream.fromIterable(options.events ?? [])
      },
    },
  } as unknown as Plugin.Context
  // The host message list over the same source `session.context` serves: one read per page,
  // an opaque numeric cursor, ascending by default and newest first for `order: "desc"`.
  fixtureMessages.set(context, {
    message: {
      list: async (input: {
        sessionID: string
        cursor?: string
        order?: string
        limit?: number
      }) => {
        listCalls.push({ cursor: input.cursor, order: input.order, limit: input.limit })
        const all = (await Effect.runPromise(
          options.readContext?.(input.sessionID) ?? Effect.succeed(messages),
        )) as { id: string }[]
        const limit = input.limit ?? 50
        if (input.order === "desc")
          return { data: all.slice(-limit).reverse(), cursor: {} } as never
        const start = input.cursor ? Number(input.cursor) : 0
        const data = all.slice(start, start + limit)
        const next = start + limit < all.length ? String(start + limit) : undefined
        return { data, cursor: { ...(next ? { next } : {}) } } as never
      },
    },
  })
  return {
    context,
    tools,
    before: () => beforeHook,
    after: () => afterHook,
    idle: () => idleHook,
    syntheticCalls: () => syntheticCalls,
    subscriptions: () => subscriptionCount,
    syntheticInputs: () => syntheticInputs,
    wholeConversationReads: () => wholeConversationReads,
    listCalls,
    messages,
    emitEvent: (event: unknown) => {
      const value = testObject(event)
      if (value?.type === "session.execution.succeeded" && typeof value.id === "string") {
        try {
          const idleID = SessionMessage.ID.fromEvent(value.id)
          const now = DateTime.nowUnsafe()
          const responseID = `msg_response_${value.id.slice("evt_".length)}`
          if (!messages.some((message) => testObject(message)?.id === responseID))
            messages.push({
              id: responseID,
              type: "assistant",
              time: { created: now, completed: now },
              finish: "stop",
              content: [],
            })
          if (!messages.some((message) => testObject(message)?.id === idleID))
            messages.push({
              id: idleID,
              type: "idle",
              outcome: "succeeded",
              time: { created: now },
            })
        } catch {
          // Invalid native event IDs are intentionally not repaired by the fixture.
        }
      }
      return Effect.runPromise(Queue.offer(eventQueue, event))
    },
    failEvents: () => Effect.runPromise(Queue.offer(eventQueue, streamFailure)),
    endEvents: () => Effect.runPromise(Queue.offer(eventQueue, streamEnd)),
  }
}

test("F-S3-1 the existing native stream invalidates source caches on activity and loss", async () => {
  const fixture = makeFixture()
  const recorder = new ProgressRecorder(fixture.store, "project")
  const ctx = makeContext(fixture, { liveEvents: true })
  const seen: (string | undefined)[] = []
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(ctx.context, recorder, "project", (id) => {
            seen.push(id)
          })
          yield* Effect.promise(() =>
            ctx.emitEvent({ type: "session.unarchived", data: { sessionID: "old-architect" } }),
          )
          yield* Effect.promise(() =>
            waitForNativeState(async () => seen.includes("old-architect")),
          )
          yield* Effect.promise(() => ctx.failEvents())
          yield* Effect.promise(() =>
            waitForNativeState(async () => seen.filter((id) => id === undefined).length === 2),
          )
          expect(seen.filter((id) => id === undefined)).toHaveLength(2)
        }),
      ),
    )
  } finally {
    fixture.close()
  }
})

test.each(["session.idle", "session.execution.failed", "session.execution.interrupted"])(
  "%s wakes reconciliation only for assigned workers",
  async (type) => {
    const fixture = makeFixture()
    const recorder = new ProgressRecorder(fixture.store, "project")
    const ctx = makeContext(fixture, { liveEvents: true })
    const wakes: string[] = []
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* registerProgress(
              ctx.context,
              recorder,
              "project",
              (id) => {
                if (id) wakes.push(id)
              },
              () => {
                wakes.push("scheduler")
              },
            )
            yield* Effect.promise(() => ctx.emitEvent(executionEvent(type, "unassigned", 1)))
            yield* Effect.promise(() => ctx.emitEvent(executionEvent(type, "ses-accepted", 2)))
            yield* Effect.promise(() => waitForNativeState(async () => wakes.includes("scheduler")))
            expect(wakes).toEqual(["unassigned", "ses-accepted", "scheduler"])
          }),
        ),
      )
    } finally {
      fixture.close()
    }
  },
)

test("registered execute.before records only an assigned bounded requested target", async () => {
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
          const before = ctx.before()
          expect(before).toBeDefined()
          yield* before!({
            tool: "read",
            sessionID: Session.ID.make("ses-accepted"),
            agent: Agent.ID.make("lazers-implementor"),
            messageID: SessionMessage.ID.make("msg_worker_call"),
            id: Tool.CallID.make("call-read-1"),
            input: {
              path: "src/private.ts",
              content: "private file body decoy",
              headers: { Authorization: "Bearer credential-decoy" },
            },
          } as never)
        }),
      ),
    )
    const fact = fixture.store
      .progressFacts([secondAttemptID])
      .find((item) => item.call_id === "call-read-1")
    expect(fact).toBeDefined()
    expect(JSON.parse(fact!.payload)).toMatchObject({
      tool: "read",
      fileTargets: { coverage: "observed", operation: "read", paths: ["src/private.ts"] },
    })
    expect(fact!.payload).not.toContain("private file body")
    expect(fact!.payload).not.toContain("credential-decoy")
  } finally {
    fixture.close()
  }
})

test.each(["failed", "ended"] as const)(
  "tool ownership revalidates missed moves after the event stream %s",
  async (boundary) => {
    const fixture = makeFixture()
    try {
      const recorder = new ProgressRecorder(fixture.store, "project")
      let moved = false
      const native = makeContext(fixture, {
        liveEvents: true,
        readSession: (sessionID) =>
          Effect.succeed({
            projectID: "project",
            location: {
              directory:
                sessionID === "ses-leaves"
                  ? moved
                    ? "/elsewhere"
                    : fixture.directory
                  : sessionID === "ses-arrives"
                    ? moved
                      ? fixture.directory
                      : "/elsewhere"
                    : fixture.directory,
            },
          }),
      })
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* registerProgress(native.context, recorder, "project")
            yield* Effect.promise(() =>
              waitForNativeState(async () => native.subscriptions() === 1),
            )
            for (const sessionID of ["ses-leaves", "ses-arrives"]) {
              yield* native.before()!({
                tool: "shell",
                ...callContext(sessionID, "before-disconnection"),
                input: {},
              } as never)
            }
            expect(recorder.toolCalls("ses-leaves")).toHaveLength(1)
            expect(recorder.toolCalls("ses-arrives")).toHaveLength(0)
            yield* Effect.promise(() =>
              boundary === "failed" ? native.failEvents() : native.endEvents(),
            )
            // No session.moved event reaches this listener while ownership changes.
            moved = true
            yield* Effect.promise(() =>
              waitForNativeState(async () => native.subscriptions() > 1, 3000),
            )
            for (const sessionID of ["ses-leaves", "ses-arrives"]) {
              yield* native.after()!({
                tool: "shell",
                ...callContext(sessionID, "after-reconnection"),
                status: "error",
                error: new Tool.Error({ message: "original native failure" }),
              } as never)
            }
            expect(recorder.toolCalls("ses-leaves")).toHaveLength(1)
            expect(recorder.toolCalls("ses-arrives")).toHaveLength(1)
            expect(recorder.toolCalls("ses-arrives")[0]!.native_call_id).toBe("after-reconnection")
          }),
        ),
      )
    } finally {
      fixture.close()
    }
  },
)

test("registered tool hooks retain unassigned agents and isolate lookup or storage failures", async () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const ctx = makeContext(fixture, { holdEvents: true })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(ctx.context, recorder, "project")
          for (const agent of ["architect", "researcher", "auditor", "build"]) {
            const call = {
              tool: "shell",
              sessionID: Session.ID.make(`ses-${agent}`),
              agent: Agent.ID.make(agent),
              messageID: SessionMessage.ID.make("msg_observed"),
              id: Tool.CallID.make(agent),
              input: {},
            }
            yield* ctx.before()!(call as never)
            yield* ctx.after()!({
              ...call,
              status: "error",
              error: new Tool.Error({ message: "Invalid arguments: command missing" }),
            } as never)
            expect(recorder.toolCalls(call.sessionID)).toHaveLength(1)
            expect(recorder.toolCalls(call.sessionID)[0]).toMatchObject({ agent, attempt_id: null })
          }
          recorder.recordToolHook = () => {
            throw new Error("storage unavailable")
          }
          yield* ctx.after()!({
            tool: "shell",
            ...callContext("ses-build", "unavailable"),
            status: "error",
            error: new Tool.Error({ message: "original failure" }),
          } as never)
        }),
      ),
    )
    const broken = makeContext(fixture, {
      holdEvents: true,
      readSession: () => {
        throw new Error("lookup unavailable")
      },
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(broken.context, recorder, "project")
          yield* broken.before()!({
            tool: "shell",
            ...callContext("ses-unknown", "lookup"),
            input: {},
          } as never)
          yield* broken.after()!({
            tool: "shell",
            ...callContext("ses-unknown", "lookup"),
            status: "completed",
            result: {},
          } as never)
        }),
      ),
    )
    expect(recorder.toolCalls("ses-unknown")).toHaveLength(0)
  } finally {
    fixture.close()
  }
})

test("unassigned native terminal errors are captured only by their actual project and location", async () => {
  const fixture = makeFixture()
  try {
    for (const own of [true, false]) {
      const recorder = new ProgressRecorder(fixture.store, "project")
      const sessionID = own ? "ses-unassigned-own" : "ses-unassigned-foreign"
      const ctx = makeContext(fixture, {
        events: [
          {
            id: `evt-input-${own}`,
            type: "session.tool.input.started",
            created: DateTime.makeUnsafe(1000),
            data: {
              sessionID,
              id: "native-error",
              assistantMessageID: "msg_observed",
              name: "shell",
            },
          },
          {
            id: `evt-failure-${own}`,
            type: "session.tool.failed",
            created: DateTime.makeUnsafe(1100),
            data: {
              sessionID,
              id: "native-error",
              assistantMessageID: "msg_observed",
              executed: false,
              error: { message: "Implementor requires an admitted runtime assignment" },
            },
          },
        ],
        readSession: () =>
          Effect.succeed({
            projectID: own ? "project" : "foreign",
            location: { directory: fixture.directory },
          }),
      })
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* registerProgress(ctx.context, recorder, "project")
            yield* Effect.promise(() => waitForNativeState(async () => ctx.subscriptions() > 0))
            if (own)
              yield* Effect.promise(() =>
                waitForNativeState(async () =>
                  recorder
                    .toolCalls(sessionID)
                    .some((row) => JSON.parse(row.payload).status === "failed"),
                ),
              )
            else yield* Effect.yieldNow
          }),
        ),
      )
      expect(recorder.toolCalls(sessionID)).toHaveLength(own ? 1 : 0)
    }
  } finally {
    fixture.close()
  }
})

function executionEvent(type: string, sessionID: string, sequence: number) {
  return {
    id: `evt_${sequence}`,
    created: sequence,
    type,
    durable: { aggregateID: sessionID, seq: sequence, version: 1 },
    data: { sessionID },
  }
}

async function waitForNativeState(predicate: () => Promise<boolean>, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
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
        {
          id: "native-step-start",
          type: "session.step.started",
          created: 80,
          data: {
            sessionID: "ses-accepted",
            assistantMessageID: "msg-worker-call",
            agent: "lazers-implementor",
            model: { providerID: "openai", id: "test-model" },
            started: 80,
          },
        },
        {
          id: "native-step-streamed",
          type: "session.step.streamed",
          created: 95,
          data: { sessionID: "ses-accepted", assistantMessageID: "msg-worker-call" },
        },
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
              name: "lz-report-progress",
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
          const report = ctx.tools.get("lz-report-progress")!
          expect(report.options).toMatchObject({
            codemode: true,
            permission: "lz-report-progress",
          })
          const result = yield* report.execute(
            { message: "Implemented and verified; committed changes are ready." },
            callContext("ses-accepted", callID),
          )
          expect(result.output).toMatchObject({ sequence: expect.any(Number) })
          yield* ctx.after()!({
            tool: "lz-report-progress",
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
            name: "lz-report-progress",
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
    const step = rows.find((row) => row.kind === "step")!
    expect(JSON.parse(step.payload)).toMatchObject({
      status: "streamed",
      timing: {
        unit: "unix-epoch-ms",
        endpoints: {
          startedAt: { at: 80, source: "native-event" },
          streamedAt: { at: 95, source: "native-event" },
        },
      },
    })
    expect(comment.payload).not.toContain("private model input field")
    expect(comment.payload).not.toContain("must not be captured as a tool input")
    expect(comment.payload).not.toContain("token fields")
  } finally {
    fixture.close()
  }
})

test("reconstruction diagnostics count actual native read outcomes without exposing error details", async () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(secondAttemptID),
    )
    const recorder = new ProgressRecorder(fixture.store, "project")
    const nativeGetCalls: string[] = []
    const nativeContextCalls: string[] = []
    const ctx = makeContext(fixture, {
      readSession: (sessionID) => {
        nativeGetCalls.push(sessionID)
        return sessionID === "ses-failed"
          ? Effect.fail(new Error("private native session error value"))
          : Effect.succeed({
              id: sessionID,
              projectID: "project",
              agent: "lazers-implementor",
              location: { directory: fixture.directory },
            })
      },
      readContext: (sessionID) => {
        nativeContextCalls.push(sessionID)
        return Effect.succeed([])
      },
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(ctx.context, recorder, "project")
          yield* Effect.promise(() =>
            waitForNativeState(async () => {
              const diagnostics = progressReconstructionDiagnostics(
                fixture.store.repository.path,
                fixture.directory,
                "project",
              )
              return (
                diagnostics.coordinator.nativeReads?.get.invocations === 2 &&
                diagnostics.coordinator.nativeReads.get.pending === 0 &&
                diagnostics.coordinator.nativeReads.context.invocations === 1 &&
                diagnostics.coordinator.nativeReads.context.pending === 0
              )
            }),
          )
          const diagnostics = progressReconstructionDiagnostics(
            fixture.store.repository.path,
            fixture.directory,
            "project",
          )
          expect(diagnostics.coordinator.nativeReads).toMatchObject({
            get: { invocations: 2, succeeded: 1, failed: 1, pending: 0 },
            context: { invocations: 1, succeeded: 1, failed: 0, pending: 0 },
          })
          expect(diagnostics.coordinator.assignments.cachedCount).toBe(2)
          expect(diagnostics.coordinator.assignments.asOf).not.toBeNull()
          expect(nativeGetCalls.sort()).toEqual(["ses-accepted", "ses-failed"])
          expect(nativeContextCalls).toEqual(["ses-accepted"])
          const serialized = JSON.stringify(diagnostics)
          expect(serialized).not.toContain("private native session error value")
          expect(serialized).not.toContain("ses-accepted")
          expect(serialized).not.toContain(fixture.directory)
        }),
      ),
    )
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
    const tool = denied.tools.get("lz-report-progress")!
    await expect(
      Effect.runPromise(
        tool.execute({ message: "permission denied" }, callContext("ses-accepted", "denied-call")),
      ),
    ).rejects.toThrow("permission denied")
    expect(fixture.store.progressFacts([secondAttemptID])).toEqual([])

    const allowed = makeContext(fixture)
    await Effect.runPromise(Effect.scoped(registerProgress(allowed.context, recorder, "project")))
    const allowedTool = allowed.tools.get("lz-report-progress")!
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

test("the idle hook stores no idle report: it wakes the scheduler and reminds only when nothing runs", async () => {
  const fixture = makeFixture()
  try {
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(secondAttemptID),
    )
    const recorder = new ProgressRecorder(fixture.store, "project")
    const ctx = makeContext(fixture, {})
    let wakes = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(ctx.context, recorder, "project", undefined, () => {
            wakes++
          })
          yield* Effect.sleep(5)
          const idle = ctx.idle()!
          // A positive background list never requests a handoff, but still wakes the scheduler.
          yield* idle({
            sessionID: Session.ID.make("ses-accepted"),
            background: [{ kind: "shell" }],
          } as never)
          expect(ctx.syntheticCalls()).toBe(0)
          expect(wakes).toBe(1)
          // An unassigned session is ignored.
          yield* idle({ sessionID: Session.ID.make("ses-unassigned"), background: [] } as never)
          expect(wakes).toBe(1)
          yield* idle({ sessionID: Session.ID.make("ses-accepted"), background: [] } as never)
        }),
      ),
    )
    expect(wakes).toBe(2)
    expect(ctx.syntheticCalls()).toBe(1)
    const tables = fixture.store.atomic((db) =>
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE name='runner_native_idle'",
        )
        .all(),
    )
    expect(tables).toEqual([])
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
    const ctx = makeContext(fixture, {
      events: [executionEvent("session.execution.started", "ses-accepted", 10)],
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(ctx.context, recorder, "project")
          yield* Effect.sleep(5)
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
      liveEvents: true,
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
          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.execution.started", "ses-accepted", 10)),
          )
          yield* Effect.sleep(5)
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
      liveEvents: true,
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
          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.execution.started", "ses-accepted", 11)),
          )
          yield* Effect.sleep(5)
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
      liveEvents: true,
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
          yield* Effect.promise(() =>
            context.emitEvent(executionEvent("session.execution.started", "ses-accepted", 12)),
          )
          yield* Effect.sleep(5)
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
    const ctx = makeContext(fixture, { liveEvents: true })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(ctx.context, recorder, "project")
          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.execution.started", "ses-accepted", 13)),
          )
          yield* Effect.sleep(5)
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
      liveEvents: true,
      synthetic: () => Effect.fail(new Error("response lost after admission")),
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(ctx.context, recorder, "project")
          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.execution.started", "ses-accepted", 14)),
          )
          yield* Effect.sleep(5)
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
      liveEvents: true,
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
          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.execution.started", "ses-accepted", 15)),
          )
          yield* Effect.sleep(5)
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
    const claimedRow = fixture.store
      .progressFacts([secondAttemptID])
      .find((fact) => fact.kind === "reminder")!
    fixture.store.atomic((db) =>
      db.query("UPDATE runner_attempts SET state='cancelled' WHERE id=?").run(secondAttemptID),
    )
    expect(recorder.finishReminder(claim, "admitted")).toBe(true)
    const row = fixture.store
      .progressFacts([secondAttemptID])
      .find((fact) => fact.kind === "reminder")!
    expect(JSON.parse(row.payload).delivery).toBe("admitted")
    expect(Number.isSafeInteger(claimedRow.recorded_at)).toBe(true)
    expect(Number.isSafeInteger(row.recorded_at)).toBe(true)
    expect(row.recorded_at).toBeGreaterThanOrEqual(claimedRow.recorded_at!)
    expect(recorder.finishReminder(claim, "admitted")).toBe(false)
    expect(
      fixture.store.progressFacts([secondAttemptID]).find((fact) => fact.kind === "reminder")!
        .recorded_at,
    ).toBe(row.recorded_at)
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

test("project recovery is coalesced while native hooks remain per location", async () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    let firstGets = 0
    let firstContexts = 0
    let secondGets = 0
    let secondContexts = 0
    const retainedMessages = (sessionID: string) => [
      {
        id: `msg-recovered-${sessionID}`,
        type: "assistant",
        time: { created: 1_000 },
        content: [{ type: "text", text: `Recovered ${sessionID}` }],
      },
    ]
    const first = makeContext(fixture, {
      liveEvents: true,
      readSession: (sessionID) => {
        firstGets++
        return Effect.succeed({
          id: sessionID,
          projectID: "project",
          agent: "lazers-implementor",
          location: { directory: fixture.directory },
        })
      },
      readContext: (sessionID) => {
        firstContexts++
        return Effect.succeed(retainedMessages(sessionID))
      },
    })
    const second = makeContext(fixture, {
      holdEvents: true,
      readSession: (sessionID) => {
        secondGets++
        return Effect.succeed({
          id: sessionID,
          projectID: "project",
          agent: "lazers-implementor",
          location: { directory: fixture.directory },
        })
      },
      readContext: (sessionID) => {
        secondContexts++
        return Effect.succeed(retainedMessages(sessionID))
      },
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(first.context, recorder, "project")
          yield* registerProgress(second.context, recorder, "project")
          yield* Effect.promise(() =>
            waitForNativeState(async () => firstContexts + secondContexts === 2),
          )
          yield* Effect.sleep(25)
          expect(firstGets + secondGets).toBe(2)
          expect(firstContexts + secondContexts).toBe(2)
          expect(first.tools.get("lz-report-progress")).toBeDefined()
          expect(second.tools.get("lz-report-progress")).toBeDefined()
          expect(first.after()).toBeDefined()
          expect(second.after()).toBeDefined()
          expect(first.idle()).toBeDefined()
          expect(second.idle()).toBeDefined()

          const recoveryFactCount = fixture.store
            .progressFacts([firstAttemptID, secondAttemptID])
            .filter((fact) => fact.source === "recovery").length
          yield* Effect.promise(() =>
            first.emitEvent({
              id: "context-change",
              type: "session.step.streamed",
              created: 2_000,
              data: { sessionID: "ses-accepted", assistantMessageID: "msg-refresh" },
            }),
          )
          yield* Effect.promise(() =>
            waitForNativeState(async () => firstContexts + secondContexts === 3),
          )
          yield* Effect.sleep(25)
          expect(firstGets + secondGets).toBe(3)
          expect(
            fixture.store
              .progressFacts([firstAttemptID, secondAttemptID])
              .filter((fact) => fact.source === "recovery").length,
          ).toBe(recoveryFactCount)
        }),
      ),
    )
  } finally {
    fixture.close()
  }
})

test.each(["get", "context", "identity"] as const)(
  "unavailable or mismatched historical %s reads keep a safe gap and eventually recover",
  async (failure) => {
    const fixture = makeFixture()
    try {
      const recorder = new ProgressRecorder(fixture.store, "project")
      let getCalls = 0
      let contextCalls = 0
      let failedOnce = false
      const recoveredMessage = {
        id: "msg-recovered-after-gap",
        type: "assistant",
        time: { created: 2_100 },
        content: [{ type: "text", text: "Retained facts recovered after a safe gap." }],
      }
      const sessionInfo = (sessionID: string, workspace = fixture.directory, tokens?: unknown) => ({
        id: sessionID,
        projectID: "project",
        agent: "lazers-implementor",
        location: { directory: workspace },
        ...(tokens ? { tokens } : {}),
      })
      const ctx = makeContext(fixture, {
        holdEvents: true,
        readSession: (sessionID) => {
          if (sessionID !== "ses-failed") return Effect.succeed(sessionInfo(sessionID))
          getCalls++
          if (failure === "get" && !failedOnce) {
            failedOnce = true
            return Effect.fail(new Error("temporary native get outage"))
          }
          if (failure === "identity" && !failedOnce) {
            failedOnce = true
            return Effect.succeed(sessionInfo(sessionID, "/foreign/workspace", { input: 99 }))
          }
          return Effect.succeed(sessionInfo(sessionID))
        },
        readContext: (sessionID) => {
          if (sessionID !== "ses-failed") return Effect.succeed([])
          contextCalls++
          if (failure === "context" && !failedOnce) {
            failedOnce = true
            return Effect.fail(new Error("temporary native context outage"))
          }
          return Effect.succeed([recoveredMessage])
        },
      })

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* registerProgress(ctx.context, recorder, "project")
            yield* Effect.promise(() =>
              waitForNativeState(
                async () =>
                  fixture.store
                    .progressFacts([firstAttemptID])
                    .some(
                      (fact) =>
                        fact.kind === "visible-text" &&
                        JSON.parse(fact.payload).text === recoveredMessage.content[0]!.text,
                    ),
                10_000,
              ),
            )
          }),
        ),
      )

      const facts = fixture.store.progressFacts([firstAttemptID])
      expect(facts.filter((fact) => fact.kind === "gap")).toHaveLength(2)
      expect(facts.some((fact) => fact.kind === "visible-text")).toBe(true)
      expect(getCalls).toBeGreaterThanOrEqual(failure === "get" || failure === "identity" ? 2 : 1)
      expect(contextCalls).toBeGreaterThanOrEqual(failure === "context" ? 2 : 1)
      if (failure === "identity")
        expect(facts.some((fact) => fact.kind === "usage-snapshot")).toBe(false)
    } finally {
      fixture.close()
    }
  },
)

test.each(["get", "context"] as const)(
  "replacement recovery takes ownership during a suspended %s read and fences its late continuation",
  async (stage) => {
    const fixture = makeFixture()
    const releaseOld = Promise.withResolvers<void>()
    const oldReturned = Promise.withResolvers<void>()
    const releaseReplacementInitial = Promise.withResolvers<void>()
    const releaseReplacementLate = Promise.withResolvers<void>()
    const processedEvents = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
    const replacementGets = new Map<string, number>()
    const replacementContexts = new Map<string, number>()
    let oldResolved = false
    let oldReadStarted = false
    let replacementInitialReadStarted = false
    let replacementLateReadStarted = false
    let contentRevision = 1
    let activeReplacementContexts = 0
    let maxActiveReplacementContexts = 0
    let replacementRepository: TaskRepository | undefined
    try {
      const oldRecorder = new ProgressRecorder(fixture.store, "project")
      const oldContext = makeContext(fixture, {
        holdEvents: true,
        readSession: (sessionID) => {
          const value = {
            id: sessionID,
            projectID: "project",
            agent: "lazers-implementor",
            location: { directory: fixture.directory },
            tokens: { input: 11, output: 7 },
            outcome: "succeeded",
            time: { idle: 2_100 },
          }
          if (stage !== "get" || sessionID !== "ses-failed") return Effect.succeed(value)
          return Effect.promise(async () => {
            oldReadStarted = true
            await releaseOld.promise
            oldResolved = true
            oldReturned.resolve()
            return value
          })
        },
        readContext: (sessionID) => {
          if (stage !== "context" || sessionID !== "ses-failed") return Effect.succeed([])
          return Effect.promise(async () => {
            oldReadStarted = true
            await releaseOld.promise
            oldResolved = true
            oldReturned.resolve()
            return [
              {
                id: "msg-retired-read",
                type: "assistant",
                time: { created: 2_000 },
                content: [{ type: "text", text: "Must not be written by the retired recorder." }],
              },
            ]
          })
        },
      })
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const oldFiber = yield* Effect.forkScoped(
              Effect.scoped(
                Effect.gen(function* () {
                  yield* registerProgress(oldContext.context, oldRecorder, "project")
                  yield* Effect.never
                }),
              ),
            )
            yield* Effect.promise(() => waitForNativeState(async () => oldReadStarted))
            yield* Fiber.interrupt(oldFiber)
            fixture.store.repository.close()

            const replacementStore = new RunnerStore(
              (replacementRepository = new TaskRepository(
                fixture.store.repository.path,
                fixture.directory,
              )),
            )
            const replacementRecorder = new ProgressRecorder(replacementStore, "project")
            const recordNativeEvent =
              replacementRecorder.recordNativeEvent.bind(replacementRecorder)
            replacementRecorder.recordNativeEvent = (event) => {
              const result = recordNativeEvent(event)
              const id = (event as { id?: unknown }).id
              if (typeof id === "string") processedEvents.get(id)?.resolve()
              return result
            }
            const replacementContext = makeContext(fixture, {
              liveEvents: true,
              readSession: (sessionID) => {
                replacementGets.set(sessionID, (replacementGets.get(sessionID) ?? 0) + 1)
                return Effect.succeed({
                  id: sessionID,
                  projectID: "project",
                  agent: "lazers-implementor",
                  location: { directory: fixture.directory },
                  tokens: { input: 22, output: 13 },
                  outcome: "succeeded",
                  time: { idle: 2_200 },
                })
              },
              readContext: (sessionID) => {
                const call = (replacementContexts.get(sessionID) ?? 0) + 1
                replacementContexts.set(sessionID, call)
                const revision = contentRevision
                activeReplacementContexts++
                maxActiveReplacementContexts = Math.max(
                  maxActiveReplacementContexts,
                  activeReplacementContexts,
                )
                const messages = [
                  {
                    id: `msg-${sessionID}-revision-${revision}`,
                    type: "assistant",
                    time: { created: 2_300 + revision },
                    content: [
                      { type: "text", text: `${sessionID} retained content revision ${revision}` },
                    ],
                  },
                ]
                return Effect.promise(async () => {
                  try {
                    if (sessionID === "ses-accepted" && call === 1) {
                      replacementInitialReadStarted = true
                      await releaseReplacementInitial.promise
                    }
                    if (sessionID === "ses-accepted" && call === 3) {
                      replacementLateReadStarted = true
                      await releaseReplacementLate.promise
                    }
                    return messages
                  } finally {
                    activeReplacementContexts--
                  }
                })
              },
            })
            const replacementFiber = yield* Effect.forkScoped(
              Effect.scoped(
                Effect.gen(function* () {
                  yield* registerProgress(
                    replacementContext.context,
                    replacementRecorder,
                    "project",
                  )
                  yield* Effect.never
                }),
              ),
            )
            yield* Effect.promise(() =>
              waitForNativeState(async () => replacementInitialReadStarted),
            )
            expect(oldResolved).toBe(false)

            contentRevision = 2
            for (const id of ["new-context-1", "new-context-2", "new-context-3"]) {
              const processed = Promise.withResolvers<void>()
              processedEvents.set(id, processed)
              yield* Effect.promise(() =>
                replacementContext.emitEvent({
                  id,
                  type: "session.step.streamed",
                  created: 2_400,
                  data: { sessionID: "ses-accepted", assistantMessageID: "msg-current" },
                }),
              )
              yield* Effect.promise(() => processed.promise)
            }

            releaseReplacementInitial.resolve()
            yield* Effect.promise(() =>
              waitForNativeState(
                async () =>
                  replacementContexts.get("ses-accepted") === 2 &&
                  replacementContexts.get("ses-failed") === 1,
                10_000,
              ),
            )
            yield* Effect.sleep(20)
            expect(oldResolved).toBe(false)
            expect([...replacementGets.entries()].sort()).toEqual([
              ["ses-accepted", 2],
              ["ses-failed", 1],
            ])
            expect([...replacementContexts.entries()].sort()).toEqual([
              ["ses-accepted", 2],
              ["ses-failed", 1],
            ])
            expect(maxActiveReplacementContexts).toBe(1)

            contentRevision = 3
            {
              const id = "late-context-1"
              const processed = Promise.withResolvers<void>()
              processedEvents.set(id, processed)
              yield* Effect.promise(() =>
                replacementContext.emitEvent({
                  id,
                  type: "session.step.streamed",
                  created: 2_500,
                  data: { sessionID: "ses-accepted", assistantMessageID: "msg-current" },
                }),
              )
              yield* Effect.promise(() => processed.promise)
            }
            yield* Effect.promise(() => waitForNativeState(async () => replacementLateReadStarted))
            contentRevision = 4
            for (const id of ["late-context-2", "late-context-3"]) {
              const processed = Promise.withResolvers<void>()
              processedEvents.set(id, processed)
              yield* Effect.promise(() =>
                replacementContext.emitEvent({
                  id,
                  type: "session.step.streamed",
                  created: 2_600,
                  data: { sessionID: "ses-accepted", assistantMessageID: "msg-current" },
                }),
              )
              yield* Effect.promise(() => processed.promise)
            }

            releaseOld.resolve()
            yield* Effect.promise(() => oldReturned.promise)
            yield* Effect.sleep(10)
            expect(oldResolved).toBe(true)
            expect(activeReplacementContexts).toBe(1)
            expect(
              (fixture.store.repository as unknown as { connection?: unknown }).connection,
            ).toBeUndefined()

            releaseReplacementLate.resolve()
            yield* Effect.promise(() =>
              waitForNativeState(async () => replacementContexts.get("ses-accepted") === 4, 10_000),
            )
            yield* Effect.sleep(20)
            expect([...replacementGets.entries()].sort()).toEqual([
              ["ses-accepted", 4],
              ["ses-failed", 1],
            ])
            expect([...replacementContexts.entries()].sort()).toEqual([
              ["ses-accepted", 4],
              ["ses-failed", 1],
            ])
            expect(maxActiveReplacementContexts).toBe(1)

            const facts = replacementStore.progressFacts([firstAttemptID, secondAttemptID])
            expect(
              facts.some(
                (fact) =>
                  fact.kind === "visible-text" &&
                  JSON.parse(fact.payload).text === "ses-accepted retained content revision 2",
              ),
            ).toBe(true)
            expect(
              facts.some(
                (fact) =>
                  fact.kind === "visible-text" &&
                  JSON.parse(fact.payload).text === "ses-accepted retained content revision 1",
              ),
            ).toBe(true)
            expect(
              facts.some(
                (fact) =>
                  fact.kind === "visible-text" &&
                  JSON.parse(fact.payload).text === "ses-accepted retained content revision 4",
              ),
            ).toBe(true)
            expect(
              facts.some(
                (fact) =>
                  fact.kind === "visible-text" &&
                  JSON.parse(fact.payload).text === "ses-failed retained content revision 2",
              ),
            ).toBe(true)
            expect(
              facts.some(
                (fact) =>
                  fact.kind === "visible-text" &&
                  JSON.parse(fact.payload).text === "Must not be written by the retired recorder.",
              ),
            ).toBe(false)
            expect(
              facts.filter(
                (fact) => fact.kind === "outcome-snapshot" && fact.session_id === "ses-failed",
              ),
            ).toHaveLength(1)
            yield* Fiber.interrupt(replacementFiber)
          }),
        ),
      )
    } finally {
      releaseOld.resolve()
      releaseReplacementInitial.resolve()
      releaseReplacementLate.resolve()
      replacementRepository?.close()
      fixture.close()
    }
  },
)

test("finished sessions with an unchanged native stamp are neither re-read nor re-reconciled", async () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const updated = new Map([
      ["ses-failed", 100],
      ["ses-accepted", 100],
    ])
    const gets: string[] = []
    const contexts: string[] = []
    const ctx = makeContext(fixture, {
      liveEvents: true,
      readSession: (sessionID) => {
        gets.push(sessionID)
        return Effect.succeed({
          id: sessionID,
          projectID: "project",
          agent: "lazers-implementor",
          location: { directory: fixture.directory },
          time: { updated: updated.get(sessionID) },
        })
      },
      readContext: (sessionID) => {
        contexts.push(sessionID)
        return Effect.succeed([])
      },
    })
    const idle = (sessionID: string) => ctx.emitEvent(executionEvent("session.idle", sessionID, 1))

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(ctx.context, recorder, "project")
          // Boot baseline: no stamp exists yet, so each finished session is read once.
          yield* Effect.promise(() => waitForNativeState(async () => contexts.length === 2))
          expect(gets.length).toBe(2)

          // Events for unchanged sessions cost one cheap session.get and no context read.
          yield* Effect.promise(async () => {
            await idle("ses-failed")
            await idle("ses-accepted")
            await waitForNativeState(async () => gets.length === 4, 6_000)
          })
          expect(contexts.length).toBe(2)

          // A newer native stamp reads that session's context again.
          updated.set("ses-accepted", 200)
          yield* Effect.promise(async () => {
            await idle("ses-accepted")
            await waitForNativeState(async () => contexts.length === 3, 6_000)
          })
          expect(contexts.filter((id) => id === "ses-accepted").length).toBe(2)
        }),
      ),
    )
  } finally {
    fixture.close()
  }
})

test("reconstruction pages the host by cursor: unchanged stamps read nothing, a changed one reads only the new page", async () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const history = Array.from({ length: 120 }, (_, index) => ({
      id: `msg-${String(index).padStart(3, "0")}`,
      type: "user",
      text: `step ${index}`,
    }))
    const updated = new Map([["ses-accepted", 100]])
    let gets = 0
    const ctx = makeContext(fixture, {
      liveEvents: true,
      messages: history,
      readSession: (sessionID) => {
        gets++
        return Effect.succeed({
          id: sessionID,
          projectID: "project",
          agent: "lazers-implementor",
          location: { directory: fixture.directory },
          time: { updated: updated.get(sessionID) ?? 100 },
        })
      },
    })
    const idle = () => ctx.emitEvent(executionEvent("session.idle", "ses-accepted", 1))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(ctx.context, recorder, "project")
          // Boot: the 120-message history is read once, as three pages of at most 50.
          yield* Effect.promise(() =>
            waitForNativeState(async () => recorder.sessionStamp(secondAttemptID) !== undefined),
          )
          const afterBoot = ctx.listCalls.length
          expect(ctx.listCalls.every((call) => (call.limit ?? 0) <= 50)).toBe(true)
          expect(afterBoot).toBeGreaterThanOrEqual(3)

          // Idle events with an unchanged stamp: no message read of any kind.
          const readsBefore = gets
          yield* Effect.promise(async () => {
            await idle()
            await idle()
            await waitForNativeState(async () => gets >= readsBefore + 1, 6_000)
          })
          expect(ctx.listCalls.length).toBe(afterBoot)

          // A moved stamp reads the tail page only, not the first 100 messages.
          ctx.messages.push({ id: "msg-120", type: "user", text: "step 120" })
          updated.set("ses-accepted", 200)
          yield* Effect.promise(async () => {
            await idle()
            await waitForNativeState(
              async () => recorder.sessionStamp(secondAttemptID)?.updated === 200,
              6_000,
            )
          })
          expect(ctx.listCalls.length - afterBoot).toBe(1)
          expect(ctx.listCalls.at(-1)?.cursor).toBe("100")
          expect(ctx.wholeConversationReads()).toBe(0)
        }),
      ),
    )
  } finally {
    fixture.close()
  }
})

test("plugin copies of one project share one native event subscription and promote on leave", async () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const copies = [0, 1, 2].map(() => makeContext(fixture, { holdEvents: true }))
    await Effect.runPromise(
      Effect.gen(function* () {
        const scopes = yield* Effect.all(copies.map(() => Scope.make()))
        for (const [index, copy] of copies.entries())
          yield* registerProgress(copy.context, recorder, "project").pipe(
            Scope.provide(scopes[index]!),
          )
        yield* Effect.promise(() =>
          waitForNativeState(
            async () => copies.reduce((sum, c) => sum + c.subscriptions(), 0) >= 1,
          ),
        )
        yield* Effect.sleep(50)
        // Three copies, one subscriber: the first to join leads.
        expect(copies.map((copy) => copy.subscriptions())).toEqual([1, 0, 0])

        // The leader leaves: exactly one other copy takes the subscription over.
        yield* Scope.close(scopes[0]!, Exit.void)
        yield* Effect.promise(() =>
          waitForNativeState(
            async () => copies[1]!.subscriptions() + copies[2]!.subscriptions() === 1,
          ),
        )
        yield* Scope.close(scopes[1]!, Exit.void)
        yield* Scope.close(scopes[2]!, Exit.void)
      }),
    )
  } finally {
    fixture.close()
  }
})
