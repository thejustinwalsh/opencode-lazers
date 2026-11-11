import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { DateTime, Effect, Queue, Stream } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { validProposal } from "../proposal.ts"
import { registerProgress } from "../../src/progress/native.ts"
import { TaskRepository } from "../../src/storage.ts"
import { RunnerStore } from "../../src/runner/store.ts"
import { TaskRuntime } from "../../src/runner/runtime.ts"
import { git } from "../../src/runner/artifacts.ts"
import { nativeHost } from "../../src/runner/native.ts"
import type { NativeInboxClient, NativeInboxDependencies } from "../../src/runner/native.ts"
import { NativeIdleStore } from "../../src/runner/native-idle.ts"

type IdleHook = (idle: never) => Effect.Effect<void>

function hookContext(
  root: string,
  workerInfo: (sessionID: string) => Record<string, unknown> | undefined,
  workerMessages: (sessionID: string) => unknown[],
) {
  let idleHook: IdleHook | undefined
  const eventQueue = Effect.runSync(Queue.unbounded<unknown>())
  const context = {
    app: { version: "2.2.5" },
    location: { directory: root, project: { id: "project" } },
    permission: { assert: () => Effect.void },
    tool: {
      transform: (transform: (editor: never) => void) =>
        Effect.sync(() => {
          transform({ add: () => {} } as never)
          return { dispose: Effect.void }
        }),
      hook: () => Effect.succeed({ dispose: Effect.void }),
    },
    session: {
      hook: (name: string, callback: IdleHook) => {
        if (name === "experimental.idle") idleHook = callback
        return Effect.succeed({ dispose: Effect.void })
      },
      get: ({ sessionID }: { sessionID: string }) => {
        const info = workerInfo(sessionID)
        return Effect.succeed(info ?? null)
      },
      context: ({ sessionID }: { sessionID: string }) => Effect.succeed(workerMessages(sessionID)),
      synthetic: ({ id }: { id: string }) => Effect.succeed({ id }),
    },
    event: { subscribe: () => Stream.fromQueue(eventQueue) },
  } as unknown as Plugin.Context
  return {
    context,
    idle: () => idleHook,
    emit: (event: unknown) => Effect.runPromise(Queue.offer(eventQueue, event)),
  }
}

function nativeEvent(type: string, sequence: number, sessionID: string) {
  return {
    id: `evt_${sequence}`,
    type,
    created: sequence,
    durable: { aggregateID: sessionID, seq: sequence, version: 1 },
    data: { sessionID },
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Current-idle runner verification did not reach the expected state")
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), "lazers-current-idle-runtime-"))
  git(root, ["init", "--initial-branch=main"])
  writeFileSync(join(root, "baseline.txt"), "baseline\n")
  git(root, ["add", "baseline.txt"])
  git(root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "baseline",
  ])
  const baseCommit = git(root, ["rev-parse", "HEAD"])
  const dataDirectory = mkdtempSync(join(tmpdir(), "lazers-current-idle-data-"))
  const repository = new TaskRepository(join(dataDirectory, "tasks.sqlite"), root)
  const store = new RunnerStore(repository)
  const proposal = validProposal()
  proposal.objective = "Write output.txt after a native idle observation"
  proposal.writeScope = ["output.txt"]
  proposal.verification = [
    { id: "output", command: 'test "$(cat output.txt)" = "complete"', timeoutMs: 10_000 },
  ]
  proposal.acceptance = [
    {
      id: "output-exists",
      assertion: "The output has the expected content",
      evidence: [{ kind: "verification", verificationID: "output" }],
    },
  ]
  const task = repository.insert({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: new Date().toISOString(),
    provenance: {
      projectID: "project",
      projectDirectory: root,
      workspaceDirectory: root,
      sessionID: "ses-owner",
      startingRevision: { kind: "git", commit: baseCommit },
    },
    proposal,
  })
  const receipt = store.submit(
    {
      requestID: "current-idle-runner-verification",
      objective: "Verify a native worker only after an exact current idle terminal",
      baseCommit,
      workspaceMode: "shared",
      workerModel: { providerID: "openai", id: "test-model" },
      nodes: [{ taskID: task.id, revision: 1 }],
      dependencies: [],
      integrationOrder: [task.id],
      verification: [
        { id: "combined", command: 'test "$(cat output.txt)" = "complete"', timeoutMs: 10_000 },
      ],
      acceptance: [
        {
          id: "combined-output",
          assertion: "The combined output is correct",
          evidence: [{ kind: "verification", verificationID: "combined" }],
        },
      ],
    },
    "ses-owner",
  )
  const sessions = new Map<
    string,
    {
      id: string
      parentID?: string
      projectID: string
      agent: string
      directory: string
      attemptID?: string
      busy: boolean
      outcome?: "succeeded" | "failed" | "interrupted"
      time: {
        created: ReturnType<typeof DateTime.nowUnsafe>
        updated: ReturnType<typeof DateTime.nowUnsafe>
        busy?: ReturnType<typeof DateTime.nowUnsafe>
        idle?: ReturnType<typeof DateTime.nowUnsafe>
      }
      model: { providerID: string; id: string }
      messages: unknown[]
    }
  >()
  const ownerNow = DateTime.nowUnsafe()
  sessions.set("ses-owner", {
    id: "ses-owner",
    projectID: "project",
    agent: "architect",
    directory: root,
    busy: false,
    time: { created: ownerNow, updated: ownerNow, idle: ownerNow },
    model: { providerID: "openai", id: "test-model" },
    messages: [],
  })
  const info = (sessionID: string) => {
    const session = sessions.get(sessionID)
    if (!session) return undefined
    return {
      id: session.id,
      parentID: session.parentID,
      projectID: session.projectID,
      agent: session.agent,
      metadata: session.attemptID ? { lazersAttemptID: session.attemptID } : undefined,
      location: { directory: session.directory },
      time: session.time,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      outcome: session.outcome,
      model: session.model,
    }
  }
  const nativeClient = {
    server: { info: async () => ({ pid: process.pid, version: "2.2.5" }) },
    session: {
      active: async () =>
        Object.fromEntries(
          [...sessions.values()]
            .filter((session) => session.busy)
            .map((session) => [session.id, { type: "running" }]),
        ),
      inbox: { list: async () => [] },
      message: {
        get: async () => {
          throw new Error("Unexpected retained input lookup")
        },
      },
    },
    permission: {
      request: {
        list: async ({ location }: { location: { directory: string } }) => ({ location, data: [] }),
      },
    },
    form: {
      list: async ({ location }: { location: { directory: string } }) => ({ location, data: [] }),
    },
    shell: {
      list: async ({ location }: { location: { directory: string } }) => ({ location, data: [] }),
    },
    message: { list: async () => ({ data: [], cursor: {} }) },
    experimental: { session: { log: async function* () {} } },
    debug: { location: { list: async () => [], evict: async () => {} } },
  } as unknown as NativeInboxClient
  const dependencies: NativeInboxDependencies = {
    discover: async () => ({ url: "https://opencode.localhost", auth: undefined }),
    make: () => nativeClient,
    processID: () => process.pid,
  }
  const nativeContext = {
    app: { version: "2.2.5" },
    location: { directory: root, project: { id: "project" } },
    session: {
      get: ({ sessionID }: { sessionID: string }) => Effect.succeed(info(sessionID) as never),
      context: ({ sessionID }: { sessionID: string }) =>
        Effect.succeed((sessions.get(sessionID)?.messages ?? []) as never),
    },
  } as unknown as Plugin.Context
  const native = nativeHost(nativeContext, repository, dependencies)
  const host = {
    ...native,
    workerModel: async () => ({ providerID: "openai", id: "test-model" }),
    worktree: async () => {
      throw new Error("Shared workspace must not create a worktree")
    },
    worktrees: async () => [root],
    removeWorktree: async () => {},
    create: async (input: {
      id: string
      parentID: string
      projectID?: string
      agent: string
      model: { providerID: string; id: string }
      directory: string
      attemptID: string
    }) => {
      const now = DateTime.nowUnsafe()
      sessions.set(input.id, {
        id: input.id,
        parentID: input.parentID,
        projectID: "project",
        agent: input.agent,
        directory: input.directory,
        attemptID: input.attemptID,
        busy: false,
        time: { created: now, updated: now, idle: now },
        model: input.model,
        messages: [],
      })
    },
    createArchitect: async () => {},
    ensureSourceGuard: async () => {},
    prompt: async (input: { sessionID: string; id: string; directory: string }) => {
      const session = sessions.get(input.sessionID)!
      const now = DateTime.nowUnsafe()
      session.messages = [
        { id: input.id, type: "user", text: "Write complete to output.txt" },
        {
          id: "msg_worker_handoff",
          type: "assistant",
          time: { created: now, completed: now },
          finish: "stop",
          content: [{ type: "text", text: "The requested output is complete." }],
        },
      ]
      session.busy = true
      session.time = { ...session.time, busy: now }
      mkdirSync(dirname(join(input.directory, "output.txt")), { recursive: true })
      writeFileSync(join(input.directory, "output.txt"), "complete\n")
      git(input.directory, ["add", "output.txt"])
      git(input.directory, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "complete output",
      ])
    },
    updateInstruction: async () => {},
    notify: async () => {},
    interrupt: async (sessionID: string) => {
      const session = sessions.get(sessionID)
      if (session) {
        session.busy = false
        session.outcome = "interrupted"
      }
    },
  }
  const runtime = new TaskRuntime(store, host, "project")
  return {
    root,
    repository,
    store,
    task,
    receipt,
    sessions,
    info,
    runtime,
    host,
    close: async () => {
      await runtime.stop()
      repository.close()
      rmSync(root, { recursive: true, force: true })
      rmSync(dataDirectory, { recursive: true, force: true })
    },
  }
}

test.each([
  { name: "zero background", background: [] as const, accepted: true },
  { name: "positive background", background: [{ kind: "shell" as const }], accepted: false },
])(
  "replacement idle callback reaches normal verification only for $name",
  async ({ background, accepted }) => {
    const f = harness()
    try {
      await f.runtime.command(
        {
          requestID: "start-current-idle-runtime",
          planID: f.receipt.planID,
          expectedVersion: f.store.plan(f.receipt.planID)!.version,
          action: "run",
        },
        "ses-owner",
      )
      for (let tick = 0; tick < 4 && !f.store.attempts(f.receipt.planID).length; tick++)
        await f.runtime.tick()
      const attempt = f.store.attempts(f.receipt.planID)[0]!
      expect(attempt.state).toBe("running")
      const messages = f.sessions.get(attempt.session_id)!.messages
      const idleStore = new NativeIdleStore(f.repository)
      const binding = idleStore.assignmentForSession(attempt.session_id)!
      const old = hookContext(
        f.root,
        f.info,
        (sessionID) => f.sessions.get(sessionID)?.messages ?? [],
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* registerProgress(old.context, f.runtime.progress, "project")
            yield* Effect.promise(() =>
              old.emit(nativeEvent("session.execution.started", 20, attempt.session_id)),
            )
            yield* Effect.promise(() =>
              waitFor(() => idleStore.read(binding)?.executionStartSequence === 20),
            )
          }),
        ),
      )

      const replacement = hookContext(
        f.root,
        f.info,
        (sessionID) => f.sessions.get(sessionID)?.messages ?? [],
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* registerProgress(replacement.context, f.runtime.progress, "project")
            yield* replacement.idle()!({
              sessionID: Session.ID.make(attempt.session_id),
              background,
            } as never)
            expect(idleStore.read(binding)?.report).toMatchObject({
              inputID: binding.assignedMessageID,
              executionStartSequence: 20,
              eventSequence: 20,
              count: background.length,
            })
            expect(
              (yield* Effect.promise(() => f.host.session(attempt.session_id, { messages: true })))
                ?.background,
            ).toMatchObject({ state: "unknown" })
            expect(
              f.store.effects(f.receipt.planID).some((effect) => effect.kind === "verify:output"),
            ).toBe(false)

            const worker = f.sessions.get(attempt.session_id)!
            worker.busy = false
            worker.outcome = "succeeded"
            worker.time = { ...worker.time, idle: DateTime.nowUnsafe() }
            const wrongMarkerID = SessionMessage.ID.fromEvent("evt_wrong")
            const wrongTime = DateTime.nowUnsafe()
            messages.push({
              id: wrongMarkerID,
              type: "idle",
              outcome: "succeeded",
              time: { created: wrongTime },
            })
            yield* Effect.promise(() =>
              replacement.emit(nativeEvent("session.execution.succeeded", 21, attempt.session_id)),
            )
            yield* Effect.promise(() =>
              waitFor(() => idleStore.read(binding)?.lastEventSequence === 21),
            )
            if (background.length === 0) expect(idleStore.background(binding).state).toBe("unknown")
            else {
              const observation = idleStore.background(binding)
              expect(observation).toMatchObject({ state: "observed", count: 1 })
              expect("terminalSequence" in observation).toBe(false)
            }

            yield* Effect.promise(() =>
              replacement.emit(nativeEvent("session.execution.started", 22, attempt.session_id)),
            )
            yield* Effect.promise(() =>
              waitFor(() => idleStore.read(binding)?.executionStartSequence === 22),
            )
          }),
        ),
      )

      const currentReplacement = hookContext(
        f.root,
        f.info,
        (sessionID) => f.sessions.get(sessionID)?.messages ?? [],
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* registerProgress(currentReplacement.context, f.runtime.progress, "project")
            yield* currentReplacement.idle()!({
              sessionID: Session.ID.make(attempt.session_id),
              background,
            } as never)
            const currentReport = idleStore.read(binding)?.report
            expect(currentReport).toMatchObject({
              inputID: binding.assignedMessageID,
              executionStartSequence: 22,
              eventSequence: 22,
              count: background.length,
            })
            const worker = f.sessions.get(attempt.session_id)!
            worker.busy = false
            worker.outcome = "succeeded"
            worker.time = { ...worker.time, idle: DateTime.nowUnsafe() }
            const successID = "evt_23"
            const now = DateTime.nowUnsafe()
            messages.push(
              {
                id: "msg_worker_response_23",
                type: "assistant",
                time: { created: now, completed: now },
                finish: "stop",
                content: [{ type: "text", text: "The requested output is complete." }],
              },
              {
                id: SessionMessage.ID.fromEvent(successID),
                type: "idle",
                outcome: "succeeded",
                time: { created: now },
              },
            )
            yield* Effect.promise(() =>
              currentReplacement.emit(
                nativeEvent("session.execution.succeeded", 23, attempt.session_id),
              ),
            )
            yield* Effect.promise(() =>
              waitFor(() => idleStore.read(binding)?.terminal?.sequence === 23),
            )
          }),
        ),
      )
      const hostObservation = await f.host.session(attempt.session_id, { messages: true })
      expect(hostObservation?.background).toMatchObject({
        state: "observed",
        inputID: binding.assignedMessageID,
        executionStartSequence: 22,
        terminalSequence: 23,
        count: background.length,
      })
      for (
        let tick = 0;
        tick < 200 && f.store.plan(f.receipt.planID)?.state !== "accepted";
        tick++
      ) {
        await f.runtime.tick()
        if (f.store.plan(f.receipt.planID)?.state !== "accepted")
          await new Promise<void>((resolve) => setTimeout(resolve, 5))
      }
      if (accepted) {
        expect(f.store.plan(f.receipt.planID)?.state).toBe("accepted")
        expect(f.store.nodes(f.receipt.planID)[0]?.state).toBe("accepted")
        expect(f.store.attempts(f.receipt.planID)[0]?.state).toBe("accepted")
        expect(
          f.store
            .effects(f.receipt.planID)
            .some((effect) => effect.kind === "verify:output" && effect.state === "completed"),
        ).toBe(true)
      } else {
        expect(f.store.plan(f.receipt.planID)?.state).toBe("blocked")
        expect(
          f.store.effects(f.receipt.planID).some((effect) => effect.kind === "verify:output"),
        ).toBe(false)
        expect(hostObservation?.background).toMatchObject({ state: "observed", count: 1 })
      }
    } finally {
      await f.close()
    }
  },
)
