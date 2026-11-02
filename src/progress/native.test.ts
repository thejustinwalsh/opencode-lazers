import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect, Stream } from "effect"
import { firstAttemptID, makeFixture, secondAttemptID } from "../../test/trajectory/fixture.ts"
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
    messages?: unknown[]
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
      context: () => Effect.succeed(options.messages ?? []),
      synthetic: (input: unknown) => {
        syntheticCalls++
        syntheticInputs.push(input)
        return options.synthetic?.(input) ?? Effect.succeed({ id: (input as { id?: unknown }).id })
      },
    },
    event: {
      subscribe: () => Stream.fromIterable(options.events ?? []),
    },
  } as unknown as Plugin.Context
  return {
    context,
    tools,
    after: () => afterHook,
    idle: () => idleHook,
    syntheticCalls: () => syntheticCalls,
    syntheticInputs: () => syntheticInputs,
  }
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
    await Effect.runPromise(Effect.scoped(registerProgress(ctx.context, recorder, "project")))
    const idle = ctx.idle()!
    await Promise.all([
      Effect.runPromise(
        idle({ sessionID: Session.ID.make("ses-accepted"), background: [] } as never),
      ),
      Effect.runPromise(
        idle({ sessionID: Session.ID.make("ses-accepted"), background: [] } as never),
      ),
    ])
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
