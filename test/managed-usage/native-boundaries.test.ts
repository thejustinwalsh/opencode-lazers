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

test("delayed native events cannot be reassociated by fail-closed public enrollment", async () => {
  const { store } = fixture()
  const capture = new ManagedUsageCapture(store)
  store.enroll({
    request: enrollment("initial", 0, { kind: "unallocated" }),
    agent: "explore",
    boundarySequence: -1,
    nativeLocation: { directory: projectDirectory, workspaceID: null },
  })

  const blocker = deferred()
  const firstObservation = deferred()
  const keepOpen = deferred()
  const managed = {
    id: "ses-managed",
    projectID,
    parentID: "ses-architect",
    agent: "explore",
    location: { directory: projectDirectory, workspaceID: null },
    time: {},
  }
  const nativeContext = {
    location: { directory: projectDirectory, workspaceID: null },
    session: {
      get: () =>
        Effect.promise(async () => {
          firstObservation.resolve()
          await blocker.promise
          return managed
        }),
    },
    event: {
      subscribe: () =>
        Stream.concat(
          Stream.succeed(
            nativeEvent("session.step.started", "msg-delayed", 1, "ses-managed", {
              directory: projectDirectory,
            }),
          ),
          Stream.never,
        ),
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
    const registered = toolsFixture()
    const sessions = new Map<string, Record<string, unknown>>([
      [
        "ses-architect",
        {
          id: "ses-architect",
          projectID,
          agent: "architect",
          location: { directory: projectDirectory, workspaceID: null },
          time: {},
        },
      ],
      ["ses-managed", managed],
    ])
    const context = {
      location: { project: { id: projectID, canonical: projectDirectory } },
      permission: { assert: () => Effect.void },
      session: {
        get: ({ sessionID }: { sessionID: string }) => {
          const session = sessions.get(String(sessionID))
          return session ? Effect.succeed(session) : Effect.fail(new Error("missing"))
        },
      },
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
    await expect(
      Effect.runPromise(
        registered.tools.get("lz-enroll-managed-usage")!.execute(
          {
            requestID: "reassociate",
            projectID,
            projectDirectory,
            sessionID: "ses-managed",
            expectedRevision: 1,
            association: { kind: "task", planID, taskID },
          },
          callContext(),
        ),
      ),
    ).rejects.toThrow("cannot prove a future-generation boundary")
    blocker.resolve()
    await waitForFactCount(store, 1)
  } finally {
    blocker.resolve()
    keepOpen.resolve()
    await nativeRun
  }

  await waitForFactCount(store, 1)
  expect(store.snapshot()).toMatchObject({ boundaryCount: 1, factCount: 1 })
  expect(store.sessionRevision("ses-managed")).toBe(1)
  expect(managedUsageGenerations(store.snapshot())[0]).toMatchObject({
    assistantMessageID: "msg-delayed",
    association: { kind: "unallocated" },
    outcome: "pending",
  })
})

test("redundant location observer start and stop does not create capture gaps", async () => {
  const { store } = fixture()
  const capture = new ManagedUsageCapture(store)
  store.enroll({
    request: enrollment("observer-base", 0, { kind: "unallocated" }),
    agent: "explore",
    boundarySequence: -1,
    nativeLocation: { directory: projectDirectory, workspaceID: null },
  })
  const initial = store.snapshot()
  const observer = {
    location: { directory: projectDirectory, workspaceID: null },
    event: { subscribe: () => Stream.never },
  } as never

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

test("worktree stream failure records coverage gaps only in its native location", async () => {
  const { store } = fixture()
  const capture = new ManagedUsageCapture(store)
  const mainLocation = { directory: projectDirectory, workspaceID: null }
  const workspaceLocation = { directory: projectDirectory, workspaceID: "workspace-1" }
  store.enroll({
    request: enrollment("main-location", 0, { kind: "unallocated" }, "ses-main"),
    agent: "explore",
    boundarySequence: -1,
    nativeLocation: mainLocation,
  })
  store.enroll({
    request: enrollment("workspace-location", 0, { kind: "unallocated" }, "ses-workspace"),
    agent: "explore",
    boundarySequence: -1,
    nativeLocation: workspaceLocation,
  })

  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* registerManagedUsageNative(
          {
            location: mainLocation,
            event: { subscribe: () => Stream.never },
          } as never,
          capture,
          projectID,
        )
        yield* registerManagedUsageNative(
          {
            location: workspaceLocation,
            event: { subscribe: () => Stream.fail(new Error("worktree stream failed")) },
          } as never,
          capture,
          projectID,
        )
        for (let attempt = 0; attempt < 50; attempt++) {
          const snapshot = store.snapshot()
          if (snapshot.listenerGaps.some((gap) => gap.kind === "stream-failed")) return snapshot
          yield* Effect.sleep(10)
        }
        return store.snapshot()
      }),
    ),
  )

  expect(
    observed.listenerGaps.filter((gap) => gap.kind === "stream-failed").map((gap) => gap.sessionID),
  ).toEqual(["ses-workspace"])
  expect(observed.listenerGaps).toContainEqual(
    expect.objectContaining({ sessionID: "ses-main", kind: "listener-started" }),
  )
  expect(observed.listenerGaps).toContainEqual(
    expect.objectContaining({ sessionID: "ses-workspace", kind: "listener-started" }),
  )
})

test("registration aborts and joins deferred session reads before repository release", async () => {
  const { repository, store } = fixture()
  const capture = new ManagedUsageCapture(store)
  store.enroll({
    request: enrollment("teardown-base", 0, { kind: "unallocated" }),
    agent: "explore",
    boundarySequence: -1,
    nativeLocation: { directory: projectDirectory, workspaceID: null },
  })
  const readStarted = deferred()
  const readInterrupted = deferred()
  const keepOpen = deferred()
  const session = {
    id: "ses-managed",
    projectID,
    agent: "explore",
    location: { directory: projectDirectory, workspaceID: null },
    time: {},
  }
  const context = {
    location: { directory: projectDirectory, workspaceID: null },
    session: {
      get: () =>
        Effect.promise(
          (signal) =>
            new Promise<typeof session>((resolve) => {
              readStarted.resolve()
              signal.addEventListener(
                "abort",
                () => {
                  readInterrupted.resolve()
                  resolve(session)
                },
                { once: true },
              )
            }),
        ),
    },
    event: {
      subscribe: () =>
        Stream.concat(
          Stream.succeed(
            nativeEvent("session.step.started", "msg-interrupted", 1, "ses-managed", {
              directory: projectDirectory,
            }),
          ),
          Stream.never,
        ),
    },
  }

  const registration = Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* registerManagedUsageNative(context as never, capture, projectID)
        yield* Effect.promise(() => keepOpen.promise)
      }),
    ),
  )
  expect(await resolvesWithin(readStarted.promise, 1_000)).toBe(true)
  keepOpen.resolve()
  expect(await resolvesWithin(registration, 1_000)).toBe(true)
  expect(await resolvesWithin(readInterrupted.promise, 1_000)).toBe(true)
  expect(repository.isClosed).toBe(false)
  expect(store.snapshot().factCount).toBe(0)

  repository.close()
  expect(repository.isClosed).toBe(true)
})
