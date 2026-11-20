import { afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Session } from "@opencode/schema/session"
import { Effect, Stream } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RunnerStore } from "../../src/runner/store.ts"
import { TaskRepository } from "../../src/storage.ts"
import { ManagedUsageEnrollmentInputSchema } from "../../src/managed-usage/contract.ts"
import { ManagedUsageCapture, registerManagedUsageNative } from "../../src/managed-usage/native.ts"
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

function enrollment(requestID: string, expectedRevision: number, association: unknown) {
  return ManagedUsageEnrollmentInputSchema.parse({
    requestID,
    projectID,
    projectDirectory,
    sessionID: "ses-managed",
    expectedRevision,
    association,
  })
}

function nativeEvent(
  type: "session.step.started" | "session.step.ended",
  messageID: string,
  seq: number,
) {
  const data: Record<string, unknown> = {
    sessionID: "ses-managed",
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
    id: `event-${seq}`,
    type,
    created: seq,
    durable: { aggregateID: "ses-managed", seq, version: 1 },
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

function callContext() {
  return {
    sessionID: Session.ID.make("ses-architect"),
    agent: Agent.ID.make("architect"),
    messageID: "msg-architect",
    id: "call-managed-boundary",
    progress: () => Effect.void,
  } as never
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

async function waitForFactCount(store: ManagedUsageStore, count: number) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (store.snapshot().factCount >= count) return
    await Effect.runPromise(Effect.sleep(10))
  }
}

test("registered reassociation fences events delivered behind a stalled native session read", async () => {
  const { store } = fixture()
  const capture = new ManagedUsageCapture(store)
  store.enroll({
    request: enrollment("initial", 0, { kind: "task", planID, taskID }),
    agent: "explore",
    boundarySequence: 4,
  })

  const blocker = deferred()
  const firstObservation = deferred()
  const queuedEventsObserved = deferred()
  const keepOpen = deferred()
  let childReads = 0
  const managed = {
    id: "ses-managed",
    projectID,
    parentID: "ses-architect",
    agent: "explore",
    location: { directory: projectDirectory },
    time: {},
  }
  const architect = {
    id: "ses-architect",
    projectID,
    agent: "architect",
    location: { directory: projectDirectory },
    time: {},
  }
  const registered = toolsFixture()
  const session = {
    get: ({ sessionID }: { sessionID: string }) => {
      if (sessionID === "ses-managed") {
        childReads++
        if (childReads === 1)
          return Effect.promise(async () => {
            firstObservation.resolve()
            await blocker.promise
            return managed
          })
        if (childReads === 3) queuedEventsObserved.resolve()
        return Effect.succeed(managed)
      }
      return sessionID === "ses-architect"
        ? Effect.succeed(architect)
        : Effect.fail(new Error("missing"))
    },
  }
  const context = {
    location: { project: { id: projectID, canonical: projectDirectory } },
    permission: { assert: () => Effect.void },
    session,
    tool: registered.tool,
  }
  await Effect.runPromise(
    Effect.scoped(
      registerManagedUsageTools({
        ctx: context as never,
        store,
        capture,
        projectID,
        projectDirectory,
        priceProvider: async (calls) =>
          projectManagedUsageValuation({ calls, index: null, freshness: "unknown" }),
      }),
    ),
  )
  const nativeContext = {
    ...context,
    event: {
      subscribe: () =>
        Stream.fromIterable([
          nativeEvent("session.step.started", "msg-blocked", 5),
          nativeEvent("session.step.started", "msg-before-reassociation", 6),
          nativeEvent("session.step.ended", "msg-before-reassociation", 7),
        ]),
    },
  }
  const nativeRun = Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* registerManagedUsageNative(nativeContext as never, capture, projectID)
        yield* Effect.promise(() => keepOpen.promise)
      }),
    ),
  )

  try {
    expect(await resolvesWithin(firstObservation.promise, 1_000)).toBe(true)
    expect(await resolvesWithin(queuedEventsObserved.promise, 1_000)).toBe(true)
    expect(capture.boundarySequence("ses-managed")).toBe(7)

    const result = await Effect.runPromise(
      registered.tools.get("lz-enroll-managed-usage")!.execute(
        {
          requestID: "reassociate",
          projectID,
          projectDirectory,
          sessionID: "ses-managed",
          expectedRevision: 1,
          association: { kind: "unallocated" },
        },
        callContext(),
      ),
    )
    expect(result.output).toMatchObject({ status: "enrolled", revision: 2, boundarySequence: 7 })
  } finally {
    blocker.resolve()
    keepOpen.resolve()
    await nativeRun
  }

  await waitForFactCount(store, 3)
  expect(store.snapshot().factCount).toBe(3)
  expect(
    managedUsageGenerations(store.snapshot()).find(
      (generation) => generation.assistantMessageID === "msg-before-reassociation",
    ),
  ).toMatchObject({
    association: { kind: "task", planID, taskID },
    startSequence: 6,
    terminalSequence: 7,
    outcome: "succeeded",
  })
})

test("redundant location observer start and stop does not create capture gaps", async () => {
  const { store } = fixture()
  const capture = new ManagedUsageCapture(store)
  store.enroll({
    request: enrollment("observer-base", 0, { kind: "unallocated" }),
    agent: "explore",
    boundarySequence: -1,
  })
  const initial = store.snapshot()
  const observer = { event: { subscribe: () => Stream.never } } as never

  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const canonical = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* registerManagedUsageNative(observer, capture, projectID)
            yield* Effect.sleep(25)
            const canonicalStarted = store.snapshot()
            const redundant = yield* Effect.scoped(
              Effect.gen(function* () {
                yield* registerManagedUsageNative(observer, capture, projectID)
                yield* Effect.sleep(25)
                return store.snapshot()
              }),
            )
            return {
              canonicalStarted,
              redundantStarted: redundant,
              redundantStopped: store.snapshot(),
            }
          }),
        )
        return { ...canonical, canonicalStopped: store.snapshot() }
      }),
    ),
  )

  expect(observed.canonicalStarted.revision).toBe(initial.revision + 1)
  expect(observed.canonicalStarted.listenerGapCount).toBe(initial.listenerGapCount + 1)
  expect(observed.redundantStarted.revision).toBe(observed.canonicalStarted.revision)
  expect(observed.redundantStopped.revision).toBe(observed.canonicalStarted.revision)
  expect(observed.canonicalStopped.revision).toBe(observed.canonicalStarted.revision + 1)
  expect(observed.canonicalStopped.listenerGaps.at(-1)).toMatchObject({
    sessionID: "ses-managed",
    kind: "listener-stopped",
  })
})
