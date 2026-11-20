import { afterEach, expect, test } from "bun:test"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect, Queue, Stream } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RunnerStore } from "../../src/runner/store.ts"
import { TaskRepository } from "../../src/storage.ts"
import { ManagedUsageEnrollmentInputSchema } from "../../src/managed-usage/contract.ts"
import { managedUsageEventFact } from "../../src/managed-usage/native.ts"
import { managedUsageGenerations } from "../../src/managed-usage/projection.ts"
import { ManagedUsageStore } from "../../src/managed-usage/store.ts"
import { registerManagedUsageTools } from "../../src/managed-usage/tools.ts"
import { projectManagedUsageValuation } from "../../src/models/managed-usage-valuation.ts"

const projectID = "project"
const projectDirectory = "/repo"
const planID = "11111111-1111-4111-8111-111111111111"
const taskID = "22222222-2222-4222-8222-222222222222"
const directories: string[] = []
const repositories: TaskRepository[] = []

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-managed-boundary-"))
  directories.push(directory)
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), projectDirectory)
  repositories.push(repository)
  new RunnerStore(repository)
  const store = new ManagedUsageStore(repository)
  repository.atomic((db) => {
    db.query("INSERT INTO tasks(id,project_directory,created_at,body) VALUES(?,?,?,?)").run(
      taskID,
      projectDirectory,
      new Date().toISOString(),
      "{}",
    )
    db.query(
      `INSERT INTO runner_plans(
        id,project_directory,owner,revision,version,state,body,model,reason,artifact
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(planID, projectDirectory, "architect", 1, 1, "running", "{}", null, null, null)
    db.query(
      `INSERT INTO runner_nodes(
        plan_id,task_id,spec_revision,ordinal,state,version,reason,artifact,snapshot,machine_version
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(planID, taskID, 1, 0, "ready", 1, null, null, "{}", "1")
  })
  return { repository, store }
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function enrollment(
  requestID: string,
  expectedRevision: number,
  association: unknown,
  sessionID = "ses-managed",
) {
  return ManagedUsageEnrollmentInputSchema.parse({
    requestID,
    projectID,
    projectDirectory,
    sessionID,
    expectedRevision,
    association,
  })
}

function nativeEvent(
  type: "session.step.started" | "session.step.ended",
  messageID: string,
  seq: number,
  sessionID = "ses-managed",
  location?: { directory: string; workspaceID?: string },
) {
  const data: Record<string, unknown> = {
    sessionID,
    assistantMessageID: messageID,
  }
  if (type === "session.step.started")
    Object.assign(data, {
      agent: "explore",
      model: { providerID: "openai", id: "gpt-test", variant: "fast" },
    })
  else
    Object.assign(data, {
      tokens: { input: 7, output: 3, reasoning: 1, cache: { read: 2, write: 1 } },
    })
  return {
    ...(location ? { location } : {}),
    id: `event-${sessionID}-${seq}`,
    type,
    created: seq,
    durable: { aggregateID: sessionID, seq, version: 1 },
    data,
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

type RegisteredTool = Parameters<ToolEditor["add"]>[0]

function toolsFixture() {
  const tools = new Map<string, RegisteredTool>()
  const editor: ToolEditor = {
    add: (tool) => tools.set(tool.name, tool),
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    update: () => {},
    remove: () => {},
  }
  return {
    tools,
    tool: {
      transform: (callback: (value: ToolEditor) => void) =>
        Effect.sync(() => {
          callback(editor)
          return { dispose: Effect.void }
        }),
    },
  }
}

async function resolvesWithin(promise: Promise<void>, milliseconds: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const result = await Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), milliseconds)
    }),
  ])
  if (timeout) clearTimeout(timeout)
  return result
}

test("managed usage registration leaves legacy attribution untouched without subscribing", async () => {
  const { repository, store } = fixture()
  store.enroll({
    request: enrollment("legacy", 0, { kind: "task", planID, taskID }),
    agent: "explore",
    boundarySequence: 4,
    nativeLocation: { directory: projectDirectory, workspaceID: null },
  })
  store.appendFact(managedUsageEventFact(nativeEvent("session.step.started", "msg-history", 5))!)
  store.appendFact(managedUsageEventFact(nativeEvent("session.step.ended", "msg-history", 6))!)
  const before = store.snapshot()
  expect(managedUsageGenerations(before)[0]).toMatchObject({
    assistantMessageID: "msg-history",
    association: { kind: "task", planID, taskID },
  })

  const eventQueue = Effect.runSync(Queue.unbounded<unknown>())
  await Effect.runPromise(
    Queue.offer(eventQueue, nativeEvent("session.step.started", "msg-queued", 7)),
  )
  const streamFailure = Symbol("fixture-stream-failure")
  const sessionReadGate = deferred()
  const keepLoaded = deferred()
  const loaded = deferred()
  const managedSession = {
    id: "ses-managed",
    projectID,
    agent: "explore",
    location: { directory: projectDirectory, workspaceID: null },
    time: {},
  }
  let subscriptions = 0
  let sessionReads = 0
  const registered = toolsFixture()
  const context = {
    location: { project: { id: projectID, canonical: projectDirectory } },
    permission: { assert: () => Effect.void },
    session: {
      get: () => {
        sessionReads++
        return Effect.promise(async () => {
          await sessionReadGate.promise
          return managedSession
        })
      },
    },
    tool: registered.tool,
    event: {
      subscribe: () => {
        subscriptions++
        return Stream.fromQueue(eventQueue).pipe(
          Stream.mapEffect((event) =>
            event === streamFailure
              ? Effect.fail(new Error("private stream failure"))
              : Effect.succeed(event),
          ),
        )
      },
    },
  }
  const registration = Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* registerManagedUsageTools({
          ctx: context as never,
          store,
          projectID,
          projectDirectory,
          priceProvider: async (calls) =>
            projectManagedUsageValuation({ calls, index: null, freshness: "unknown" }),
        })
        loaded.resolve()
        yield* Effect.promise(() => keepLoaded.promise)
      }),
    ),
  )

  try {
    expect(await resolvesWithin(loaded.promise, 1_000)).toBe(true)
    await Effect.runPromise(
      Queue.offer(eventQueue, nativeEvent("session.step.ended", "msg-queued", 8)),
    )
    await Effect.runPromise(
      Queue.offer(eventQueue, nativeEvent("session.step.started", "msg-later", 9)),
    )
    await Effect.runPromise(
      Queue.offer(eventQueue, nativeEvent("session.step.ended", "msg-later", 10)),
    )
    await Effect.runPromise(Queue.offer(eventQueue, streamFailure))
    await Effect.runPromise(Effect.sleep(25))
    expect(subscriptions).toBe(0)
    expect(sessionReads).toBe(0)
    expect(registered.tools.has("lz-read-managed-usage")).toBe(true)
    expect(store.snapshot()).toEqual(before)
  } finally {
    sessionReadGate.resolve()
    keepLoaded.resolve()
    expect(await resolvesWithin(registration, 1_000)).toBe(true)
  }

  repository.close()
  await Effect.runPromise(Effect.sleep(25))
  expect(repository.isClosed).toBe(true)
  expect(subscriptions).toBe(0)
  expect(sessionReads).toBe(0)
})
