import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { DateTime, Effect, Queue, Stream } from "effect"
import { secondAttemptID } from "../../test/trajectory/fixture.ts"
import { makeFixture } from "../../test/trajectory/fixture.ts"
import { NativeIdleStore } from "../runner/native-idle.ts"
import { ProgressRecorder } from "./recorder.ts"
import { registerProgress } from "./native.ts"

type IdleHook = (idle: never) => Effect.Effect<void>

type TestFixture = ReturnType<typeof makeFixture>

function activeFixture() {
  const fixture = makeFixture()
  fixture.store.atomic((db) => {
    db.query("UPDATE runner_plans SET state='running' WHERE id=?").run(fixture.receipt.planID)
    db.query("UPDATE runner_nodes SET state='running' WHERE plan_id=? AND task_id=?").run(
      fixture.receipt.planID,
      fixture.task.id,
    )
    db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(secondAttemptID)
  })
  const recorder = new ProgressRecorder(fixture.store, "project")
  const assignment = recorder.assignmentForSession("ses-accepted")!
  const binding = {
    projectDirectory: fixture.repository.projectDirectory,
    projectID: assignment.projectID,
    attemptID: assignment.attemptID,
    sessionID: assignment.sessionID,
    workspace: assignment.workspace,
    assignedMessageID: assignment.assignedMessageID,
  }
  return { fixture, recorder, binding, store: new NativeIdleStore(fixture.repository) }
}

function makeContext(
  fixture: TestFixture,
  options: {
    messages: unknown[]
    readSession?: (sessionID: string, read: number) => Effect.Effect<unknown, unknown, never>
  },
) {
  let idleHook: IdleHook | undefined
  let reads = 0
  const eventQueue = Effect.runSync(Queue.unbounded<unknown>())
  const tools = new Map<string, unknown>()
  const editor = {
    add: (tool: { name: string }) => tools.set(tool.name, tool),
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    update: () => {},
    remove: () => {},
  } as unknown as ToolEditor
  const context = {
    location: { directory: fixture.repository.projectDirectory },
    permission: { assert: () => Effect.void },
    tool: {
      transform: (transform: (editor: ToolEditor) => void) =>
        Effect.sync(() => {
          transform(editor)
          return { dispose: Effect.void }
        }),
      hook: () => Effect.succeed({ dispose: Effect.void }),
    },
    session: {
      hook: (name: string, callback: IdleHook) => {
        if (name === "experimental.idle") idleHook = callback
        return Effect.succeed({ dispose: Effect.void })
      },
      get: ({ sessionID: requested }: { sessionID: string }) => {
        const read = reads++
        if (options.readSession) return options.readSession(requested, read)
        return Effect.succeed({
          id: requested,
          projectID: "project",
          agent: "lazers-implementor",
          location: { directory: fixture.repository.projectDirectory },
          metadata: { lazersAttemptID: secondAttemptID },
          outcome: "succeeded",
        })
      },
      context: () => Effect.succeed(options.messages),
      synthetic: ({ id }: { id: string }) => Effect.succeed({ id }),
    },
    event: {
      subscribe: () => Stream.fromQueue(eventQueue),
    },
  } as unknown as Plugin.Context
  return {
    context,
    idle: () => idleHook,
    emit: (event: unknown) => Effect.runPromise(Queue.offer(eventQueue, event)),
    reads: () => reads,
  }
}

function event(type: string, sequence?: number) {
  return {
    id: sequence === undefined ? "evt_missing_sequence" : `evt_${sequence}`,
    type,
    durable:
      sequence === undefined
        ? undefined
        : { aggregateID: "ses-accepted", seq: sequence, version: 1 },
    data: { sessionID: "ses-accepted" },
  }
}

function currentMessages(inputID: string) {
  return [
    { id: inputID, type: "user", text: "Assigned worker input" },
    {
      id: "msg_handoff",
      type: "assistant",
      finish: "stop",
      content: [{ type: "text", text: "The assigned work is complete." }],
    },
  ]
}

function appendSuccessfulIdle(messages: unknown[], sequence: number) {
  const eventID = `evt_${sequence}`
  const idleID = SessionMessage.ID.fromEvent(eventID)
  const now = DateTime.nowUnsafe()
  messages.push(
    {
      id: `msg_response_${sequence}`,
      type: "assistant",
      time: { created: now, completed: now },
      finish: "stop",
      content: [{ type: "text", text: "Completed." }],
    },
    { id: idleID, type: "idle", outcome: "succeeded", time: { created: now } },
  )
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Native current-idle test timed out")
}

async function startOldObserver(
  fixture: TestFixture,
  recorder: ProgressRecorder,
  store: NativeIdleStore,
  binding: ReturnType<typeof activeFixture>["binding"],
  messages: unknown[],
  startSequence: number | undefined,
  afterStartSequence?: number,
) {
  const old = makeContext(fixture, { messages })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* registerProgress(old.context, recorder, "project")
        yield* Effect.promise(() => old.emit(event("session.execution.started", startSequence)))
        yield* Effect.promise(() =>
          waitFor(() =>
            startSequence === undefined
              ? store.read(binding)?.revision === 1 &&
                store.read(binding)?.executionStartSequence === null
              : store.read(binding)?.executionStartSequence === startSequence,
          ),
        )
        if (afterStartSequence !== undefined) {
          yield* Effect.promise(() => old.emit(event("session.shell.ended", afterStartSequence)))
          yield* Effect.promise(() =>
            waitFor(() => store.read(binding)?.lastEventSequence === afterStartSequence),
          )
        }
      }),
    ),
  )
  return old
}

function observationStore(
  fixture: TestFixture,
  binding: ReturnType<typeof activeFixture>["binding"],
) {
  return new NativeIdleStore(fixture.repository).background(binding)
}

test("a current registered idle hook establishes exact live lineage after observer replacement", async () => {
  const { fixture, recorder, binding, store } = activeFixture()
  const messages = currentMessages(binding.assignedMessageID)
  try {
    await startOldObserver(fixture, recorder, store, binding, messages, 20, 25)
    const replacement = makeContext(fixture, { messages })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(replacement.context, recorder, "project", undefined, async () => {
            throw new Error("native log replay is unavailable")
          })
          yield* replacement.idle()!({
            sessionID: Session.ID.make(binding.sessionID),
            background: [],
          } as never)
          expect(store.read(binding)?.report).toMatchObject({
            inputID: binding.assignedMessageID,
            executionStartSequence: 20,
            eventSequence: 25,
            count: 0,
          })
          expect(observationStore(fixture, binding)).toMatchObject({ state: "unknown" })
          appendSuccessfulIdle(messages, 26)
          yield* Effect.promise(() => replacement.emit(event("session.execution.succeeded", 26)))
          yield* Effect.promise(() => waitFor(() => store.read(binding)?.terminal?.sequence === 26))
        }),
      ),
    )
    expect(observationStore(fixture, binding)).toMatchObject({
      state: "observed",
      count: 0,
      inputID: binding.assignedMessageID,
      executionStartSequence: 20,
      eventSequence: 25,
      terminalSequence: 26,
    })
  } finally {
    fixture.close()
  }
})

test("a current positive-background snapshot stays observable as live work", async () => {
  const { fixture, recorder, binding, store } = activeFixture()
  const messages = currentMessages(binding.assignedMessageID)
  try {
    await startOldObserver(fixture, recorder, store, binding, messages, 20)
    const replacement = makeContext(fixture, { messages })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(replacement.context, recorder, "project")
          yield* replacement.idle()!({
            sessionID: Session.ID.make(binding.sessionID),
            background: [{ kind: "shell" }],
          } as never)
          appendSuccessfulIdle(messages, 21)
          yield* Effect.promise(() => replacement.emit(event("session.execution.succeeded", 21)))
          yield* Effect.promise(() => waitFor(() => store.read(binding)?.terminal?.sequence === 21))
        }),
      ),
    )
    expect(observationStore(fixture, binding)).toMatchObject({
      state: "observed",
      count: 1,
      kinds: { shell: 1, subagent: 0, image: 0 },
      terminalSequence: 21,
    })
  } finally {
    fixture.close()
  }
})

test.each(["missing callback", "instruction-only context", "missing start sequence"] as const)(
  "replacement remains fail-closed with %s",
  async (caseName) => {
    const { fixture, recorder, binding, store } = activeFixture()
    const messages: unknown[] = currentMessages(binding.assignedMessageID)
    if (caseName === "instruction-only context")
      messages[0] = {
        id: "msg_loaded_instructions",
        type: "synthetic",
        text: "Repository instructions",
        metadata: { instruction: { paths: ["AGENTS.md"] } },
      }
    try {
      await startOldObserver(
        fixture,
        recorder,
        store,
        binding,
        messages,
        caseName === "missing start sequence" ? undefined : 20,
      )
      const replacement = makeContext(fixture, { messages })
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* registerProgress(replacement.context, recorder, "project")
            if (caseName !== "missing callback")
              yield* replacement.idle()!({
                sessionID: Session.ID.make(binding.sessionID),
                background: [],
              } as never)
            appendSuccessfulIdle(messages, 21)
            yield* Effect.promise(() => replacement.emit(event("session.execution.succeeded", 21)))
            yield* Effect.sleep(10)
          }),
        ),
      )
      expect(store.read(binding)?.report).toBeNull()
      expect(observationStore(fixture, binding).state).toBe("unknown")
    } finally {
      fixture.close()
    }
  },
)

test.each([
  "newer event",
  "changed input",
  "changed session identity",
  "cancelled attempt",
  "disposed task",
] as const)(
  "a current-idle callback racing %s cannot restore obsolete evidence",
  async (change) => {
    const { fixture, recorder, binding, store } = activeFixture()
    const messages = currentMessages(binding.assignedMessageID)
    const reachedRevalidation = Promise.withResolvers<void>()
    const releaseRevalidation = Promise.withResolvers<void>()
    let replacementReads = 0
    let sessionIdentityChanged = false
    try {
      await startOldObserver(fixture, recorder, store, binding, messages, 20)
      const replacement = makeContext(fixture, {
        messages,
        readSession: (sessionID, read) => {
          replacementReads++
          if (read === 2) {
            reachedRevalidation.resolve()
            return Effect.promise(() => releaseRevalidation.promise).pipe(
              Effect.map(() => ({
                id: sessionID,
                projectID: sessionIdentityChanged ? "other-project" : "project",
                agent: sessionIdentityChanged ? "other-agent" : "lazers-implementor",
                location: { directory: fixture.repository.projectDirectory },
                metadata: { lazersAttemptID: secondAttemptID },
                outcome: "succeeded",
              })),
            )
          }
          return Effect.succeed({
            id: sessionID,
            projectID: sessionIdentityChanged ? "other-project" : "project",
            agent: sessionIdentityChanged ? "other-agent" : "lazers-implementor",
            location: { directory: fixture.repository.projectDirectory },
            metadata: { lazersAttemptID: secondAttemptID },
            outcome: "succeeded",
          })
        },
      })
      const idlePending = Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* registerProgress(replacement.context, recorder, "project")
            yield* replacement.idle()!({
              sessionID: Session.ID.make(binding.sessionID),
              background: [],
            } as never)
          }),
        ),
      )
      await reachedRevalidation.promise
      if (change === "newer event") {
        await replacement.emit(event("session.execution.started", 21))
        await waitFor(() => store.read(binding)?.executionStartSequence === 21)
      } else if (change === "changed input") {
        messages[0] = { id: "msg_new_input", type: "user", text: "Changed input" }
      } else if (change === "changed session identity") {
        sessionIdentityChanged = true
      } else if (change === "cancelled attempt") {
        fixture.store.atomic((db) => {
          db.query("UPDATE runner_plans SET state='cancelling' WHERE id=?").run(
            fixture.receipt.planID,
          )
          db.query("UPDATE runner_attempts SET state='cancelled' WHERE id=?").run(secondAttemptID)
        })
      } else {
        fixture.store.atomic((db) => {
          db.query("UPDATE runner_plans SET state='accepted' WHERE id=?").run(
            fixture.receipt.planID,
          )
          db.query("UPDATE runner_nodes SET state='accepted' WHERE plan_id=? AND task_id=?").run(
            fixture.receipt.planID,
            fixture.task.id,
          )
          db.query("UPDATE runner_attempts SET state='accepted' WHERE id=?").run(secondAttemptID)
        })
        fixture.repository.recordDisposition(
          {
            taskID: fixture.task.id,
            requestID: "current-idle-disposition",
            disposition: "fulfilled",
            reason: "The task has already been fulfilled.",
            evidence: [{ kind: "human", reference: "Review" }],
            relatedTaskIDs: [],
          },
          { sessionID: "ses-owner", agent: "architect" },
        )
      }
      releaseRevalidation.resolve()
      await idlePending
      expect(replacementReads).toBeGreaterThan(0)
      expect(store.read(binding)?.report).toBeNull()
      expect(observationStore(fixture, binding).state).toBe("unknown")
    } finally {
      releaseRevalidation.resolve()
      fixture.close()
    }
  },
)

test("captured Architect steering retains the same attempt through native idle and success", async () => {
  const { fixture, recorder, binding, store } = activeFixture()
  const steerID = "msg_architect_steering"
  const messages = [
    { id: binding.assignedMessageID, type: "user", text: "Assigned task" },
    ...currentMessages(steerID),
  ]
  try {
    recorder.reconcileMessages(binding.sessionID, messages)
    await startOldObserver(fixture, recorder, store, binding, messages, 20, 25)
    const replacement = makeContext(fixture, { messages })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerProgress(replacement.context, recorder, "project", undefined, async () => {
            throw new Error("native log replay is unavailable")
          })
          yield* replacement.idle()!({
            sessionID: Session.ID.make(binding.sessionID),
            background: [],
          } as never)
          expect(store.read(binding)?.report).toMatchObject({ inputID: steerID, count: 0 })
          appendSuccessfulIdle(messages, 26)
          yield* Effect.promise(() => replacement.emit(event("session.execution.succeeded", 26)))
          yield* Effect.promise(() => waitFor(() => store.read(binding)?.terminal?.sequence === 26))
        }),
      ),
    )
    expect(observationStore(fixture, binding)).toMatchObject({
      state: "observed",
      inputID: steerID,
      count: 0,
    })
  } finally {
    fixture.close()
  }
})
