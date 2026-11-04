import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { DateTime, Effect, Fiber, Queue, Stream } from "effect"
import { firstAttemptID, makeFixture, secondAttemptID } from "../../test/trajectory/fixture.ts"
import { nativeLivenessFixture as makeNativeLivenessFixture } from "../../test/runner-native-liveness/fixture.ts"
import { NativeIdleStore } from "../runner/native-idle.ts"
import { RunnerStore } from "../runner/store.ts"
import { TaskRepository } from "../storage.ts"
import { ProgressRecorder } from "./recorder.ts"
import { progressReconstructionDiagnostics } from "./reconstruction.ts"
import { registerProgress } from "./native.ts"

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
  let idleHook: ((idle: never) => Effect.Effect<void>) | undefined
  let syntheticCalls = 0
  let subscriptionCount = 0
  const eventQueue = Effect.runSync(Queue.unbounded<unknown>())
  const streamFailure = Symbol("fixture-stream-failure")
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
      context: ({ sessionID }: { sessionID: string }) =>
        options.readContext?.(sessionID) ?? Effect.succeed(messages),
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
  return {
    context,
    tools,
    after: () => afterHook,
    idle: () => idleHook,
    syntheticCalls: () => syntheticCalls,
    subscriptions: () => subscriptionCount,
    syntheticInputs: () => syntheticInputs,
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
  }
}

function nativeLivenessFixture(
  fixture: ReturnType<typeof makeFixture>,
  options: Parameters<typeof makeNativeLivenessFixture>[0] = {},
) {
  const native = makeNativeLivenessFixture(options)
  const originalSession = native.host.session.bind(native.host)
  const host = {
    ...native.host,
    session: async (sessionID: string, sessionOptions?: { messages?: boolean }) => {
      const session = await originalSession(sessionID, sessionOptions)
      if (!session) return null
      return { ...session, background: nativeIdleBackground(fixture, sessionID) }
    },
  }
  return { ...native, host }
}

function executionEvent(type: string, sessionID: string, sequence: number) {
  return {
    id: `evt_${sequence}`,
    created: sequence,
    type,
    durable: { aggregateID: sessionID, seq: sequence, version: 1 },
    data: { sessionID },
  }
}

function inboxEvent(type: string, sessionID: string, sequence: number, inboxID: string) {
  return {
    id: `evt_${sequence}`,
    created: sequence,
    type,
    durable: { aggregateID: sessionID, seq: sequence, version: 1 },
    data: { sessionID, inboxID },
  }
}

function syntheticEvent(sessionID: string, sequence: number) {
  return {
    id: `evt_${sequence}`,
    created: sequence,
    type: "session.synthetic",
    durable: { aggregateID: sessionID, seq: sequence, version: 1 },
    data: { sessionID, text: "Continue after queued input" },
  }
}

function nativeIdleBinding(fixture: ReturnType<typeof makeFixture>, sessionID: string) {
  const assignment = new ProgressRecorder(fixture.store, "project").assignmentForSession(sessionID)
  if (!assignment) return undefined
  return {
    projectDirectory: fixture.repository.projectDirectory,
    projectID: assignment.projectID,
    attemptID: assignment.attemptID,
    sessionID: assignment.sessionID,
    workspace: assignment.workspace,
    assignedMessageID: assignment.assignedMessageID,
  }
}

function nativeIdleBackground(fixture: ReturnType<typeof makeFixture>, sessionID = "ses-accepted") {
  const store = new NativeIdleStore(fixture.repository)
  const binding = nativeIdleBinding(fixture, sessionID)
  return binding
    ? store.background(binding)
    : {
        state: "unknown" as const,
        source: "experimental.idle" as const,
        reason: "No assigned native attempt",
      }
}

function nativeObservations(fixture: ReturnType<typeof makeFixture>, sessionID: string) {
  return fixture.repository.atomic((db) =>
    db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM runner_progress WHERE session_id=? AND kind='native-observation' ORDER BY seq",
      )
      .all(sessionID)
      .map(({ payload }) => JSON.parse(payload) as Record<string, unknown>),
  )
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

test("genuine zero-background hook and exact success survive listener disposal and SQLite reopen", async () => {
  const fixture = makeFixture()
  let reopenedRepository: TaskRepository | undefined
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const sessionID = "ses-accepted"
    const binding = nativeIdleBinding(fixture, sessionID)!
    const ctx = makeContext(fixture, {
      liveEvents: true,
      messages: [{ id: binding.assignedMessageID, type: "user" }],
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(ctx.context, recorder, "project")
          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.execution.started", sessionID, 700)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(async () => {
              const state = new NativeIdleStore(fixture.repository).read(binding)
              return state?.executionStartSequence === 700
            }),
          )
          yield* Effect.promise(() =>
            ctx.emitEvent(inboxEvent("session.inbox.delivered", sessionID, 701, "msg-inbox")),
          )
          yield* Effect.promise(() =>
            waitForNativeState(
              async () =>
                new NativeIdleStore(fixture.repository).read(binding)?.lastEventSequence === 701,
            ),
          )
          yield* ctx.idle()!({ sessionID: Session.ID.make(sessionID), background: [] } as never)
          expect(nativeIdleBackground(fixture, sessionID)).toMatchObject({
            state: "unknown",
            reason: "Zero-background idle report has no matching confirmed native success",
          })
          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.execution.succeeded", sessionID, 702)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(
              async () => nativeIdleBackground(fixture, sessionID).state === "observed",
            ),
          )
        }),
      ),
    )

    const retained = nativeIdleBackground(fixture, sessionID)
    expect(retained).toMatchObject({
      state: "observed",
      inputID: binding.assignedMessageID,
      executionStartSequence: 700,
      eventSequence: 701,
      observedAt: expect.any(Number),
      terminalSequence: 702,
      terminalEventID: "evt_702",
      terminalMessageID: "msg_702",
      attemptID: binding.attemptID,
      workspace: binding.workspace,
    })
    expect(ctx.syntheticCalls()).toBe(0)

    fixture.repository.close()
    reopenedRepository = new TaskRepository(
      fixture.repository.path,
      fixture.repository.projectDirectory,
    )
    expect(new NativeIdleStore(reopenedRepository).background(binding)).toEqual(retained)
  } finally {
    reopenedRepository?.close()
    fixture.close()
  }
})

test("fresh same-execution idle hook restores convergence after queued and synthetic input", async () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const sessionID = "ses-accepted"
    const binding = nativeIdleBinding(fixture, sessionID)!
    const messages: unknown[] = [{ id: binding.assignedMessageID, type: "user" }]
    const ctx = makeContext(fixture, { liveEvents: true, messages })
    const store = new NativeIdleStore(fixture.repository)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(ctx.context, recorder, "project")
          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.execution.started", sessionID, 900)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(async () => store.read(binding)?.executionStartSequence === 900),
          )
          yield* Effect.promise(() =>
            ctx.emitEvent(inboxEvent("session.inbox.delivered", sessionID, 901, "msg-current")),
          )
          yield* Effect.promise(() =>
            waitForNativeState(async () => store.read(binding)?.lastEventSequence === 901),
          )
          yield* ctx.idle()!({
            sessionID: Session.ID.make(sessionID),
            background: [{ kind: "shell" }],
          } as never)
          expect(store.read(binding)?.report).toMatchObject({
            inputID: binding.assignedMessageID,
            executionStartSequence: 900,
            eventSequence: 901,
            count: 1,
          })

          yield* Effect.promise(() =>
            ctx.emitEvent(inboxEvent("session.inbox.enqueued", sessionID, 902, "msg-next")),
          )
          yield* Effect.promise(() =>
            waitForNativeState(async () => store.read(binding)?.lastEventSequence === 902),
          )
          expect(nativeIdleBackground(fixture, sessionID).state).toBe("unknown")
          yield* Effect.promise(() => ctx.emitEvent(syntheticEvent(sessionID, 903)))
          messages.push({ id: "msg-next", type: "synthetic", text: "Continue after queued input" })
          yield* Effect.promise(() =>
            waitForNativeState(async () => store.read(binding)?.lastEventSequence === 903),
          )
          yield* ctx.idle()!({ sessionID: Session.ID.make(sessionID), background: [] } as never)
          expect(store.read(binding)?.report).toMatchObject({
            inputID: "msg-next",
            executionStartSequence: 900,
            eventSequence: 903,
            count: 0,
          })

          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.execution.succeeded", sessionID, 904)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(
              async () => nativeIdleBackground(fixture, sessionID).state === "observed",
            ),
          )
        }),
      ),
    )
    expect(nativeIdleBackground(fixture, sessionID)).toMatchObject({
      state: "observed",
      inputID: "msg-next",
      executionStartSequence: 900,
      eventSequence: 903,
      terminalSequence: 904,
      count: 0,
    })
  } finally {
    fixture.close()
  }
})

test("a same-input newer execution and delayed older success cannot resurrect zero background", async () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const sessionID = "ses-accepted"
    const binding = nativeIdleBinding(fixture, sessionID)!
    const ctx = makeContext(fixture, {
      liveEvents: true,
      messages: [{ id: binding.assignedMessageID, type: "user" }],
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(ctx.context, recorder, "project")
          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.execution.started", sessionID, 800)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(
              async () =>
                new NativeIdleStore(fixture.repository).read(binding)?.executionStartSequence ===
                800,
            ),
          )
          yield* ctx.idle()!({ sessionID: Session.ID.make(sessionID), background: [] } as never)
          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.execution.succeeded", sessionID, 801)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(
              async () => nativeIdleBackground(fixture, sessionID).state === "observed",
            ),
          )
          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.execution.started", sessionID, 802)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(async () => {
              const current = nativeIdleBackground(fixture, sessionID)
              return (
                current.state === "unknown" &&
                current.reason.includes("foreground execution started")
              )
            }),
          )
          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.execution.succeeded", sessionID, 801)),
          )
          yield* Effect.sleep(5)
          expect(nativeIdleBackground(fixture, sessionID)).toMatchObject({
            state: "unknown",
            reason:
              "A newer native foreground execution started after the last experimental.idle report",
          })
        }),
      ),
    )
  } finally {
    fixture.close()
  }
})

test("a received live duplicate start establishes owning-listener lineage and survives reopen", async () => {
  const fixture = makeFixture()
  let reopenedRepository: TaskRepository | undefined
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const sessionID = "ses-accepted"
    const binding = nativeIdleBinding(fixture, sessionID)!
    const messages: unknown[] = [{ id: binding.assignedMessageID, type: "user" }]
    const persisting = makeContext(fixture, { liveEvents: true, messages })
    const owning = makeContext(fixture, { liveEvents: true, messages })
    const store = new NativeIdleStore(fixture.repository)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(persisting.context, recorder, "project")
          yield* registerProgress(owning.context, recorder, "project")
          yield* Effect.promise(() =>
            persisting.emitEvent(executionEvent("session.execution.started", sessionID, 700)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(
              async () =>
                nativeObservations(fixture, sessionID).some(
                  (row) => row.phase === "event-changed" && row.eventSequence === 700,
                ) && store.read(binding)?.executionStartSequence === 700,
            ),
          )

          yield* Effect.promise(() =>
            owning.emitEvent(executionEvent("session.execution.started", sessionID, 700)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(async () =>
              nativeObservations(fixture, sessionID).some(
                (row) => row.phase === "event-seen" && row.eventSequence === 700,
              ),
            ),
          )
          const startObservations = nativeObservations(fixture, sessionID).filter(
            (row) => row.eventSequence === 700,
          )
          const changed = startObservations.find((row) => row.phase === "event-changed")
          const seen = startObservations.find((row) => row.phase === "event-seen")
          expect(changed).toBeDefined()
          expect(seen).toBeDefined()
          expect(seen?.listenerID).not.toBe(changed?.listenerID)
          yield* owning.idle()!({ sessionID: Session.ID.make(sessionID), background: [] } as never)
          expect(store.read(binding)?.report).toMatchObject({
            inputID: binding.assignedMessageID,
            executionStartSequence: 700,
            eventSequence: 700,
            count: 0,
          })

          yield* Effect.promise(() =>
            owning.emitEvent(executionEvent("session.execution.succeeded", sessionID, 701)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(
              async () => nativeIdleBackground(fixture, sessionID).state === "observed",
            ),
          )
        }),
      ),
    )

    const retained = nativeIdleBackground(fixture, sessionID)
    expect(retained).toMatchObject({
      state: "observed",
      inputID: binding.assignedMessageID,
      executionStartSequence: 700,
      eventSequence: 700,
      count: 0,
      terminalSequence: 701,
      terminalEventID: "evt_701",
      terminalMessageID: "msg_701",
    })
    expect(persisting.syntheticCalls() + owning.syntheticCalls()).toBe(0)

    fixture.repository.close()
    reopenedRepository = new TaskRepository(
      fixture.repository.path,
      fixture.repository.projectDirectory,
    )
    expect(new NativeIdleStore(reopenedRepository).background(binding)).toEqual(retained)
  } finally {
    reopenedRepository?.close()
    fixture.close()
  }
})

test("independent listeners and disposal preserve only confirmed durable idle evidence", async () => {
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
    const firstNative = nativeLivenessFixture(fixture, {
      sessionID: "ses-accepted",
      directory: fixture.directory,
    })
    const secondNative = nativeLivenessFixture(fixture, {
      sessionID: "ses-accepted",
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
          expect(nativeIdleBackground(fixture)).toMatchObject({
            state: "unknown",
            reason: "Zero-background idle report has no matching confirmed native success",
          })
          yield* Effect.promise(() =>
            first.emitEvent(executionEvent("session.execution.succeeded", "ses-accepted", 11)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(async () => nativeIdleBackground(fixture).state === "observed"),
          )
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* registerProgress(second.context, recorder, "project")
              expect(
                (yield* Effect.promise(() => firstNative.host.session("ses-accepted")))?.background
                  ?.state,
              ).toBe("observed")
              yield* second.idle()!({ sessionID: "ses-accepted", background: [] } as never)
              expect(
                (yield* Effect.promise(() => secondNative.host.session("ses-accepted")))
                  ?.background,
              ).toMatchObject({ state: "observed", terminalSequence: 11 })
              expect(second.syntheticCalls()).toBe(0)
              yield* Effect.promise(() => second.failEvents())
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
            waitForNativeState(async () =>
              fixture.store.progressFacts([secondAttemptID]).some((row) => row.kind === "gap"),
            ),
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
      state: "observed",
      terminalSequence: 11,
    })
  } finally {
    fixture.close()
  }
})

test.each(["msg_initial", "msg_resumed"])(
  "same-process listener replacement cannot invent current execution lineage for %s",
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
      const native = nativeLivenessFixture(fixture, {
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
            ).toMatchObject({ state: "unknown" })
            yield* Effect.promise(() =>
              next.emitEvent(executionEvent("session.execution.succeeded", "ses-accepted", 21)),
            )
            yield* Effect.sleep(5)
            expect(
              (yield* Effect.promise(() => native.host.session("ses-accepted")))?.background,
            ).toMatchObject({ state: "unknown" })
          }),
        ),
      )
      expect(next.syntheticCalls()).toBe(0)
    } finally {
      fixture.close()
    }
  },
)

test("a replacement stream gap before its first event invalidates inherited execution identity", async () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const messages = [
      { id: "msg_current", type: "user" },
      { id: "msg_reply", type: "assistant", content: [{ type: "text", text: "Done." }] },
    ]
    const old = makeContext(fixture, { liveEvents: true, messages })
    const next = makeContext(fixture, { liveEvents: true, messages })
    const native = nativeLivenessFixture(fixture, {
      sessionID: "ses-accepted",
      directory: fixture.directory,
    })
    const gap = Promise.withResolvers<void>()
    const original = recorder.markRecoveryGap.bind(recorder)
    recorder.markRecoveryGap = (...args) => {
      const result = original(...args)
      if (args[2] === "event-stream") gap.resolve()
      return result
    }
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
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(next.context, recorder, "project")
          yield* Effect.promise(() => next.failEvents())
          yield* Effect.promise(() => gap.promise)
          yield* Effect.promise(() =>
            next.emitEvent(executionEvent("session.execution.started", "ses-accepted", 20)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(
              async () =>
                nativeObservations(fixture, "ses-accepted").some(
                  (row) => row.phase === "event-seen" && row.eventSequence === 20,
                ),
              4_000,
            ),
          )
          yield* next.idle()!({ sessionID: "ses-accepted", background: [] } as never)
          expect(
            (yield* Effect.promise(() => native.host.session("ses-accepted")))?.background?.state,
          ).toBe("unknown")
          expect(
            new NativeIdleStore(fixture.repository).read(
              nativeIdleBinding(fixture, "ses-accepted")!,
            )?.report,
          ).toBeNull()
          yield* Effect.promise(() =>
            next.emitEvent(executionEvent("session.execution.succeeded", "ses-accepted", 21)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(async () => {
              const state = new NativeIdleStore(fixture.repository).read(
                nativeIdleBinding(fixture, "ses-accepted")!,
              )
              return state?.lastEventSequence === 21 && state.invalidation !== null
            }),
          )
          expect(nativeIdleBackground(fixture).state).toBe("unknown")
          yield* Effect.promise(() =>
            next.emitEvent(executionEvent("session.execution.started", "ses-accepted", 22)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(
              async () =>
                new NativeIdleStore(fixture.repository).read(
                  nativeIdleBinding(fixture, "ses-accepted")!,
                )?.executionStartSequence === 22,
            ),
          )
          yield* next.idle()!({ sessionID: "ses-accepted", background: [] } as never)
          yield* Effect.promise(() =>
            next.emitEvent(executionEvent("session.execution.succeeded", "ses-accepted", 23)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(async () => nativeIdleBackground(fixture).state === "observed"),
          )
          expect(nativeIdleBackground(fixture)).toMatchObject({
            state: "observed",
            executionStartSequence: 22,
            terminalSequence: 23,
          })
        }),
      ),
    )
  } finally {
    fixture.close()
  }
})

test("failed durable event observation prevents late idle input from confirming an old start", async () => {
  const fixture = makeFixture()
  const originalObserveEvent = NativeIdleStore.prototype.observeEvent
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const sessionID = "ses-accepted"
    const binding = nativeIdleBinding(fixture, sessionID)!
    const messages: unknown[] = [{ id: binding.assignedMessageID, type: "user" }]
    const ctx = makeContext(fixture, { liveEvents: true, messages })
    const barrier = Promise.withResolvers<void>()
    const recordNativeEvent = recorder.recordNativeEvent.bind(recorder)
    let failNextInputEvent = false
    recorder.recordNativeEvent = (event) => {
      const saved = recordNativeEvent(event)
      if (testObject(event)?.id === "evt_812") barrier.resolve()
      return saved
    }
    NativeIdleStore.prototype.observeEvent = function (
      currentBinding,
      type,
      sequence,
      eventID,
      messageID,
    ) {
      if (failNextInputEvent && type === "session.inbox.delivered") {
        failNextInputEvent = false
        throw new Error("Injected native idle persistence failure")
      }
      return originalObserveEvent.call(this, currentBinding, type, sequence, eventID, messageID)
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(ctx.context, recorder, "project")
          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.execution.started", sessionID, 810)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(
              async () =>
                new NativeIdleStore(fixture.repository).read(binding)?.executionStartSequence ===
                810,
            ),
          )

          messages.push({ id: "msg-next", type: "synthetic", text: "Continue with new input" })
          failNextInputEvent = true
          yield* Effect.promise(() =>
            ctx.emitEvent(inboxEvent("session.inbox.delivered", sessionID, 811, "msg-next")),
          )
          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.step.started", sessionID, 812)),
          )
          yield* Effect.promise(() => barrier.promise)

          yield* ctx.idle()!({ sessionID: Session.ID.make(sessionID), background: [] } as never)
          expect(new NativeIdleStore(fixture.repository).read(binding)?.report).toBeNull()
          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.execution.succeeded", sessionID, 813)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(async () => {
              const state = new NativeIdleStore(fixture.repository).read(binding)
              return state?.lastEventSequence === 813 && state.report === null
            }),
          )
          expect(nativeIdleBackground(fixture, sessionID).state).toBe("unknown")
        }),
      ),
    )
  } finally {
    NativeIdleStore.prototype.observeEvent = originalObserveEvent
    fixture.close()
  }
})

test("failed newer start persistence cannot confirm an earlier zero report with later success", async () => {
  const fixture = makeFixture()
  let reopenedRepository: TaskRepository | undefined
  const originalObserveEvent = NativeIdleStore.prototype.observeEvent
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const sessionID = "ses-accepted"
    const binding = nativeIdleBinding(fixture, sessionID)!
    const ctx = makeContext(fixture, {
      liveEvents: true,
      messages: [{ id: binding.assignedMessageID, type: "user" }],
    })
    const failedStart = Promise.withResolvers<void>()
    const terminalProcessed = Promise.withResolvers<void>()
    const recordNativeEvent = recorder.recordNativeEvent.bind(recorder)
    recorder.recordNativeEvent = (event) => {
      const saved = recordNativeEvent(event)
      if (testObject(event)?.id === "evt_812") terminalProcessed.resolve()
      return saved
    }
    let failNextStart = false
    NativeIdleStore.prototype.observeEvent = function (
      currentBinding,
      type,
      sequence,
      eventID,
      messageID,
    ) {
      if (failNextStart && type === "session.execution.started") {
        failNextStart = false
        failedStart.resolve()
        throw new Error("Injected newer-start persistence failure")
      }
      return originalObserveEvent.call(this, currentBinding, type, sequence, eventID, messageID)
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(ctx.context, recorder, "project")
          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.execution.started", sessionID, 810)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(
              async () =>
                new NativeIdleStore(fixture.repository).read(binding)?.executionStartSequence ===
                810,
            ),
          )
          yield* ctx.idle()!({ sessionID: Session.ID.make(sessionID), background: [] } as never)
          expect(new NativeIdleStore(fixture.repository).read(binding)?.report).toMatchObject({
            inputID: binding.assignedMessageID,
            executionStartSequence: 810,
            eventSequence: 810,
            count: 0,
          })

          failNextStart = true
          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.execution.started", sessionID, 811)),
          )
          yield* Effect.promise(() => failedStart.promise)
          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.execution.succeeded", sessionID, 812)),
          )
          yield* Effect.promise(() => terminalProcessed.promise)

          const state = new NativeIdleStore(fixture.repository).read(binding)
          expect(state?.report).toMatchObject({ executionStartSequence: 810, eventSequence: 810 })
          expect(state?.pendingTerminal).toEqual({
            sequence: 812,
            eventID: "evt_812",
            messageID: "msg_812",
          })
          expect(state?.terminal).toBeNull()
          expect(nativeIdleBackground(fixture, sessionID)).toMatchObject({ state: "unknown" })
        }),
      ),
    )

    fixture.repository.close()
    reopenedRepository = new TaskRepository(
      fixture.repository.path,
      fixture.repository.projectDirectory,
    )
    expect(new NativeIdleStore(reopenedRepository).background(binding)).toMatchObject({
      state: "unknown",
    })
  } finally {
    NativeIdleStore.prototype.observeEvent = originalObserveEvent
    reopenedRepository?.close()
    fixture.close()
  }
})

test("a stale second-listener start cannot confirm an older zero after a failed newer start", async () => {
  const fixture = makeFixture()
  let reopenedRepository: TaskRepository | undefined
  const originalObserveEvent = NativeIdleStore.prototype.observeEvent
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const sessionID = "ses-accepted"
    const binding = nativeIdleBinding(fixture, sessionID)!
    const messages: unknown[] = [{ id: binding.assignedMessageID, type: "user" }]
    const first = makeContext(fixture, { liveEvents: true, messages })
    const second = makeContext(fixture, { liveEvents: true, messages })
    const store = new NativeIdleStore(fixture.repository)
    const firstSuccessProcessed = Promise.withResolvers<void>()
    const secondSuccessProcessed = Promise.withResolvers<void>()
    const recordNativeEvent = recorder.recordNativeEvent.bind(recorder)
    let successCount = 0
    recorder.recordNativeEvent = (event) => {
      const saved = recordNativeEvent(event)
      if (testObject(event)?.id === "evt_23") {
        successCount++
        if (successCount === 1) firstSuccessProcessed.resolve()
        if (successCount === 2) secondSuccessProcessed.resolve()
      }
      return saved
    }
    const failedStart = Promise.withResolvers<void>()
    let failNextStart = false
    NativeIdleStore.prototype.observeEvent = function (
      currentBinding,
      type,
      sequence,
      eventID,
      messageID,
    ) {
      if (failNextStart && type === "session.execution.started" && sequence === 22) {
        failNextStart = false
        failedStart.resolve()
        throw new Error("Injected newer-start persistence failure")
      }
      return originalObserveEvent.call(this, currentBinding, type, sequence, eventID, messageID)
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(first.context, recorder, "project")
          yield* registerProgress(second.context, recorder, "project")
          yield* Effect.promise(() =>
            first.emitEvent(executionEvent("session.execution.started", sessionID, 20)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(async () => store.read(binding)?.executionStartSequence === 20),
          )
          yield* Effect.promise(() =>
            second.emitEvent(executionEvent("session.execution.started", sessionID, 20)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(async () =>
              nativeObservations(fixture, sessionID).some(
                (row) => row.phase === "event-seen" && row.eventSequence === 20,
              ),
            ),
          )
          yield* first.idle()!({ sessionID: Session.ID.make(sessionID), background: [] } as never)
          expect(store.read(binding)?.report).toMatchObject({
            executionStartSequence: 20,
            eventSequence: 20,
            inputID: binding.assignedMessageID,
            count: 0,
          })

          failNextStart = true
          yield* Effect.promise(() =>
            first.emitEvent(executionEvent("session.execution.started", sessionID, 22)),
          )
          yield* Effect.promise(() => failedStart.promise)
          yield* Effect.promise(() =>
            first.emitEvent(executionEvent("session.execution.succeeded", sessionID, 23)),
          )
          yield* Effect.promise(() => firstSuccessProcessed.promise)
          expect(store.read(binding)?.pendingTerminal?.sequence).toBe(23)
          expect(nativeIdleBackground(fixture, sessionID).state).toBe("unknown")

          // The second listener sees B before its success, but only after L1 moved the shared watermark.
          const staleCount = nativeObservations(fixture, sessionID).filter(
            (row) => row.phase === "event-stale" && row.eventSequence === 22,
          ).length
          yield* Effect.promise(() =>
            second.emitEvent(executionEvent("session.execution.started", sessionID, 22)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(
              async () =>
                nativeObservations(fixture, sessionID).filter(
                  (row) => row.phase === "event-stale" && row.eventSequence === 22,
                ).length > staleCount,
            ),
          )
          yield* Effect.promise(() =>
            second.emitEvent(executionEvent("session.execution.succeeded", sessionID, 23)),
          )
          yield* Effect.promise(() => secondSuccessProcessed.promise)

          expect(store.read(binding)?.report).toMatchObject({
            executionStartSequence: 20,
            eventSequence: 20,
          })
          expect(store.read(binding)?.pendingTerminal?.sequence).toBe(23)
          expect(store.read(binding)?.terminal).toBeNull()
          expect(nativeIdleBackground(fixture, sessionID).state).toBe("unknown")
        }),
      ),
    )

    fixture.repository.close()
    reopenedRepository = new TaskRepository(
      fixture.repository.path,
      fixture.repository.projectDirectory,
    )
    expect(new NativeIdleStore(reopenedRepository).background(binding)).toMatchObject({
      state: "unknown",
    })
  } finally {
    NativeIdleStore.prototype.observeEvent = originalObserveEvent
    reopenedRepository?.close()
    fixture.close()
  }
})

test.each([
  "stream-loss-read",
  "stream-loss-first-reconnect-read-fails",
  "unsequenced-event-reconnect",
  "unsequenced-event-continuing",
] as const)(
  "%s recovers from an unknown lineage barrier only at a finite live-start boundary",
  async (failureMode) => {
    const fixture = makeFixture()
    let reopenedRepository: TaskRepository | undefined
    const originalRead = NativeIdleStore.prototype.read
    const originalObserveEvent = NativeIdleStore.prototype.observeEvent
    try {
      const recorder = new ProgressRecorder(fixture.store, "project")
      const sessionID = "ses-accepted"
      const binding = nativeIdleBinding(fixture, sessionID)!
      const messages: unknown[] = [{ id: binding.assignedMessageID, type: "user" }]
      const persisting = makeContext(fixture, { liveEvents: true, messages })
      const owning = makeContext(fixture, { liveEvents: true, messages })
      const store = new NativeIdleStore(fixture.repository)
      const streamGap = Promise.withResolvers<void>()
      const failureInjected = Promise.withResolvers<void>()
      const firstGapReadFailure = Promise.withResolvers<void>()
      const secondGapReadFailure = Promise.withResolvers<void>()
      const originalMarkRecoveryGap = recorder.markRecoveryGap.bind(recorder)
      let remainingGapReadFailures = 0
      let gapReadFailureCount = 0
      let failNextUnsequencedWrite = false
      recorder.markRecoveryGap = (...args) => {
        const result = originalMarkRecoveryGap(...args)
        if (args[2] === "event-stream") streamGap.resolve()
        return result
      }
      NativeIdleStore.prototype.read = function (currentBinding) {
        if (remainingGapReadFailures > 0 && currentBinding.sessionID === sessionID) {
          const failureNumber = ++gapReadFailureCount
          remainingGapReadFailures--
          if (failureNumber === 1) firstGapReadFailure.resolve()
          if (failureNumber === 2) secondGapReadFailure.resolve()
          throw new Error("Injected idle-row read failure at stream loss")
        }
        return originalRead.call(this, currentBinding)
      }
      NativeIdleStore.prototype.observeEvent = function (
        currentBinding,
        type,
        sequence,
        eventID,
        messageID,
      ) {
        if (
          failNextUnsequencedWrite &&
          type === "session.inbox.delivered" &&
          sequence === undefined
        ) {
          failNextUnsequencedWrite = false
          failureInjected.resolve()
          throw new Error("Injected unsequenced idle-event persistence failure")
        }
        return originalObserveEvent.call(this, currentBinding, type, sequence, eventID, messageID)
      }

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* registerProgress(persisting.context, recorder, "project")
            yield* registerProgress(owning.context, recorder, "project")
            yield* Effect.promise(() =>
              persisting.emitEvent(executionEvent("session.execution.started", sessionID, 20)),
            )
            yield* Effect.promise(() =>
              waitForNativeState(
                async () =>
                  nativeObservations(fixture, sessionID).some(
                    (row) => row.phase === "event-changed" && row.eventSequence === 20,
                  ) && store.read(binding)?.executionStartSequence === 20,
              ),
            )
            yield* Effect.promise(() =>
              owning.emitEvent(executionEvent("session.execution.started", sessionID, 20)),
            )
            yield* Effect.promise(() =>
              waitForNativeState(async () =>
                nativeObservations(fixture, sessionID).some(
                  (row) => row.phase === "event-seen" && row.eventSequence === 20,
                ),
              ),
            )
            yield* owning.idle()!({
              sessionID: Session.ID.make(sessionID),
              background: [],
            } as never)
            expect(store.read(binding)?.report).toMatchObject({
              executionStartSequence: 20,
              eventSequence: 20,
              inputID: binding.assignedMessageID,
              count: 0,
            })

            if (failureMode === "stream-loss-read") {
              remainingGapReadFailures = 1
            } else if (failureMode === "stream-loss-first-reconnect-read-fails") {
              remainingGapReadFailures = 2
            } else {
              failNextUnsequencedWrite = true
              yield* Effect.promise(() =>
                owning.emitEvent({
                  id: "evt_unsequenced",
                  type: "session.inbox.delivered",
                  durable: { aggregateID: sessionID, seq: "unavailable", version: 1 },
                  data: { sessionID, inboxID: "msg-next" },
                }),
              )
              yield* Effect.promise(() => failureInjected.promise)
            }
            if (failureMode !== "unsequenced-event-continuing") {
              yield* Effect.promise(() => owning.failEvents())
              yield* Effect.promise(() => streamGap.promise)
              if (failureMode === "stream-loss-read") {
                yield* Effect.promise(() => firstGapReadFailure.promise)
              } else if (failureMode === "stream-loss-first-reconnect-read-fails") {
                yield* Effect.promise(() => firstGapReadFailure.promise)
                yield* Effect.promise(() => secondGapReadFailure.promise)
                // A later stream boundary can recover the still-unknown cutoff.
                yield* Effect.promise(() => owning.failEvents())
                yield* Effect.promise(() =>
                  waitForNativeState(async () => owning.subscriptions() >= 3, 5_000),
                )
              }
              yield* Effect.promise(() =>
                waitForNativeState(async () => owning.subscriptions() >= 2, 5_000),
              )
            } else {
              expect(owning.subscriptions()).toBe(1)
            }

            // This finite, durably observed event is a recovery cutoff, not start lineage.
            yield* Effect.promise(() =>
              owning.emitEvent(inboxEvent("session.inbox.delivered", sessionID, 21, "msg-next")),
            )
            yield* Effect.promise(() =>
              waitForNativeState(async () => store.read(binding)?.lastEventSequence === 21),
            )

            const reportBeforeOldStart = store.read(binding)?.report
            const oldStartStaleCount = nativeObservations(fixture, sessionID).filter(
              (row) => row.phase === "event-stale" && row.eventSequence === 20,
            ).length
            yield* Effect.promise(() =>
              owning.emitEvent(executionEvent("session.execution.started", sessionID, 20)),
            )
            yield* Effect.promise(() =>
              waitForNativeState(
                async () =>
                  nativeObservations(fixture, sessionID).filter(
                    (row) => row.phase === "event-stale" && row.eventSequence === 20,
                  ).length > oldStartStaleCount,
              ),
            )
            yield* owning.idle()!({
              sessionID: Session.ID.make(sessionID),
              background: [],
            } as never)
            expect(store.read(binding)?.report).toEqual(reportBeforeOldStart)

            // A different listener persists the fresh start first; the owner then sees it as `seen`.
            yield* Effect.promise(() =>
              persisting.emitEvent(executionEvent("session.execution.started", sessionID, 22)),
            )
            yield* Effect.promise(() =>
              waitForNativeState(async () => store.read(binding)?.executionStartSequence === 22),
            )
            yield* Effect.promise(() =>
              owning.emitEvent(executionEvent("session.execution.started", sessionID, 22)),
            )
            yield* Effect.promise(() =>
              waitForNativeState(async () =>
                nativeObservations(fixture, sessionID).some(
                  (row) => row.phase === "event-seen" && row.eventSequence === 22,
                ),
              ),
            )
            yield* owning.idle()!({
              sessionID: Session.ID.make(sessionID),
              background: [],
            } as never)
            expect(store.read(binding)?.report).toMatchObject({
              executionStartSequence: 22,
              eventSequence: 22,
              inputID: binding.assignedMessageID,
              count: 0,
            })
            yield* Effect.promise(() =>
              owning.emitEvent(executionEvent("session.execution.succeeded", sessionID, 23)),
            )
            yield* Effect.promise(() =>
              waitForNativeState(async () => {
                const state = store.read(binding)
                return state?.terminal?.sequence === 23
              }),
            )
          }),
        ),
      )

      const retained = nativeIdleBackground(fixture, sessionID)
      expect(retained).toMatchObject({
        state: "observed",
        executionStartSequence: 22,
        eventSequence: 22,
        inputID: binding.assignedMessageID,
        terminalSequence: 23,
        count: 0,
      })
      fixture.repository.close()
      reopenedRepository = new TaskRepository(
        fixture.repository.path,
        fixture.repository.projectDirectory,
      )
      expect(new NativeIdleStore(reopenedRepository).background(binding)).toEqual(retained)
    } finally {
      NativeIdleStore.prototype.read = originalRead
      NativeIdleStore.prototype.observeEvent = originalObserveEvent
      reopenedRepository?.close()
      fixture.close()
    }
  },
)

test("a delayed old idle callback cannot overwrite a newer confirmed same-session report", async () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const oldMessages: unknown[] = [{ id: "msg_old_input", type: "user" }]
    const newMessages: unknown[] = [{ id: "msg_new_input", type: "user" }]
    const entered = Promise.withResolvers<void>()
    const released = Promise.withResolvers<unknown[]>()
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
    const ready = Promise.withResolvers<void>()
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
              const state = new NativeIdleStore(fixture.repository).read(
                nativeIdleBinding(fixture, "ses-accepted")!,
              )
              return state?.executionStartSequence === 20
            }),
          )

          suspend = true
          const delayedIdle = yield* Effect.forkScoped(
            old.idle()!({ sessionID: "ses-accepted", background: [] } as never),
          )
          yield* Effect.promise(() => entered.promise)
          yield* registerProgress(next.context, recorder, "project")
          yield* Effect.promise(() =>
            next.emitEvent(executionEvent("session.execution.started", "ses-accepted", 40)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(async () => {
              const state = new NativeIdleStore(fixture.repository).read(
                nativeIdleBinding(fixture, "ses-accepted")!,
              )
              return state?.executionStartSequence === 40
            }),
          )
          yield* next.idle()!({ sessionID: "ses-accepted", background: [] } as never)
          expect(nativeIdleBackground(fixture)).toMatchObject({
            state: "unknown",
            reason: "Zero-background idle report has no matching confirmed native success",
          })
          expect(
            new NativeIdleStore(fixture.repository).read(
              nativeIdleBinding(fixture, "ses-accepted")!,
            )?.report,
          ).toMatchObject({ inputID: "msg_new_input", executionStartSequence: 40 })
          yield* Effect.promise(() =>
            next.emitEvent(executionEvent("session.execution.succeeded", "ses-accepted", 41)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(async () => {
              const background = nativeIdleBackground(fixture)
              return background.state === "observed" && background.terminalSequence === 41
            }),
          )

          released.resolve(oldMessages)
          yield* Fiber.join(delayedIdle)
          const confirmed = nativeIdleBackground(fixture)
          expect(confirmed).toMatchObject({
            state: "observed",
            inputID: "msg_new_input",
            executionStartSequence: 40,
            terminalSequence: 41,
            terminalMessageID: "msg_41",
          })
          yield* Fiber.interrupt(oldFiber)
        }),
      ),
    )
  } finally {
    fixture.close()
  }
})

test.each([
  "session.shell.started",
  "session.execution.started",
  "session.inbox.enqueued",
  "session.execution.failed",
])("queued older %s cannot regress the latest durable idle report", async (type) => {
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
    const native = nativeLivenessFixture(fixture, {
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
          expect(nativeIdleBackground(fixture)).toMatchObject({
            state: "unknown",
            reason: "Zero-background idle report has no matching confirmed native success",
          })
          const binding = nativeIdleBinding(fixture, "ses-accepted")!
          expect(new NativeIdleStore(fixture.repository).read(binding)?.report).toMatchObject({
            executionStartSequence: 40,
          })
          const stale = Promise.withResolvers<void>()
          processed.set(22, stale)
          yield* Effect.promise(() => old.emitEvent(executionEvent(type, "ses-accepted", 22)))
          yield* Effect.promise(() => stale.promise)
          expect(nativeIdleBackground(fixture)).toMatchObject({
            state: "unknown",
            reason: "Zero-background idle report has no matching confirmed native success",
          })
          expect(new NativeIdleStore(fixture.repository).read(binding)).toMatchObject({
            report: { executionStartSequence: 40 },
            staleEventSequence: 22,
          })
          const fresh = Promise.withResolvers<void>()
          processed.set(42, fresh)
          yield* Effect.promise(() =>
            old.emitEvent(executionEvent("session.execution.started", "ses-accepted", 42)),
          )
          yield* Effect.promise(() => fresh.promise)
          expect(
            (yield* Effect.promise(() => native.host.session("ses-accepted")))?.background,
          ).toMatchObject({
            state: "unknown",
            reason:
              "A newer native foreground execution started after the last experimental.idle report",
          })
        }),
      ),
    )
  } finally {
    fixture.close()
  }
})

test("idle producer failures retain safe diagnostics and never become terminal evidence", async () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const sessionID = "ses-accepted"
    const ctx = makeContext(fixture, {
      liveEvents: true,
      messages: [{ id: "msg_compacted", type: "compaction", status: "completed" }],
    })
    const readTrace = () =>
      fixture.store.atomic((db) =>
        db
          .query<{ at: number; payload: string }, [string]>(
            "SELECT at,payload FROM runner_progress WHERE session_id=? AND kind='native-observation' ORDER BY seq",
          )
          .all(sessionID),
      )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(ctx.context, recorder, "project", async () => {
            throw new Error("Input transport failed token=diagnostic-secret")
          })
          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.execution.started", sessionID, 600)),
          )
          yield* Effect.sleep(5)
          yield* ctx.idle()!({ sessionID: Session.ID.make(sessionID), background: [] } as never)
          yield* Effect.promise(() =>
            ctx.emitEvent(executionEvent("session.execution.succeeded", sessionID, 601)),
          )
          yield* Effect.promise(() =>
            waitForNativeState(async () =>
              readTrace().some((row) => JSON.parse(row.payload).phase === "event-changed"),
            ),
          )
          const rows = readTrace()
          expect(rows.map((row) => JSON.parse(row.payload).phase)).toEqual([
            "event-changed",
            "idle-entered",
            "idle-observation-failed",
            "event-changed",
          ])
          expect(rows.every((row) => Number.isSafeInteger(row.at) && row.at > 0)).toBe(true)
          expect(JSON.stringify(rows)).not.toContain("diagnostic-secret")
          expect(JSON.parse(rows[2]!.payload).error).toContain("Input transport failed")
          expect(JSON.parse(rows[1]!.payload)).toMatchObject({ executionStartSequence: 600 })
          expect(JSON.parse(rows[3]!.payload)).toMatchObject({ eventSequence: 601 })
          expect(JSON.parse(rows[3]!.payload).idleSequence).toBeUndefined()
        }),
      ),
    )
  } finally {
    fixture.close()
  }
})

test("registered idle and success retain compacted input identity and reject a changed retained input", async () => {
  for (const changedInput of [false, true]) {
    const fixture = makeFixture()
    try {
      const recorder = new ProgressRecorder(fixture.store, "project")
      const sessionID = "ses-accepted"
      const ctx = makeContext(fixture, {
        liveEvents: true,
        messages: [{ id: "msg_compacted", type: "compaction", status: "completed" }],
      })
      const native = nativeLivenessFixture(fixture, { sessionID, directory: fixture.directory })
      let inputID = "msg_retained_assignment"
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* registerProgress(ctx.context, recorder, "project", async () => inputID)
            yield* Effect.promise(() =>
              ctx.emitEvent(executionEvent("session.execution.started", sessionID, 200)),
            )
            yield* Effect.sleep(5)
            yield* ctx.idle()!({ sessionID: Session.ID.make(sessionID), background: [] } as never)
            expect(
              (yield* Effect.promise(() => native.host.session(sessionID)))?.background,
            ).toMatchObject({
              state: "unknown",
              reason: "Zero-background idle report has no matching confirmed native success",
            })
            expect(
              new NativeIdleStore(fixture.repository).read(nativeIdleBinding(fixture, sessionID)!)
                ?.report,
            ).toMatchObject({ inputID, count: 0 })
            if (changedInput) inputID = "msg_foreign_new_input"
            yield* Effect.promise(() =>
              ctx.emitEvent(executionEvent("session.execution.succeeded", sessionID, 201)),
            )
            yield* Effect.promise(() =>
              waitForNativeState(async () => {
                const background = (await native.host.session(sessionID))?.background
                return changedInput
                  ? background?.state === "unknown" && background.reason.includes("input lineage")
                  : background?.state === "observed" && background.terminalSequence === 201
              }),
            )
          }),
        ),
      )
    } finally {
      fixture.close()
    }
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
    const native = nativeLivenessFixture(fixture, { sessionID, directory: fixture.directory })

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
            state: "unknown",
            reason: "Zero-background idle report has no matching confirmed native success",
          })
          expect(
            new NativeIdleStore(fixture.repository).read(nativeIdleBinding(fixture, sessionID)!)
              ?.report,
          ).toMatchObject({
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
            state: "unknown",
            reason: "Zero-background idle report has no matching confirmed native success",
          })
          expect(
            new NativeIdleStore(fixture.repository).read(nativeIdleBinding(fixture, sessionID)!)
              ?.report,
          ).toMatchObject({
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
              return (
                new NativeIdleStore(fixture.repository).read(nativeIdleBinding(fixture, sessionID)!)
                  ?.staleEventSequence === 21
              )
            }),
          )
          const afterDelayedSuccess = yield* Effect.promise(() => native.host.session(sessionID))
          expect(afterDelayedSuccess?.background).toMatchObject({ state: "unknown" })
          expect(
            new NativeIdleStore(fixture.repository).read(nativeIdleBinding(fixture, sessionID)!),
          ).toMatchObject({
            report: {
              inputID: "msg_turn_new",
              executionStartSequence: 22,
              eventSequence: 22,
            },
            staleEventSequence: 21,
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
