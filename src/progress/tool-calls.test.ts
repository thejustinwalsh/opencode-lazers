import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Cause, Effect, Exit } from "effect"
import { firstAttemptID, makeFixture } from "../../test/trajectory/fixture.ts"
import { ProgressRecorder } from "./recorder.ts"
import { TaskRepository } from "../storage.ts"
import { RunnerStore } from "../runner/store.ts"
import { registerToolCallWrappers, toolObservationScope } from "./tool-observation.ts"

function call(agent = "architect", sessionID = `ses-${agent}`, callID = "native-call") {
  return { agent, sessionID, callID, messageID: "msg_tool", tool: "shell" }
}

test("all observed agents retain canonical failures with truthful optional assignment and Unix observation time", () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const before = Date.now()
    for (const [agent, sessionID] of [
      ["lazers-implementor", "ses-failed"],
      ["auditor", "ses-accepted"],
      ["architect", "ses-architect"],
      ["researcher", "ses-research"],
      ["build", "ses-build"],
      ["lazers-implementor", "ses-unassigned"],
    ] as const) {
      const observed = call(agent, sessionID)
      recorder.recordToolBefore(observed)
      recorder.recordToolHook({
        ...observed,
        status: "error",
        error: new Tool.Error({
          message:
            "Invalid arguments for tool shell: command missing; token=sk-abcdefghijklmnopqrstuvwx",
          metadata: { reasoning: "private reasoning decoy", rawBody: "private input decoy" },
        }),
      })
      const records = recorder.toolCalls(sessionID)
      expect(records).toHaveLength(1)
      const row = records[0]!
      expect(row).toMatchObject({
        agent,
        tool: "shell",
        identity_kind: "native-call",
        native_call_id: observed.callID,
      })
      expect(row.first_observed_at).toBeGreaterThanOrEqual(before)
      expect(row.last_observed_at).toBeLessThanOrEqual(Date.now())
      const payload = JSON.parse(row.payload)
      expect(payload).toMatchObject({ agent, status: "failed" })
      expect(payload.timing).toBeUndefined()
      expect(payload.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "tool-hook.execute.after",
            unit: "unix-epoch-ms",
            at: expect.any(Number),
          }),
        ]),
      )
      expect(row.payload).not.toContain("sk-abcdefghijklmnopqrstuvwx")
      expect(row.payload).not.toContain("private reasoning decoy")
      expect(row.payload).not.toContain("private input decoy")
      if (sessionID === "ses-failed" || sessionID === "ses-accepted")
        expect(row.attempt_id).not.toBeNull()
      else expect([row.plan_id, row.task_id, row.attempt_id]).toEqual([null, null, null])
    }
    expect(
      fixture.store.progressFacts([firstAttemptID]).filter((row) => row.kind === "tool"),
    ).toHaveLength(1)
  } finally {
    fixture.close()
  }
})

test("native schema and assignment-guard failures merge once without inventing execution time", () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const observed = call("researcher")
    for (const event of [
      {
        id: "evt-input",
        created: 1000,
        type: "session.tool.input.started",
        data: {
          sessionID: observed.sessionID,
          assistantMessageID: observed.messageID,
          id: observed.callID,
          name: observed.tool,
        },
      },
      {
        id: "evt-failed",
        created: 1200,
        type: "session.tool.failed",
        data: {
          sessionID: observed.sessionID,
          assistantMessageID: observed.messageID,
          id: observed.callID,
          executed: false,
          error: { message: "Implementor requires an admitted runtime assignment" },
        },
      },
    ]) {
      recorder.recordNativeEvent(event, true)
      recorder.recordNativeEvent(event, true)
    }
    recorder.recordToolHook({
      ...observed,
      status: "error",
      error: new Tool.Error({ message: "Implementor requires an admitted runtime assignment" }),
    })
    const rows = recorder.toolCalls(observed.sessionID)
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({
      status: "failed",
      execution: { status: "not-executed" },
      timing: {
        unit: "unix-epoch-ms",
        endpoints: { inputAt: { at: 1000 }, completedAt: { at: 1200 } },
      },
    })
    expect(JSON.parse(rows[0]!.event_ids_json)).toEqual(["evt-input", "evt-failed"])
    expect(JSON.parse(rows[0]!.sources_json)).toEqual(["native-event", "tool-hook"])
    const foreign = {
      id: "evt-foreign",
      created: 1300,
      type: "session.tool.failed",
      data: { sessionID: "ses-foreign", id: "foreign-call", error: { message: "not ours" } },
    }
    recorder.recordNativeEvent(foreign, false)
    expect(recorder.toolCalls("ses-foreign")).toHaveLength(0)
  } finally {
    fixture.close()
  }
})

function wrappedFixture(fixture: ReturnType<typeof makeFixture>, execute: Tool.Info["execute"]) {
  const tools = new Map<string, Tool.Info & { id: string }>([
    [
      "lz-example",
      {
        id: "lz-example",
        name: "lz-example",
        description: "example",
        input: { type: "object" },
        options: { codemode: true },
        execute,
      },
    ],
    [
      "read",
      { id: "read", name: "read", description: "native", input: { type: "object" }, execute },
    ],
  ])
  const editor: ToolEditor = {
    list: () => [...tools.values()],
    get: (id) => tools.get(id),
    update: (id, update) => {
      const entry = tools.get(id)
      if (entry) update(entry)
    },
    add: () => {},
    namespace: () => {},
    remove: () => {},
  }
  let foreign = false
  const ctx = {
    location: { directory: fixture.directory },
    session: {
      get: () =>
        Effect.succeed({
          projectID: foreign ? "foreign" : "project",
          location: { directory: fixture.directory },
        }),
    },
    tool: {
      transform: (transform: (editor: ToolEditor) => void) =>
        Effect.sync(() => {
          transform(editor)
          return { dispose: Effect.void }
        }),
    },
  } as unknown as Plugin.Context
  const context: Tool.Context = {
    sessionID: Session.ID.make("ses-architect"),
    agent: Agent.ID.make("architect"),
    messageID: SessionMessage.ID.make("msg_tool"),
    id: Tool.CallID.make("native-call"),
    progress: () => Effect.void,
  }
  return {
    ctx,
    tools,
    context,
    foreign: () => {
      foreign = true
    },
  }
}

test("project callbacks retain distinct concurrent Code Mode failures while outer execute succeeds", async () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const failure = new Tool.Error({ message: "Invalid arguments: field missing" })
    const wrapped = wrappedFixture(fixture, () => Effect.fail(failure))
    const nativeRead = wrapped.tools.get("read")!.execute
    const observed = { ...call(), tool: "execute" }
    recorder.recordToolBefore(observed)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerToolCallWrappers(wrapped.ctx, recorder, "project")
          // Replayed transforms unwrap their earlier observation callback.
          yield* registerToolCallWrappers(wrapped.ctx, recorder, "project")
          const execute = wrapped.tools.get("lz-example")!.execute
          const results = yield* Effect.all(
            [Effect.exit(execute({}, wrapped.context)), Effect.exit(execute({}, wrapped.context))],
            { concurrency: "unbounded" },
          )
          for (const exit of results) {
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(failure)
          }
        }),
      ),
    )
    recorder.recordToolHook({
      ...observed,
      status: "completed",
      result: { content: "caught both inner errors" },
    })
    const rows = recorder.toolCalls(observed.sessionID)
    expect(rows).toHaveLength(3)
    const outer = rows.find((row) => row.identity_kind === "native-call")!
    expect(outer).toMatchObject({
      tool: "execute",
      native_call_id: "native-call",
      parent_call_id: null,
    })
    expect(JSON.parse(outer.payload).status).toBe("succeeded")
    const children = rows.filter((row) => row.identity_kind === "local-invocation")
    expect(new Set(children.map((row) => row.invocation_id)).size).toBe(2)
    for (const row of children) {
      expect(row).toMatchObject({
        tool: "lz-example",
        native_call_id: null,
        parent_call_id: "native-call",
        agent: "architect",
      })
      expect(JSON.parse(row.payload)).toMatchObject({
        status: "failed",
        error: { message: failure.message },
      })
    }
    expect(wrapped.tools.get("read")!.execute).toBe(nativeRead)
    expect(wrapped.tools.get("lz-example")!.options).toEqual({ codemode: true })
  } finally {
    fixture.close()
  }
})

test("direct callback and hooks deduplicate and preserve original receiver, arguments, result and defects", async () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const result = { content: "done", output: { private: "not persisted" } }
    const input = { value: 1 }
    let received: unknown[] = []
    const wrapped = wrappedFixture(fixture, function (this: unknown, value, context) {
      received = [this, value, context]
      return Effect.succeed(result)
    })
    const observed = { ...call(), tool: "lz-example" }
    recorder.recordToolBefore(observed)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerToolCallWrappers(wrapped.ctx, recorder, "project")
          const entry = wrapped.tools.get("lz-example")!
          expect(yield* entry.execute(input, wrapped.context)).toBe(result)
          expect(received).toEqual([entry, input, wrapped.context])
        }),
      ),
    )
    recorder.recordToolHook({ ...observed, status: "completed", result })
    expect(recorder.toolCalls(observed.sessionID)).toHaveLength(1)
    expect(recorder.toolCalls(observed.sessionID)[0]!.payload).not.toContain("not persisted")
    const defect = new Error("callback defect")
    const failing = wrappedFixture(fixture, () => Effect.die(defect))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerToolCallWrappers(failing.ctx, recorder, "project")
          const exit = yield* Effect.exit(
            failing.tools.get("lz-example")!.execute({}, failing.context),
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(defect)
        }),
      ),
    )
  } finally {
    fixture.close()
  }
})

test("observation storage failures and foreign sessions cannot alter callback results or interrupts", async () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const result = { content: "done" }
    const wrapped = wrappedFixture(fixture, () => Effect.succeed(result))
    const begin = recorder.beginToolInvocation.bind(recorder)
    recorder.beginToolInvocation = () => {
      throw new Error("storage unavailable")
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerToolCallWrappers(wrapped.ctx, recorder, "project")
          expect(yield* wrapped.tools.get("lz-example")!.execute({}, wrapped.context)).toBe(result)
          recorder.beginToolInvocation = begin
          wrapped.foreign()
          expect(yield* wrapped.tools.get("lz-example")!.execute({}, wrapped.context)).toBe(result)
        }),
      ),
    )
    expect(recorder.toolCalls("ses-architect")).toHaveLength(0)
    const interrupted = wrappedFixture(fixture, () => Effect.interrupt)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerToolCallWrappers(interrupted.ctx, recorder, "project")
          const exit = yield* Effect.exit(
            interrupted.tools.get("lz-example")!.execute({}, interrupted.context),
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }),
      ),
    )
    expect(JSON.parse(recorder.toolCalls("ses-architect")[0]!.payload)).toMatchObject({
      status: "failed",
      error: { message: "Tool callback interrupted" },
    })
  } finally {
    fixture.close()
  }
})

test("observation ownership excludes other projects and loaded worktree locations", async () => {
  let directory = "/ours"
  let projectID = "project"
  const ctx = {
    session: { get: () => Effect.succeed({ projectID, location: { directory } }) },
  } as unknown as Plugin.Context
  const scope = toolObservationScope(ctx, "project", "/ours")
  expect(await scope.owns("ses-test")).toBe(true)
  directory = "/other-worktree"
  scope.forget("ses-test")
  expect(await scope.owns("ses-test")).toBe(false)
  directory = "/ours"
  projectID = "foreign"
  expect(await scope.owns("ses-test", true)).toBe(false)
  const throwing = {
    session: {
      get: () => {
        throw new Error("native lookup unavailable")
      },
    },
  } as unknown as Plugin.Context
  expect(await toolObservationScope(throwing, "project", "/ours").owns("ses-test")).toBe(false)
})

test("unknown callback context stays unknown until a matching native tool observation resolves it", () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const observed = { ...call(), tool: "lz-example" }
    const invocation = recorder.beginToolInvocation(observed)
    recorder.endToolInvocation(invocation, { status: "completed" })
    const unresolved = recorder.toolCalls(observed.sessionID)[0]!
    expect(unresolved).toMatchObject({
      identity_kind: "local-invocation",
      native_call_id: null,
      parent_call_id: null,
      context_call_id: observed.callID,
    })
    expect(unresolved.local_invocation_id).toBe(invocation.invocationID)
    recorder.recordToolHook({ ...observed, status: "completed" })
    const resolved = recorder.toolCalls(observed.sessionID)
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({
      identity_kind: "native-call",
      native_call_id: observed.callID,
      parent_call_id: null,
      local_invocation_id: invocation.invocationID,
    })
    // When the real observed outer tool is execute, retain the different callback
    // name under its local identity rather than claiming a native child ID.
    const another = { ...call("architect", "ses-other"), tool: "lz-example" }
    const inner = recorder.beginToolInvocation(another)
    recorder.endToolInvocation(inner, {
      status: "error",
      error: new Tool.Error({ message: "inner error" }),
    })
    recorder.recordToolHook({
      ...another,
      tool: "execute",
      status: "error",
      error: new Tool.Error({ message: "outer error" }),
    })
    expect(recorder.toolCalls(another.sessionID)).toHaveLength(2)
    expect(
      recorder.toolCalls(another.sessionID).find((row) => row.identity_kind === "local-invocation")!
        .parent_call_id,
    ).toBeNull()
  } finally {
    fixture.close()
  }
})

test.each(["completed", "error"] as const)(
  "an active local callback promoted before its %s terminal write retains one identity",
  (status) => {
    const fixture = makeFixture()
    try {
      const recorder = new ProgressRecorder(fixture.store, "project")
      const observed = { ...call(), tool: "lz-example" }
      const invocation = recorder.beginToolInvocation(observed)
      expect(invocation.identityKind).toBe("local-invocation")
      recorder.recordToolBefore(observed)
      const promoted = recorder.toolCalls(observed.sessionID)
      expect(promoted).toHaveLength(1)
      expect(promoted[0]!.identity_kind).toBe("native-call")
      // The running wrapper still holds its original local invocation object.
      recorder.endToolInvocation(invocation, {
        status,
        error:
          status === "error" ? new Tool.Error({ message: "original callback error" }) : undefined,
      })
      const final = recorder.toolCalls(observed.sessionID)
      expect(final).toHaveLength(1)
      expect(final[0]).toMatchObject({
        identity_kind: "native-call",
        native_call_id: observed.callID,
        local_invocation_id: invocation.localInvocationID,
        parent_call_id: null,
      })
      expect(JSON.parse(final[0]!.payload).status).toBe(status === "error" ? "failed" : "succeeded")
      if (status === "error")
        expect(JSON.parse(final[0]!.payload).error.message).toBe("original callback error")
    } finally {
      fixture.close()
    }
  },
)

test("invalidating ownership also fences an in-flight stale read without evicting its replacement", async () => {
  const pending = Promise.withResolvers<{ projectID: string; location: { directory: string } }>()
  let reads = 0
  const ctx = {
    session: {
      get: () =>
        ++reads === 1
          ? Effect.promise(() => pending.promise)
          : Effect.succeed({ projectID: "project", location: { directory: "/moved" } }),
    },
  } as unknown as Plugin.Context
  const scope = toolObservationScope(ctx, "project", "/ours")
  const stale = scope.owns("ses-moving")
  await Promise.resolve()
  scope.clear()
  expect(await scope.owns("ses-moving")).toBe(false)
  pending.resolve({ projectID: "project", location: { directory: "/ours" } })
  expect(await stale).toBe(false)
  expect(await scope.owns("ses-moving")).toBe(false)
  expect(reads).toBe(2)
})

test("the observed initial ledger schema migrates across reopen without inventing legacy identities", () => {
  const fixture = makeFixture()
  let reopened: TaskRepository | undefined
  try {
    fixture.repository.atomic((db) => {
      db.exec(`DROP TABLE native_tool_calls;
        CREATE TABLE native_tool_calls (
          project_directory TEXT NOT NULL, project_id TEXT NOT NULL,
          session_id TEXT NOT NULL, identity_kind TEXT NOT NULL,
          invocation_id TEXT NOT NULL, native_call_id TEXT, parent_call_id TEXT,
          message_id TEXT, agent TEXT, tool TEXT, plan_id TEXT, task_id TEXT, attempt_id TEXT,
          first_observed_at INTEGER NOT NULL, last_observed_at INTEGER NOT NULL,
          sources_json TEXT NOT NULL, event_ids_json TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY(project_directory,session_id,identity_kind,invocation_id)
        )`)
      for (const kind of ["native-call", "local-invocation"])
        db.query(
          `INSERT INTO native_tool_calls
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          fixture.directory,
          "project",
          "ses-legacy",
          kind,
          kind === "native-call" ? "native-legacy" : "local-legacy",
          kind === "native-call" ? "native-legacy" : null,
          kind === "native-call" ? null : "outer-legacy",
          "msg_legacy",
          "architect",
          kind === "native-call" ? "execute" : "lz-example",
          null,
          null,
          null,
          1000,
          1100,
          '["tool-hook"]',
          "[]",
          '{"status":"succeeded"}',
        )
    })
    fixture.repository.close()
    reopened = new TaskRepository(fixture.repository.path, fixture.directory)
    const migrated = new ProgressRecorder(new RunnerStore(reopened), "project")
    const legacy = migrated.toolCalls("ses-legacy")
    expect(legacy).toHaveLength(2)
    for (const row of legacy) {
      expect(row).toMatchObject({
        context_call_id: null,
        local_invocation_id: null,
        first_observed_at: 1000,
        last_observed_at: 1100,
        payload: '{"status":"succeeded"}',
      })
    }
    const observed = call("architect", "ses-new")
    migrated.recordToolBefore(observed)
    migrated.recordToolHook({
      ...observed,
      status: "error",
      error: new Tool.Error({ message: "fresh failure" }),
    })
    expect(migrated.toolCalls(observed.sessionID)).toHaveLength(1)
    expect(migrated.toolCalls(observed.sessionID)[0]!.context_call_id).toBe(observed.callID)
    reopened.close()
    reopened = new TaskRepository(fixture.repository.path, fixture.directory)
    const again = new ProgressRecorder(new RunnerStore(reopened), "project")
    expect(again.toolCalls("ses-legacy")).toEqual(legacy)
    expect(again.toolCalls(observed.sessionID)).toHaveLength(1)
  } finally {
    reopened?.close()
    fixture.close()
  }
})
