import { afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/plugin/effect"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../../src/storage.ts"
import { RunnerStore } from "../../src/runner/store.ts"
import { ManagedUsageEnrollmentInputSchema } from "../../src/managed-usage/contract.ts"
import type { ManagedUsageAssociation } from "../../src/managed-usage/contract.ts"
import { ManagedUsageCapture, managedUsageEventFact } from "../../src/managed-usage/native.ts"
import type { ManagedUsageNativeFact } from "../../src/managed-usage/contract.ts"
import { managedUsageGenerations } from "../../src/managed-usage/projection.ts"
import { readManagedUsageReport } from "../../src/managed-usage/report.ts"
import { ManagedUsageStore } from "../../src/managed-usage/store.ts"
import { managedUsageSchemaModule } from "../../src/managed-usage/schema.ts"
import type { ManagedUsagePriceProvider } from "../../src/models/managed-usage-valuation.ts"
import type { CurrentPriceIndex } from "../../src/models/valuation-schema.ts"
import {
  ManagedUsageValuationSchema,
  projectManagedUsageValuation,
} from "../../src/models/managed-usage-valuation.ts"
import { registerManagedUsageTools } from "../../src/managed-usage/tools.ts"

type RegisteredTool = Parameters<ToolEditor["add"]>[0]

const directories: string[] = []
const repositories: TaskRepository[] = []
const projectID = "project"
const projectDirectory = "/repo"
const planID = "11111111-1111-4111-8111-111111111111"
const taskID = "22222222-2222-4222-8222-222222222222"

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-managed-usage-"))
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
  return { directory, repository, store }
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function enrollment(input: {
  sessionID?: string
  expectedRevision?: number
  requestID?: string
  association?: ManagedUsageAssociation
}) {
  return ManagedUsageEnrollmentInputSchema.parse({
    requestID: input.requestID ?? "request-1",
    projectID,
    projectDirectory,
    sessionID: input.sessionID ?? "ses-managed",
    expectedRevision: input.expectedRevision ?? 0,
    association: input.association ?? { kind: "task", planID, taskID },
  })
}

function categories(input = { input: 7, output: 3, reasoning: 1, read: 2, write: 1 }) {
  return {
    uncachedInput: { tokens: input.input, status: "observed" as const },
    output: { tokens: input.output, status: "observed" as const },
    reasoning: { tokens: input.reasoning, status: "observed" as const },
    cacheRead: { tokens: input.read, status: "observed" as const },
    cacheWrite: { tokens: input.write, status: "observed" as const },
  }
}

function currentIndex(route: NonNullable<ManagedUsageNativeFact["route"]>): CurrentPriceIndex {
  const retrievedAt = "2026-11-11T00:00:00.000Z"
  return {
    indexID: "managed-usage-price-index",
    retrievedAt,
    pins: [
      {
        route,
        productID: "openai/gpt-test",
        configurationID: "managed-usage-test",
        semantics: "average",
        resolution: {
          route: "resolved",
          sku: "resolved",
          configuration: "resolved",
          tier: "not-applicable",
          schedule: "not-applicable",
        },
        tier: {
          id: null,
          contextTierTokens: null,
          minPromptTokens: null,
          utcStart: null,
          utcEnd: null,
        },
        rates: {
          unit: "USD per token",
          uncachedInput: "0.000001",
          completion: "0.000002",
          cacheRead: "0.0000005",
          cacheWrite: "0.000003",
        },
        provenance: {
          source: "openrouter-models",
          snapshotID: "33333333-3333-4333-8333-333333333333",
          generation: 1,
          retrievedAt,
          asOf: null,
          sourceURL: "https://openrouter.ai/api/v1/models",
          recordIndex: 0,
          recordID: "openai/gpt-test",
        },
      },
    ],
  }
}

type FactInput = {
  sessionID?: string
  eventKey: string
  type: "started" | "ended" | "failed"
  messageID: string
  sequence: number | null
  recordedAt?: number
  agent?: string | null
  route?: ManagedUsageNativeFact["route"]
  routeStatus?: ManagedUsageNativeFact["routeStatus"]
  categories?: ManagedUsageNativeFact["categories"]
}

function factIdentity(input: FactInput) {
  return {
    schemaVersion: 1 as const,
    sessionID: input.sessionID ?? "ses-managed",
    eventKey: input.eventKey,
    nativeEventID: input.eventKey.startsWith("id:") ? input.eventKey.slice(3) : null,
    eventType: input.type,
    assistantMessageID: input.messageID,
    sequence: input.sequence,
    eventCreatedAt: input.sequence ?? null,
    recordedAt: input.recordedAt ?? 100,
  }
}

function startedFactEvidence(input: FactInput) {
  return {
    agent: input.agent ?? "explore",
    route: input.route ?? { providerID: "openai", modelID: "gpt-test", variant: "fast" },
    routeStatus: input.routeStatus ?? ("observed" as const),
    categories: null,
  }
}

function terminalFactEvidence(input: FactInput) {
  return {
    agent: null,
    route: null,
    routeStatus: "not-applicable" as const,
    categories: input.categories ?? categories(),
  }
}

function factEvidence(input: FactInput) {
  return input.type === "started" ? startedFactEvidence(input) : terminalFactEvidence(input)
}

function fact(input: FactInput): ManagedUsageNativeFact {
  return {
    ...factIdentity(input),
    ...factEvidence(input),
  }
}

function enrollStore(store: ManagedUsageStore, request = enrollment({}), boundarySequence = 4) {
  return store.enroll({
    request,
    agent: "explore",
    boundarySequence,
    nativeLocation: { directory: projectDirectory, workspaceID: null },
  })
}

function nativeEvent(input: {
  type: "session.step.started" | "session.step.ended" | "session.step.failed"
  sessionID: string
  messageID: string
  sequence: number
}) {
  const data: Record<string, unknown> = {
    sessionID: input.sessionID,
    assistantMessageID: input.messageID,
  }
  if (input.type === "session.step.started")
    Object.assign(data, {
      agent: "explore",
      model: { providerID: "openai", id: "gpt-test", variant: "fast" },
    })
  if (input.type === "session.step.ended")
    Object.assign(data, {
      finish: "stop",
      cost: 99_999,
      tokens: { input: 7, output: 3, reasoning: 1, cache: { read: 2, write: 1 } },
      content: "PRIVATE_RESPONSE_BODY",
    })
  if (input.type === "session.step.failed")
    Object.assign(data, {
      error: {
        type: "provider",
        message: "PRIVATE_ERROR",
        response: { body: "PRIVATE_ERROR_BODY" },
      },
      tokens: { input: 4, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
  return {
    id: `event-${input.sequence}`,
    type: input.type,
    created: input.sequence,
    durable: { aggregateID: input.sessionID, seq: input.sequence, version: 1 },
    data,
  }
}

test("enrollment revisions are immutable boundaries; exact replay is idempotent and stale writes do not mutate", () => {
  const { store } = fixture()
  const firstRequest = enrollment({})
  const first = enrollStore(store, firstRequest, 4)
  expect(first).toMatchObject({ status: "enrolled", revision: 1, boundarySequence: 4 })
  expect(store.enroll({ request: firstRequest, agent: "explore", boundarySequence: 100 })).toEqual(
    first,
  )
  const reused = store.enroll({
    request: enrollment({ association: { kind: "plan", planID } }),
    agent: "explore",
    boundarySequence: 100,
  })
  expect(reused).toMatchObject({ status: "conflict", reason: "request-id-reused" })

  const stale = store.enroll({
    request: enrollment({
      requestID: "stale",
      expectedRevision: 0,
      association: { kind: "plan", planID },
    }),
    agent: "explore",
    boundarySequence: 5,
  })
  expect(stale).toMatchObject({ status: "conflict", reason: "stale-revision", currentRevision: 1 })
  const staleBoundary = store.enroll({
    request: enrollment({
      requestID: "stale-boundary",
      expectedRevision: 1,
      association: { kind: "plan", planID },
    }),
    agent: "explore",
    boundarySequence: 3,
  })
  expect(staleBoundary).toMatchObject({
    status: "conflict",
    reason: "stale-boundary",
    currentRevision: 1,
  })
  expect(store.snapshot().boundaryCount).toBe(1)

  store.appendFact(
    fact({ eventKey: "id:start-task", type: "started", messageID: "msg-task", sequence: 5 }),
  )
  store.appendFact(
    fact({ eventKey: "id:end-task", type: "ended", messageID: "msg-task", sequence: 6 }),
  )
  const nextRequest = enrollment({
    requestID: "request-2",
    expectedRevision: 1,
    association: { kind: "plan", planID },
  })
  store.enroll({ request: nextRequest, agent: "explore", boundarySequence: 7 })
  store.appendFact(
    fact({ eventKey: "id:end-plan", type: "ended", messageID: "msg-plan", sequence: 9 }),
  )
  store.appendFact(
    fact({ eventKey: "id:start-plan", type: "started", messageID: "msg-plan", sequence: 8 }),
  )

  const generations = managedUsageGenerations(store.snapshot())
  expect(
    generations.map(({ assistantMessageID, association, outcome }) => ({
      assistantMessageID,
      association,
      outcome,
    })),
  ).toEqual([
    { assistantMessageID: "msg-plan", association: { kind: "plan", planID }, outcome: "succeeded" },
    {
      assistantMessageID: "msg-task",
      association: { kind: "task", planID, taskID },
      outcome: "succeeded",
    },
  ])
  expect(store.currentRevision()).toBe(6)
})

test("managed usage revisions are initialized and fenced per project", () => {
  const { repository, store } = fixture()
  const otherRepository = new TaskRepository(repository.path, "/other")
  repositories.push(otherRepository)
  const otherStore = new ManagedUsageStore(otherRepository)
  expect(store.currentRevision()).toBe(0)
  expect(otherStore.currentRevision()).toBe(0)

  const first = enrollStore(store, enrollment({ requestID: "repo-enrollment" }), 4)
  expect(first).toMatchObject({ status: "enrolled", revision: 1 })
  expect(store.currentRevision()).toBe(1)
  expect(otherStore.currentRevision()).toBe(0)

  const otherRequest = ManagedUsageEnrollmentInputSchema.parse({
    requestID: "other-enrollment",
    projectID: "other",
    projectDirectory: "/other",
    sessionID: "ses-managed",
    expectedRevision: 0,
    association: { kind: "unallocated" },
  })
  const other = otherStore.enroll({
    request: otherRequest,
    agent: "explore",
    boundarySequence: 4,
  })
  expect(other).toMatchObject({ status: "enrolled", revision: 1 })
  expect(otherStore.currentRevision()).toBe(1)
  expect(store.sessionRevision("ses-managed")).toBe(1)
  expect(otherStore.sessionRevision("ses-managed")).toBe(1)
})

test("managed usage generation 1 schemas migrate without rewriting immutable evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-managed-usage-v1-"))
  directories.push(directory)
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), projectDirectory)
  repositories.push(repository)
  repository.installSchema("managed-usage", 1, managedUsageSchemaModule.tables, (db) => {
    db.exec(`
      CREATE TABLE managed_usage_meta (
        project_directory TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK(revision >= 0)
      );
      CREATE TABLE managed_usage_boundaries (
        project_directory TEXT NOT NULL,
        session_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        request_id TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        boundary_sequence INTEGER NOT NULL CHECK(boundary_sequence >= -1),
        managed_agent TEXT NOT NULL,
        association_kind TEXT NOT NULL CHECK(association_kind IN ('task','plan','unallocated')),
        plan_id TEXT,
        task_id TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(project_directory,session_id,revision),
        UNIQUE(project_directory,request_id)
      );
      CREATE TABLE managed_usage_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_directory TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        fact_json TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        UNIQUE(project_directory,session_id,event_key)
      );
      CREATE TABLE managed_usage_fact_conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_directory TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        fact_json TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        UNIQUE(project_directory,session_id,event_key,fingerprint)
      );
      CREATE TABLE managed_usage_capture_gaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_directory TEXT NOT NULL,
        listener_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        UNIQUE(project_directory,listener_id,session_id,kind)
      );
    `)
  })
  const store = new ManagedUsageStore(repository)
  const result = store.enroll({
    request: enrollment({ association: { kind: "unallocated" } }),
    agent: "explore",
    boundarySequence: 4,
    excludedAssistantMessageID: "msg-enrollment",
  })
  expect(result.status).toBe("enrolled")
  store.appendFact(
    fact({
      eventKey: "id:migrated-start",
      type: "started",
      messageID: "msg-migrated",
      sequence: 7,
    }),
  )
  expect(store.latestSequence("ses-managed")).toBe(7)
  expect(store.snapshot().boundaries[0]?.excludedAssistantMessageID).toBe("msg-enrollment")
  const drift = repository.schemaDrift()
  const managedTables = new Set<string>(managedUsageSchemaModule.tables)
  expect(drift.generationDrift.some((entry) => entry.module === "managed-usage")).toBe(false)
  expect(drift.missingTables.filter((table) => managedTables.has(table))).toEqual([])
})

test("enrollment buffers native events and stores only generations after the durable boundary", async () => {
  const { store } = fixture()
  const capture = new ManagedUsageCapture(store)
  const pending = capture.beginEnrollment("ses-managed")
  expect(capture.boundarySequence("ses-managed")).toBe(-1)
  const startDuringEnrollment = nativeEvent({
    type: "session.step.started",
    sessionID: "ses-managed",
    messageID: "msg-during",
    sequence: 5,
  })
  const endDuringEnrollment = nativeEvent({
    type: "session.step.ended",
    sessionID: "ses-managed",
    messageID: "msg-during",
    sequence: 6,
  })
  for (const event of [startDuringEnrollment, endDuringEnrollment])
    await capture.observe(
      event,
      {
        session: {
          get: () =>
            Effect.succeed({
              id: "ses-managed",
              projectID,
              agent: "explore",
              time: {},
            }),
        },
      } as never,
      projectID,
      "listener",
    )

  const boundary = capture.boundarySequence("ses-managed")
  expect(boundary).toBe(6)
  const enrolled = store.enroll({
    request: enrollment({}),
    agent: "explore",
    boundarySequence: boundary,
  })
  if (enrolled.status !== "enrolled") throw new Error("Expected session enrollment")
  pending.finish(enrolled.boundarySequence, true)

  for (const event of [
    nativeEvent({
      type: "session.step.started",
      sessionID: "ses-managed",
      messageID: "msg-after",
      sequence: 7,
    }),
    nativeEvent({
      type: "session.step.ended",
      sessionID: "ses-managed",
      messageID: "msg-after",
      sequence: 8,
    }),
  ])
    await capture.observe(
      event,
      {
        session: {
          get: () =>
            Effect.succeed({
              id: "ses-managed",
              projectID,
              agent: "explore",
              time: {},
            }),
        },
      } as never,
      projectID,
      "listener",
    )

  expect(store.snapshot().factCount).toBe(2)
  expect(
    managedUsageGenerations(store.snapshot()).map((generation) => generation.assistantMessageID),
  ).toEqual(["msg-after"])
})

test("enrollment preserves an event with no usable durable sequence as unallocated evidence", async () => {
  const { store } = fixture()
  const capture = new ManagedUsageCapture(store)
  const pending = capture.beginEnrollment("ses-managed")
  const start = nativeEvent({
    type: "session.step.started",
    sessionID: "ses-managed",
    messageID: "msg-unsequenced",
    sequence: 5,
  })
  start.durable.aggregateID = "ses-other"
  await capture.observe(
    start,
    { session: { get: () => Effect.succeed({}) } } as never,
    projectID,
    "listener",
  )
  const result = enrollStore(store, enrollment({}), 4)
  if (result.status !== "enrolled") throw new Error("Expected session enrollment")
  pending.finish(result.boundarySequence, true)

  expect(store.snapshot().factCount).toBe(1)
  expect(managedUsageGenerations(store.snapshot())[0]).toMatchObject({
    assistantMessageID: "msg-unsequenced",
    startSequence: null,
    association: { kind: "unallocated" },
  })
  expect(store.snapshot().listenerGaps).toContainEqual(
    expect.objectContaining({ sessionID: "ses-managed", kind: "unsequenced-event" }),
  )
})

test("an unidentified native event during enrollment leaves an honest coverage gap", async () => {
  const { store } = fixture()
  const capture = new ManagedUsageCapture(store)
  const pending = capture.beginEnrollment("ses-managed")
  await capture.observe(
    {
      type: "session.step.started",
      durable: { aggregateID: "ses-managed", seq: 5 },
      data: { assistantMessageID: "msg-without-session" },
    },
    { session: { get: () => Effect.succeed({}) } } as never,
    projectID,
    "listener",
  )

  const result = enrollStore(store, enrollment({}), 4)
  if (result.status !== "enrolled") throw new Error("Expected session enrollment")
  pending.finish(result.boundarySequence, true)

  expect(store.snapshot().factCount).toBe(0)
  expect(store.snapshot().listenerGaps).toContainEqual(
    expect.objectContaining({ sessionID: "ses-managed", kind: "unidentified-event" }),
  )
})

test("native capture deduplicates replays, handles terminal-before-start and stores neither body nor self-reported cost", async () => {
  const { store } = fixture()
  enrollStore(store)
  const capture = new ManagedUsageCapture(store)
  const session = {
    id: "ses-managed",
    projectID,
    agent: "explore",
    parentID: "ses-architect",
    location: { directory: projectDirectory },
    time: {},
  }
  const ctx = {
    location: { directory: projectDirectory },
    session: {
      get: ({ sessionID }: { sessionID: string }) =>
        String(sessionID) === session.id
          ? Effect.succeed(session)
          : Effect.fail(new Error("missing")),
    },
  }
  const terminal = nativeEvent({
    type: "session.step.ended",
    sessionID: session.id,
    messageID: "msg-native",
    sequence: 6,
  })
  const started = nativeEvent({
    type: "session.step.started",
    sessionID: session.id,
    messageID: "msg-native",
    sequence: 5,
  })
  expect(managedUsageEventFact(terminal)).toMatchObject({
    eventType: "ended",
    categories: categories(),
  })
  expect(JSON.stringify(managedUsageEventFact(terminal))).not.toContain("PRIVATE_RESPONSE_BODY")
  expect(JSON.stringify(managedUsageEventFact(terminal))).not.toContain("99999")
  await capture.observe(terminal, ctx as never, projectID, "listener")
  await capture.observe(terminal, ctx as never, projectID, "listener")
  await capture.observe(started, ctx as never, projectID, "listener")
  const snapshot = store.snapshot()
  const generations = managedUsageGenerations(snapshot)
  expect(generations).toHaveLength(1)
  expect(generations[0]).toMatchObject({
    assistantMessageID: "msg-native",
    route: { providerID: "openai", modelID: "gpt-test", variant: "fast" },
    outcome: "succeeded",
    status: "observed",
    association: { kind: "task", planID, taskID },
    categories: categories(),
  })
  const persisted = JSON.stringify(snapshot)
  expect(persisted).not.toContain("PRIVATE_RESPONSE_BODY")
  expect(persisted).not.toContain("PRIVATE_ERROR")
  expect(persisted).not.toContain("99999")
  expect(snapshot.factCount).toBe(2)
})

test("native facts, immutable associations, and listener gaps survive database reopen", () => {
  const { repository, store } = fixture()
  enrollStore(store)
  store.appendFact(
    fact({ eventKey: "id:reopen-start", type: "started", messageID: "msg-reopen", sequence: 5 }),
  )
  store.appendFact(
    fact({ eventKey: "id:reopen-end", type: "ended", messageID: "msg-reopen", sequence: 6 }),
  )
  store.recordGap({
    listenerID: "listener-before-restart",
    sessionID: "ses-managed",
    kind: "stream-failed",
  })
  const before = store.snapshot()

  repository.close()
  repositories.splice(repositories.indexOf(repository), 1)
  const reopenedRepository = new TaskRepository(repository.path, projectDirectory)
  repositories.push(reopenedRepository)
  const reopenedStore = new ManagedUsageStore(reopenedRepository)
  const after = reopenedStore.snapshot()
  expect(after).toMatchObject({
    revision: before.revision,
    factCount: before.factCount,
    boundaryCount: before.boundaryCount,
    listenerGapCount: before.listenerGapCount,
    boundaries: before.boundaries,
    facts: before.facts,
    listenerGaps: before.listenerGaps,
  })
  expect(managedUsageGenerations(after)[0]).toMatchObject({
    assistantMessageID: "msg-reopen",
    route: { providerID: "openai", modelID: "gpt-test", variant: "fast" },
    association: { kind: "task", planID, taskID },
    status: "observed",
  })
  reopenedStore.recordGapForAll({ listenerID: "listener-after-restart", kind: "listener-started" })
  expect(reopenedStore.snapshot().listenerGapCount).toBe(after.listenerGapCount + 1)
})

test("a native event whose durable sequence belongs to another session remains unallocated", async () => {
  const { store } = fixture()
  enrollStore(store)
  const capture = new ManagedUsageCapture(store)
  const session = {
    id: "ses-managed",
    projectID,
    agent: "explore",
    location: { directory: projectDirectory },
    time: {},
  }
  const event = nativeEvent({
    type: "session.step.started",
    sessionID: session.id,
    messageID: "msg-mismatched-sequence",
    sequence: 7,
  })
  event.durable.aggregateID = "ses-other"
  await capture.observe(
    event,
    { session: { get: () => Effect.succeed(session) } } as never,
    projectID,
    "listener",
  )
  const generation = managedUsageGenerations(store.snapshot())[0]!
  expect(generation).toMatchObject({
    assistantMessageID: "msg-mismatched-sequence",
    startSequence: null,
    association: { kind: "unallocated" },
    associationReason: "Native generation start has no durable sequence",
  })
})

function callContext() {
  return {
    sessionID: Session.ID.make("ses-architect"),
    agent: Agent.ID.make("architect"),
    messageID: "msg-architect",
    id: "call-managed-usage",
    progress: () => Effect.void,
  } as never
}

function registeredTools() {
  const tools = new Map<string, RegisteredTool>()
  const editor: ToolEditor = {
    add: (tool) => tools.set(tool.name, tool),
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    update: () => {},
    remove: () => {},
  }
  return { tools, editor }
}

test("registered enrollment authorizes caller and target before failing closed without writes", async () => {
  const { store } = fixture()
  const sessions = new Map<string, Record<string, unknown>>([
    [
      "ses-architect",
      {
        id: "ses-architect",
        projectID,
        agent: "architect",
        location: { directory: projectDirectory },
        time: {},
      },
    ],
    [
      "ses-managed",
      {
        id: "ses-managed",
        projectID,
        parentID: "ses-architect",
        agent: "explore",
        location: { directory: projectDirectory },
        time: {},
      },
    ],
    [
      "ses-worker",
      {
        id: "ses-worker",
        projectID,
        parentID: "ses-architect",
        agent: "lazers-implementor",
        location: { directory: projectDirectory },
        time: {},
      },
    ],
    [
      "ses-unrelated",
      {
        id: "ses-unrelated",
        projectID,
        parentID: "ses-other",
        agent: "explore",
        location: { directory: projectDirectory },
        time: {},
      },
    ],
    [
      "ses-foreign",
      {
        id: "ses-foreign",
        projectID: "foreign",
        parentID: "ses-architect",
        agent: "explore",
        location: { directory: "/foreign" },
        time: {},
      },
    ],
    [
      "ses-becomes-worker",
      {
        id: "ses-becomes-worker",
        projectID,
        parentID: "ses-architect",
        agent: "explore",
        location: { directory: projectDirectory },
        time: {},
      },
    ],
  ])
  const permissionCalls: string[] = []
  const { tools, editor } = registeredTools()
  let targetReads = 0
  let changeTargetOnSecondRead = false
  const context = {
    location: { project: { id: projectID, canonical: projectDirectory } },
    permission: {
      assert: ({ action }: { action: string }) => {
        permissionCalls.push(action)
        return Effect.void
      },
    },
    session: {
      get: ({ sessionID }: { sessionID: string }) => {
        const value = sessions.get(String(sessionID))
        if (
          changeTargetOnSecondRead &&
          String(sessionID) === "ses-becomes-worker" &&
          ++targetReads === 2 &&
          value
        )
          value.agent = "lazers-implementor"
        return value ? Effect.succeed(value) : Effect.fail(new Error("not found"))
      },
    },
    tool: {
      transform: (callback: (value: ToolEditor) => void) =>
        Effect.sync(() => {
          callback(editor)
          return { dispose: Effect.void }
        }),
    },
  }
  let priceReads = 0
  const priceReadEffect: { current?: () => void } = {}
  const priceProvider: ManagedUsagePriceProvider = async (calls) => {
    priceReads++
    priceReadEffect.current?.()
    return projectManagedUsageValuation({ calls, index: null, freshness: "unknown" })
  }

  await Effect.runPromise(
    Effect.scoped(
      registerManagedUsageTools({
        ctx: context as never,
        store,
        projectID,
        projectDirectory,
        priceProvider,
      }),
    ),
  )
  const enrollTool = tools.get("lz-enroll-managed-usage")!
  const request = {
    requestID: "authorized-enroll",
    projectID,
    projectDirectory,
    sessionID: "ses-managed",
    expectedRevision: 0,
    association: { kind: "task", planID, taskID },
  }
  const enrollmentUnavailable = /cannot prove a future-generation boundary/
  await expect(Effect.runPromise(enrollTool.execute(request, callContext()))).rejects.toThrow(
    enrollmentUnavailable,
  )
  await expect(Effect.runPromise(enrollTool.execute(request, callContext()))).rejects.toThrow(
    enrollmentUnavailable,
  )

  await expect(
    Effect.runPromise(
      enrollTool.execute({ ...request, requestID: "stale-request" }, callContext()),
    ),
  ).rejects.toThrow(enrollmentUnavailable)
  expect(store.sessionRevision("ses-managed")).toBe(0)
  expect(store.snapshot().boundaryCount).toBe(0)

  changeTargetOnSecondRead = true
  await expect(
    Effect.runPromise(
      enrollTool.execute(
        {
          ...request,
          sessionID: "ses-becomes-worker",
          requestID: "role-changed-during-enrollment",
        },
        callContext(),
      ),
    ),
  ).rejects.toThrow()
  expect(store.sessionRevision("ses-becomes-worker")).toBe(0)

  for (const sessionID of ["ses-worker", "ses-unrelated", "ses-foreign"]) {
    await expect(
      Effect.runPromise(
        enrollTool.execute({ ...request, sessionID, requestID: `bad-${sessionID}` }, callContext()),
      ),
    ).rejects.toThrow()
  }
  expect(permissionCalls.filter((action) => action === "lz-enroll-managed-usage")).toHaveLength(7)

  const readTool = tools.get("lz-read-managed-usage")!
  const foreignScopes = [
    { kind: "project", projectID: "foreign", projectDirectory },
    { kind: "plan", projectID, projectDirectory, planID: "33333333-3333-4333-8333-333333333333" },
    {
      kind: "task",
      projectID,
      projectDirectory,
      planID,
      taskID: "44444444-4444-4444-8444-444444444444",
    },
  ]
  for (const scope of foreignScopes)
    await expect(
      Effect.runPromise(readTool.execute({ scope, limit: 20 }, callContext())),
    ).rejects.toThrow()
  expect(priceReads).toBe(0)
  expect(store.sessionRevision("ses-managed")).toBe(0)

  priceReadEffect.current = () => {
    sessions.get("ses-architect")!.time = { archived: Date.now() }
  }
  await expect(
    Effect.runPromise(
      readTool.execute(
        { scope: { kind: "project", projectID, projectDirectory }, limit: 20 },
        callContext(),
      ),
    ),
  ).rejects.toThrow()
  expect(priceReads).toBe(1)
  expect(store.currentRevision()).toBe(0)
})

test("concurrent public enrollment attempts fail closed without writing attribution", async () => {
  const { store } = fixture()
  const sessions = new Map<string, Record<string, unknown>>([
    [
      "ses-architect",
      {
        id: "ses-architect",
        projectID,
        agent: "architect",
        location: { directory: projectDirectory },
        time: {},
      },
    ],
    [
      "ses-managed",
      {
        id: "ses-managed",
        projectID,
        parentID: "ses-architect",
        agent: "explore",
        location: { directory: projectDirectory },
        time: {},
      },
    ],
  ])
  const { tools, editor } = registeredTools()
  const context = {
    location: { project: { id: projectID, canonical: projectDirectory } },
    permission: { assert: () => Effect.void },
    session: {
      get: ({ sessionID }: { sessionID: string }) => {
        const value = sessions.get(String(sessionID))
        return value ? Effect.succeed(value) : Effect.fail(new Error("not found"))
      },
    },
    tool: {
      transform: (callback: (value: ToolEditor) => void) =>
        Effect.sync(() => {
          callback(editor)
          return { dispose: Effect.void }
        }),
    },
  }
  await Effect.runPromise(
    Effect.scoped(
      registerManagedUsageTools({
        ctx: context as never,
        store,
        projectID,
        projectDirectory,
        priceProvider: async (calls) =>
          projectManagedUsageValuation({ calls, index: null, freshness: "unknown" }),
      }),
    ),
  )
  const enrollTool = tools.get("lz-enroll-managed-usage")!
  const request = {
    requestID: "concurrent-first",
    projectID,
    projectDirectory,
    sessionID: "ses-managed",
    expectedRevision: 0,
    association: { kind: "task", planID, taskID },
  }
  const results = await Promise.allSettled([
    Effect.runPromise(enrollTool.execute(request, callContext())),
    Effect.runPromise(
      enrollTool.execute({ ...request, requestID: "concurrent-second" }, callContext()),
    ),
  ])
  expect(results.every((result) => result.status === "rejected")).toBe(true)
  expect(store.snapshot()).toMatchObject({ boundaryCount: 0, factCount: 0, revision: 0 })
})

test("registered managed usage read returns a task-attributed current-market quote", async () => {
  const { store } = fixture()
  enrollStore(store)
  store.appendFact(
    fact({ eventKey: "id:read-start", type: "started", messageID: "msg-read", sequence: 5 }),
  )
  store.appendFact(
    fact({ eventKey: "id:read-end", type: "ended", messageID: "msg-read", sequence: 6 }),
  )

  const sessions = new Map<string, Record<string, unknown>>([
    [
      "ses-architect",
      {
        id: "ses-architect",
        projectID,
        agent: "architect",
        location: { directory: projectDirectory },
        time: {},
      },
    ],
  ])
  const { tools, editor } = registeredTools()
  const context = {
    location: { project: { id: projectID, canonical: projectDirectory } },
    permission: { assert: () => Effect.void },
    session: {
      get: ({ sessionID }: { sessionID: string }) => {
        const value = sessions.get(String(sessionID))
        return value ? Effect.succeed(value) : Effect.fail(new Error("not found"))
      },
    },
    tool: {
      transform: (callback: (value: ToolEditor) => void) =>
        Effect.sync(() => {
          callback(editor)
          return { dispose: Effect.void }
        }),
    },
  }
  const route = { providerID: "openai", modelID: "gpt-test", variant: "fast" }
  const priceProvider: ManagedUsagePriceProvider = async (calls) =>
    projectManagedUsageValuation({
      calls,
      index: currentIndex(route),
      freshness: "current",
    })

  await Effect.runPromise(
    Effect.scoped(
      registerManagedUsageTools({
        ctx: context as never,
        store,
        projectID,
        projectDirectory,
        priceProvider,
      }),
    ),
  )
  const read = await Effect.runPromise(
    tools
      .get("lz-read-managed-usage")!
      .execute(
        { scope: { kind: "task", projectID, projectDirectory, planID, taskID }, limit: 20 },
        callContext(),
      ),
  )
  expect(read.output).toMatchObject({
    coverage: { generationCount: 1, status: "unavailable" },
    totals: { generationCount: 1, valueUSD: 0.000019, subtotalUSD: 0.000019, status: "observed" },
    calls: [
      {
        assistantMessageID: "msg-read",
        association: { kind: "task", planID, taskID },
        quote: { valueUSD: 0.000019, status: "observed", pinStatus: "resolved" },
      },
    ],
    currentPrice: {
      freshness: "current",
      pins: [{ provenance: { source: "openrouter-models", recordID: "openai/gpt-test" } }],
    },
  })
})

function priceProvider(priceRevision: string): ManagedUsagePriceProvider {
  return async (calls) => {
    const valuation = projectManagedUsageValuation({ calls, index: null, freshness: "unknown" })
    return ManagedUsageValuationSchema.parse({
      ...valuation,
      currentPrice: {
        indexID: priceRevision,
        retrievedAt: new Date().toISOString(),
        freshness: "current",
        policy: null,
        access: null,
        pins: [],
      },
    })
  }
}

test("plan valuation counts the unique union of two task calls and a plan-only call once", async () => {
  const { repository, store } = fixture()
  const secondTaskID = "55555555-5555-4555-8555-555555555555"
  repository.atomic((db) => {
    db.query("INSERT INTO tasks(id,project_directory,created_at,body) VALUES(?,?,?,?)").run(
      secondTaskID,
      projectDirectory,
      new Date().toISOString(),
      "{}",
    )
    db.query(
      `INSERT INTO runner_nodes(
        plan_id,task_id,spec_revision,ordinal,state,version,reason,artifact,snapshot,machine_version
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(planID, secondTaskID, 1, 1, "ready", 1, null, null, "{}", "1")
  })
  enrollStore(store, enrollment({ requestID: "task-one" }), 4)
  store.appendFact(
    fact({ eventKey: "id:start-one", type: "started", messageID: "msg-one", sequence: 5 }),
  )
  store.appendFact(
    fact({ eventKey: "id:end-one", type: "ended", messageID: "msg-one", sequence: 6 }),
  )
  store.enroll({
    request: enrollment({
      requestID: "task-two",
      expectedRevision: 1,
      association: { kind: "task", planID, taskID: secondTaskID },
    }),
    agent: "explore",
    boundarySequence: 7,
  })
  store.appendFact(
    fact({ eventKey: "id:start-two", type: "started", messageID: "msg-two", sequence: 8 }),
  )
  store.appendFact(
    fact({ eventKey: "id:end-two", type: "ended", messageID: "msg-two", sequence: 9 }),
  )
  store.enroll({
    request: enrollment({
      requestID: "plan-only",
      expectedRevision: 2,
      association: { kind: "plan", planID },
    }),
    agent: "explore",
    boundarySequence: 10,
  })
  store.appendFact(
    fact({
      eventKey: "id:start-plan-only",
      type: "started",
      messageID: "msg-plan-only",
      sequence: 11,
    }),
  )
  store.appendFact(
    fact({ eventKey: "id:end-plan-only", type: "ended", messageID: "msg-plan-only", sequence: 12 }),
  )

  const cursorSecret = new Uint8Array(32).fill(5)
  const plan = await readManagedUsageReport({
    store,
    priceProvider: priceProvider("price-plan-union"),
    request: { scope: { kind: "plan", projectID, projectDirectory, planID }, limit: 10 },
    cursorSecret,
    signal: new AbortController().signal,
  })
  expect(plan.totals.generationCount).toBe(3)
  expect(plan.calls.map((call) => call.assistantMessageID)).toEqual([
    "msg-one",
    "msg-plan-only",
    "msg-two",
  ])
  expect(plan.allocationSummaries).toHaveLength(3)
  expect(
    plan.allocationSummaries.reduce(
      (total, allocation) => total + allocation.totals.generationCount,
      0,
    ),
  ).toBe(3)

  const task = await readManagedUsageReport({
    store,
    priceProvider: priceProvider("price-task-union"),
    request: { scope: { kind: "task", projectID, projectDirectory, planID, taskID }, limit: 10 },
    cursorSecret,
    signal: new AbortController().signal,
  })
  expect(task.totals.generationCount).toBe(1)
  expect(task.calls[0]?.assistantMessageID).toBe("msg-one")
})

test("report deduplicates generations, pages against fixed capture and price revisions, and preserves unallocated coverage", async () => {
  const { store } = fixture()
  const request = enrollment({ association: { kind: "unallocated" } })
  enrollStore(store, request, 4)
  for (const [messageID, seq] of [
    ["msg-a", 5],
    ["msg-b", 8],
  ] as const) {
    const start = fact({
      eventKey: `id:start-${messageID}`,
      type: "started",
      messageID,
      sequence: seq,
    })
    const terminal = fact({
      eventKey: `id:end-${messageID}`,
      type: "ended",
      messageID,
      sequence: seq + 1,
    })
    store.appendFact(terminal)
    store.appendFact({ ...terminal, recordedAt: terminal.recordedAt + 1 })
    store.appendFact(start)
  }
  const scope = { kind: "project" as const, projectID, projectDirectory }
  const cursorSecret = new Uint8Array(32).fill(9)
  const first = await readManagedUsageReport({
    store,
    priceProvider: priceProvider("price-v1"),
    request: { scope, limit: 1 },
    cursorSecret,
    signal: new AbortController().signal,
  })
  expect(first.coverage).toMatchObject({ generationCount: 2, unallocatedGenerationCount: 2 })
  expect(first.calls).toHaveLength(1)
  expect(first.nextCursor).not.toBeNull()

  const cancelled = new AbortController()
  cancelled.abort()
  let cancelledPriceReads = 0
  await expect(
    readManagedUsageReport({
      store,
      priceProvider: async (calls) => {
        cancelledPriceReads++
        return projectManagedUsageValuation({ calls, index: null, freshness: "unknown" })
      },
      request: { scope, limit: 1 },
      cursorSecret,
      signal: cancelled.signal,
    }),
  ).rejects.toThrow()
  expect(cancelledPriceReads).toBe(0)
  const second = await readManagedUsageReport({
    store,
    priceProvider: priceProvider("price-v1"),
    request: { scope, limit: 1, cursor: first.nextCursor! },
    cursorSecret,
    signal: new AbortController().signal,
  })
  expect(second.calls).toHaveLength(1)
  expect(second.nextCursor).toBeNull()

  await expect(
    readManagedUsageReport({
      store,
      priceProvider: priceProvider("price-v2"),
      request: { scope, limit: 1, cursor: first.nextCursor! },
      cursorSecret,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("current prices changed")

  await expect(
    readManagedUsageReport({
      store,
      priceProvider: priceProvider("price-v1"),
      request: {
        scope: { kind: "project", projectID: "other", projectDirectory: "/repo" },
        limit: 1,
        cursor: first.nextCursor!,
      },
      cursorSecret,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("does not match")

  store.recordGap({ listenerID: "listener", sessionID: "ses-managed", kind: "stream-failed" })
  await expect(
    readManagedUsageReport({
      store,
      priceProvider: priceProvider("price-v1"),
      request: { scope, limit: 1, cursor: first.nextCursor! },
      cursorSecret,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("capture changed")
})

test("fact conflicts fail closed and unavailable categories remain unknown instead of zero", () => {
  const { store } = fixture()
  enrollStore(store)
  const original = fact({
    eventKey: "id:terminal",
    type: "ended",
    messageID: "msg-conflict",
    sequence: 6,
  })
  store.appendFact(original)
  expect(store.appendFact({ ...original, recordedAt: original.recordedAt + 10 })).toBe("duplicate")
  expect(
    store.appendFact({
      ...original,
      categories: categories({ input: 999, output: 1, reasoning: 0, read: 0, write: 0 }),
    }),
  ).toBe("conflict")
  store.appendFact(
    fact({
      eventKey: "id:start-conflict",
      type: "started",
      messageID: "msg-conflict",
      sequence: 5,
    }),
  )
  const generation = managedUsageGenerations(store.snapshot())[0]!
  expect(generation).toMatchObject({
    outcome: "conflicting",
    status: "unavailable",
    association: { kind: "unallocated" },
  })
  expect(generation.categories.uncachedInput).toEqual({ tokens: null, status: "unavailable" })
})
