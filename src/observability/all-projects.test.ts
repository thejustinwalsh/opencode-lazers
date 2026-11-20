import { afterEach, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Stream } from "effect"
import { addAttempt, addPlan, addTask, threeProjects } from "../../test/projects/three-projects.ts"
import { encodeUnitCursor, projectUnits } from "../projects/scope.ts"
import type { ProjectUnit } from "../projects/scope.ts"
import { RunnerStore } from "../runner/store.ts"
import { ObservationChangeTracker } from "./changes.ts"
import {
  LiveGroupOutput,
  LiveRadarOutput,
  RadarOutput,
  SnapshotOutput,
  TopologyOutput,
} from "./contract.ts"
import { ObservationReads } from "./read.ts"
import { registerObservability } from "./rpc.ts"
import { AssociationTaskReads } from "./task-reads.ts"
import { registerTaskReads } from "../tasks/rpc.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const secret = new Uint8Array(32).fill(7)
const host = { session: async () => null, status: async () => null }

const emptyInventory = { sessions: [], truncated: false }
const nativeSessions = {
  get: async () => null,
  project: async () => emptyInventory,
  descendants: async () => emptyInventory,
}

async function fixture(live: (three: Awaited<ReturnType<typeof threeProjects>>) => string[]) {
  const three = await threeProjects()
  const [a] = three.projects
  const reads = new ObservationReads(
    new RunnerStore(a!.repository),
    host,
    "project",
    secret,
    nativeSessions,
  )
  const tracker = new ObservationChangeTracker(a!.repository, secret, "project")
  tracker.initialize()
  const units = () => projectUnits(a!.repository, () => live(three))
  cleanups.push(() => three.close())
  return { three, reads, tracker, units }
}

const all = { kind: "all" as const, sessionID: "ses-caller" }

async function pages(
  reads: ObservationReads,
  tracker: ObservationChangeTracker,
  units: () => ProjectUnit[],
) {
  const result: Awaited<ReturnType<ObservationReads["topologyAll"]>>[] = []
  let cursor: string | undefined
  do {
    const page = await reads.topologyAll({ scope: all, ...(cursor ? { cursor } : {}) }, tracker, {
      units: units(),
    })
    result.push(page)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return result
}

test("all returns each project's plans on its own page with the right code and loaded flag", async () => {
  const { three, reads, tracker, units } = await fixture((t) => [
    t.projects[0]!.directory,
    t.projects[1]!.directory,
  ])
  const result = await pages(reads, tracker, units)
  expect(result.map((page) => [page.project?.code, page.project?.loaded])).toEqual([
    ["AAA", true],
    ["BBB", true],
    ["CCC", false],
  ])
  for (const [index, page] of result.entries()) {
    expect(TopologyOutput.safeParse(page).success).toBe(true)
    expect(page.scope).toEqual({ kind: "all" })
    expect(page.plans.map((plan) => plan.id)).toEqual(three.projects[index]!.planIDs)
    for (const plan of page.plans) expect(plan.project).toEqual(page.project)
  }
  expect(result.at(-1)?.nextCursor).toBeNull()
  expect(result[0]?.unplannedTasks.map((task) => task.project?.code)).toEqual(["AAA", "AAA"])
  expect(result[1]?.unplannedTasks).toEqual([])
})

test("a project that is not loaded is still readable, and later pages see a location that loads", async () => {
  let live: string[] = []
  const { three, reads, tracker, units } = await fixture(() => live)
  const first = await reads.topologyAll({ scope: all }, tracker, { units: units() })
  expect(first.project?.loaded).toBe(false)
  expect(first.plans).toHaveLength(1)
  live = [three.projects[1]!.directory]
  const second = await reads.topologyAll({ scope: all, cursor: first.nextCursor! }, tracker, {
    units: units(),
  })
  expect(second.project).toMatchObject({ code: "BBB", loaded: true })
})

test("a second checkout of one project is its own page under the same project", async () => {
  const { three, reads, tracker, units } = await fixture(() => [])
  const [a] = three.projects
  const { mkdirSync } = await import("node:fs")
  const { join } = await import("node:path")
  const second = join(three.parent, "alpha-second")
  mkdirSync(second)
  const { registerProject } = await import("../project-key.ts")
  const { TaskRepository } = await import("../storage.ts")
  const repository = new TaskRepository(three.path, second)
  cleanups.push(() => repository.close())
  await Bun.spawn(["git", "-C", second, "init", "-q", "-b", "main"]).exited
  await Bun.spawn(["git", "-C", second, "remote", "add", "origin", "git@h.com:o/alpha.git"]).exited
  const registered = await registerProject(repository, {
    directory: second,
    opencodeProjectID: "opencode-alpha",
  })
  expect(registered.key).toBe(a!.key)
  const planned = addTask(repository, "second checkout task")
  const planID = addPlan(repository, [planned])
  const result = await pages(reads, tracker, units)
  expect(result.map((page) => page.project?.code)).toEqual(["AAA", "AAA", "BBB", "CCC"])
  expect(result[1]?.plans.map((plan) => plan.id)).toEqual([planID])
  expect(result[1]?.plans[0]?.project?.key).toBe(a!.key)
})

test("session and project scopes read exactly as before and carry no project", async () => {
  const { reads, tracker } = await fixture(() => [])
  const project = reads.topology({ kind: "project", sessionID: "ses-caller" }, tracker)
  expect(project.scope).toEqual({ kind: "project" })
  expect(project.project).toBeUndefined()
  expect("nextCursor" in project).toBe(false)
  for (const plan of project.plans) expect("project" in plan).toBe(false)
  const session = reads.topology({ kind: "session", sessionID: "session-a" }, tracker)
  expect(session.scope).toEqual({ kind: "session", sessionID: "session-a" })
  for (const plan of session.plans) expect("project" in plan).toBe(false)
})

async function walk<
  T extends { nextCursor?: string | null; project?: { code: string; loaded: boolean } },
>(read: (cursor?: string) => Promise<T>) {
  const result: T[] = []
  let cursor: string | undefined
  do {
    const page = await read(cursor)
    result.push(page)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return result
}

test("snapshot, radar, live radar and live groups page by project with the same stamp", async () => {
  const { reads, tracker, units } = await fixture((t) => [t.projects[1]!.directory])
  const signal = new AbortController().signal
  const access = () => ({ units: units() })
  const snapshots = await walk((cursor) =>
    reads.snapshotAll({ scope: all, ...(cursor ? { cursor } : {}) }, tracker, access(), signal),
  )
  expect(snapshots.map((page) => page.project?.code)).toEqual(["AAA", "BBB", "CCC"])
  expect(snapshots.every((page) => SnapshotOutput.safeParse(page).success)).toBe(true)
  for (const page of snapshots)
    for (const plan of page.plans) expect(plan.project).toEqual(page.project)

  const radar = await walk((cursor) =>
    reads.radarAll(
      { scope: all, includeUnmanagedSessions: true, ...(cursor ? { cursor } : {}) },
      tracker,
      signal,
      access(),
    ),
  )
  expect(radar.map((page) => [page.project?.code, page.project?.loaded])).toEqual([
    ["AAA", false],
    ["BBB", true],
    ["CCC", false],
  ])
  expect(radar.every((page) => RadarOutput.safeParse(page).success)).toBe(true)
  // Another location's native sessions are not readable here: unavailable, never invented.
  for (const page of radar.slice(1)) {
    expect(page.freshness.nativeInventory).toBe("unavailable")
    for (const session of page.sessions) {
      expect(session.availability).toBe("unavailable")
      expect(session.state).toBe("unknown")
    }
  }

  const live = await walk((cursor) =>
    reads.liveRadarAll(
      { scope: all, includeUnmanagedSessions: false, ...(cursor ? { cursor } : {}) },
      tracker,
      signal,
      access(),
    ),
  )
  expect(live.map((page) => page.project?.code)).toEqual(["AAA", "BBB", "CCC"])
  expect(live.every((page) => LiveRadarOutput.safeParse(page).success)).toBe(true)
  for (const page of live.slice(1))
    for (const session of page.sessions) expect(session.state).toBe("unknown")

  const groups = await walk((cursor) =>
    reads.liveGroupAll(
      { scope: all, group: "queued", ...(cursor ? { cursor } : {}) },
      tracker,
      signal,
      access(),
    ),
  )
  expect(groups.map((page) => page.project?.code)).toEqual(["AAA", "BBB", "CCC"])
  expect(groups.every((page) => LiveGroupOutput.safeParse(page).success)).toBe(true)
})

test("a task, an attempt and a worker session of another project resolve under all", async () => {
  const { three, reads, tracker, units } = await fixture(() => [])
  const signal = new AbortController().signal
  const [, b] = three.projects
  const taskID = b!.taskIDs[0]!
  const reference = b!.repository.referenceFor(taskID)!
  expect(reference.startsWith("BBB-")).toBe(true)
  const attemptID = addAttempt(b!.repository, b!.planIDs[0]!, taskID, "ses-beta-worker")
  const access = { units: units() }

  for (const request of [{ reference }, { taskID }, { attemptID }]) {
    const out = await reads.trajectoryAll(
      { scope: all, limit: 5, ...request },
      tracker,
      signal,
      access,
    )
    expect(out.scope).toEqual({ kind: "all" })
    expect(out.project).toMatchObject({ code: "BBB", loaded: false })
  }
  const status = await reads.trajectoryStatusAll({ scope: all, taskID }, tracker, access)
  expect(status.project?.code).toBe("BBB")
  const attempt = await reads.liveAttemptAll(
    { scope: all, sessionID: "ses-beta-worker" },
    tracker,
    signal,
    access,
  )
  expect(attempt.project?.code).toBe("BBB")
  expect(attempt.attempt?.id).toBe(attemptID)
  const history = await reads.liveHistoryAll(
    { scope: all, sessionID: "ses-beta-worker", limit: 5 },
    tracker,
    signal,
    access,
  )
  expect(history.project?.code).toBe("BBB")
  expect(history.scope).toEqual({ kind: "all" })

  // An unknown task or worker session is refused plainly.
  await expect(
    reads.trajectoryAll({ scope: all, limit: 5, reference: "BBB-9999" }, tracker, signal, access),
  ).rejects.toThrow("No observation in this scope")
  await expect(
    reads.liveAttemptAll({ scope: all, sessionID: "ses-nobody" }, tracker, signal, access),
  ).rejects.toThrow("Observation scope is unavailable")
})

test("a reference resolves in its own project, and an old code resolves only where it was", async () => {
  const { three, units } = await fixture(() => [])
  const [a, b] = three.projects
  const { setProjectCode } = await import("../projects/registry.ts")
  const old = b!.repository.referenceFor(b!.taskIDs[0]!)!
  setProjectCode(b!.repository, b!.key, "BBX")
  const { findOwner } = await import("../projects/resolve.ts")
  const owner = (reference: string) => findOwner(a!.repository, units(), { reference })
  expect(owner("BBX-1")?.unit.project.key).toBe(b!.key)
  expect(owner(old)?.unit.project.key).toBe(b!.key)
  expect(owner(old)?.taskID).toBe(b!.taskIDs[0])
  expect(owner("QQQ-1")).toBeUndefined()
})

test("Tasks get and current activity for another project's task", async () => {
  const { three, units } = await fixture(() => [])
  const [a, b] = three.projects
  const reads = new AssociationTaskReads(a!.repository)
  const taskID = b!.taskIDs[0]!
  const reference = b!.repository.referenceFor(taskID)!
  for (const id of [taskID, reference]) {
    const found = await reads.getAll(
      { allProjects: true, sessionID: "ses-caller", taskID: id },
      { units: units() },
    )
    expect(found.status === "found" && found.project?.code).toBe("BBB")
  }
  const unknown = await reads.getAll(
    { allProjects: true, sessionID: "ses-caller", taskID: "QQQ-1" },
    { units: units() },
  )
  expect(unknown.status).toBe("not_found")
  const targets = await reads.currentActivityTargetsAll([taskID, crypto.randomUUID()], {
    units: units(),
  })
  expect(targets[0]).toMatchObject({ authorized: true, project: { code: "BBB" } })
  expect(targets[1]?.authorized).toBe(false)
  expect(() => reads.get({ allProjects: true, sessionID: "s", taskID })).toThrow()
})

test("a cursor names a checkout by hash, and a checkout that is gone is refused", async () => {
  const { reads, tracker, units } = await fixture(() => [])
  const first = await reads.topologyAll({ scope: all }, tracker, { units: units() })
  expect(Buffer.from(first.nextCursor!, "base64url").toString()).not.toContain("/")
  const without = units().filter((unit) => unit.project.code !== "BBB")
  await expect(
    reads.topologyAll({ scope: all, cursor: first.nextCursor! }, tracker, { units: without }),
  ).rejects.toThrow("Invalid project cursor")
})

test("tasks across projects carry the project and a reference with its code, paged by project", async () => {
  const { three, units } = await fixture((t) => [t.projects[0]!.directory])
  const [a] = three.projects
  const reads = new AssociationTaskReads(a!.repository)
  const collected: { code: string; reference: string; title: string }[] = []
  let cursor: string | undefined
  let pageCount = 0
  do {
    const page = await reads.queryAll(
      { allProjects: true, sessionID: "ses-caller", limit: 2, ...(cursor ? { cursor } : {}) },
      { units: units() },
    )
    pageCount++
    expect(page.tasks.length).toBeLessThanOrEqual(2)
    for (const task of page.tasks) {
      expect(task.project).toEqual(page.project!)
      collected.push({ code: task.project!.code, reference: task.reference, title: task.title })
    }
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  expect(collected.map((task) => task.code).toSorted()).toEqual(["AAA", "AAA", "AAA", "BBB", "CCC"])
  for (const task of collected) expect(task.reference.startsWith(`${task.code}-`)).toBe(true)
  expect(pageCount).toBe(4)
  const loaded = new Set(
    (await Promise.resolve(units())).map((unit) => `${unit.project.code}:${unit.project.loaded}`),
  )
  expect([...loaded].toSorted()).toEqual(["AAA:true", "BBB:false", "CCC:false"])
})

test("a task page reports the project's loaded flag and skips a project with no tasks", async () => {
  const { three, units } = await fixture(() => [])
  const reads = new AssociationTaskReads(three.projects[0]!.repository)
  const page = await reads.queryAll(
    { allProjects: true, sessionID: "ses-caller", limit: 10, state: "all" },
    { units: units().filter((unit) => unit.project.code !== "AAA") },
  )
  expect(page.project).toMatchObject({ code: "BBB", loaded: false })
  expect(page.projectDirectory).toBe(three.projects[1]!.directory)
})

type Handlers = Record<string, (input: unknown, context?: unknown) => Effect.Effect<unknown>>
type Page = { project?: { code: string; loaded: boolean }; nextCursor?: string | null }

/** The observability RPC over three projects; every permission call is recorded. */
async function rpcFixture(sessionProjectID = "project") {
  const f = await fixture(() => [])
  let handlers: Handlers | undefined
  const asserts: unknown[] = []
  const ctx = {
    rpc: {
      register: (_definition: unknown, methods: Handlers) => {
        handlers = methods
        return Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } })
      },
    },
    session: {
      get: ({ sessionID }: { sessionID: string }) =>
        Effect.succeed({
          id: sessionID,
          projectID: sessionProjectID,
          agent: "architect",
          time: {},
        }),
    },
    permission: {
      assert: (input: unknown) => {
        asserts.push(input)
        return Effect.fail(new Error("a permission check would prompt the owner"))
      },
    },
    event: { subscribe: () => Stream.never },
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session" | "event">
  await Effect.runPromise(
    Effect.scoped(
      registerObservability(ctx, f.reads, "project", { loaded: () => [] }).pipe(Effect.asVoid),
    ),
  )
  const call = <T = Page>(method: string, input: unknown) =>
    Effect.runPromise(
      handlers![method]!(input, {
        error: (type: string, message: string) => new Error(`${type}: ${message}`),
      }),
    ) as Promise<T>
  const walk = async (method: string, extra: object = {}) => {
    const pages: Page[] = []
    let cursor: string | undefined
    do {
      const page = await call(method, { scope: all, ...extra, ...(cursor ? { cursor } : {}) })
      pages.push(page)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    return pages
  }
  return { ...f, asserts, call, walk }
}

test("rpc: every all-projects read lists every project and asserts no permission", async () => {
  const f = await rpcFixture()
  for (const [method, extra] of [
    ["topology", {}],
    ["snapshot", {}],
    ["liveRadar", { includeUnmanagedSessions: false }],
    ["radar", { includeUnmanagedSessions: false }],
    ["liveGroup", { group: "queued" }],
    ["progressDiagnostics", {}],
  ] as const) {
    const pages = await f.walk(method, extra)
    if (method !== "progressDiagnostics")
      expect(pages.map((page) => page.project?.code)).toEqual(["AAA", "BBB", "CCC"])
    else expect(pages).toHaveLength(3)
  }
  expect(f.asserts).toEqual([])
})

test("rpc: all from a session of another OpenCode project is refused", async () => {
  const f = await rpcFixture("foreign-project")
  await expect(f.call("topology", { scope: all })).rejects.toThrow(
    "Observation scope is unavailable",
  )
})

test("rpc: trajectory by reference, live attempt and live history resolve across projects", async () => {
  const f = await rpcFixture()
  const [, b] = f.three.projects
  const taskID = b!.taskIDs[0]!
  const reference = b!.repository.referenceFor(taskID)!
  addAttempt(b!.repository, b!.planIDs[0]!, taskID, "ses-beta-worker")
  const trajectory = await f.call<{ project: { code: string }; scope: unknown }>("trajectory", {
    scope: all,
    reference,
    limit: 5,
  })
  expect(trajectory).toMatchObject({ project: { code: "BBB" }, scope: { kind: "all" } })
  const attempt = await f.call<{ project: { code: string } }>("liveAttempt", {
    scope: all,
    sessionID: "ses-beta-worker",
  })
  expect(attempt.project.code).toBe("BBB")
  const history = await f.call<{ project: { code: string } }>("liveHistory", {
    scope: all,
    sessionID: "ses-beta-worker",
    limit: 5,
  })
  expect(history.project.code).toBe("BBB")
  await expect(
    f.call("trajectory", { scope: all, reference: "BBB-9999", limit: 5 }),
  ).rejects.toThrow("No observation in this scope")
  expect(f.asserts).toEqual([])
})

test("all-projects pages are reads: they take no write lock, so a writer elsewhere does not stop them", async () => {
  const f = await rpcFixture()
  const [a, b] = f.three.projects
  const taskID = b!.taskIDs[0]!
  const reference = b!.repository.referenceFor(taskID)!
  addAttempt(b!.repository, b!.planIDs[0]!, taskID, "ses-beta-worker")
  const tasks = await tasksRpc(f, { sessionProjectID: "project" })
  const { Database } = await import("bun:sqlite")
  const writer = new Database(f.three.path)
  writer.exec("BEGIN IMMEDIATE")
  try {
    for (const [method, extra] of [
      ["topology", {}],
      ["snapshot", {}],
      ["liveRadar", { includeUnmanagedSessions: false }],
      ["radar", { includeUnmanagedSessions: false }],
      ["liveGroup", { group: "queued" }],
    ] as const)
      expect((await f.walk(method, extra)).length).toBe(3)
    await f.call("trajectory", { scope: all, reference, limit: 5 })
    await f.call("liveAttempt", { scope: all, sessionID: "ses-beta-worker" })
    await f.call("liveHistory", { scope: all, sessionID: "ses-beta-worker", limit: 5 })
    const pages: unknown[] = []
    let cursor: string | undefined
    do {
      const page = await tasks.query({
        allProjects: true,
        sessionID: "ses-caller",
        ...(cursor ? { cursor } : {}),
      })
      pages.push(page)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(pages.length).toBeGreaterThanOrEqual(3)
    await tasks.get({ allProjects: true, sessionID: "ses-caller", taskID: reference })
    await tasks.currentActivity({ sessionID: "ses-caller", scope: "all", taskIDs: [taskID] })
  } finally {
    writer.exec("ROLLBACK")
    writer.close()
  }
  expect(a).toBeDefined()
}, 30_000)

type TaskHandlers = Record<string, (input: unknown) => Effect.Effect<unknown>>

/** The Tasks RPC over the same three projects; its own project is the first one. */
async function tasksRpc(
  f: Awaited<ReturnType<typeof fixture>>,
  options: { sessionProjectID?: string; asserts?: unknown[] } = {},
) {
  let handlers: TaskHandlers | undefined
  const ctx = {
    rpc: {
      register: (definition: { id: string }, methods: TaskHandlers) => {
        if (definition.id === "lazers.tasks") handlers = methods
        return Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } })
      },
    },
    session: {
      get: ({ sessionID }: { sessionID: string }) =>
        Effect.succeed({
          id: sessionID,
          projectID: options.sessionProjectID ?? "project",
          agent: "architect",
          time: {},
          location: { directory: "/caller" },
        }),
    },
    permission: {
      assert: (input: unknown) => {
        options.asserts?.push(input)
        return Effect.void
      },
    },
  } as unknown as Parameters<typeof registerTaskReads>[0]
  const reads = new AssociationTaskReads(f.three.projects[0]!.repository)
  const runtime = { projectID: "project", host: { session: async () => null } }
  await Effect.runPromise(
    Effect.scoped(
      registerTaskReads(ctx, reads, runtime as never, {
        loaded: () => [f.three.projects[2]!.directory],
      }).pipe(Effect.asVoid),
    ),
  )
  const call = (name: string) => (input: unknown) => Effect.runPromise(handlers![name]!(input))
  return {
    query: call("query") as (input: unknown) => Promise<{
      project?: { code: string; loaded: boolean }
      tasks: { project?: { code: string } }[]
      nextCursor: string | null
    }>,
    get: call("get") as (input: unknown) => Promise<{ status: string; project?: { code: string } }>,
    currentActivity: call("currentActivity") as (input: unknown) => Promise<{
      activities: { taskID: string; project?: { code: string }; foreground: string }[]
    }>,
  }
}

test("rpc: Tasks query, get and current activity across projects", async () => {
  const f = await fixture(() => [])
  const asserts: unknown[] = []
  const tasks = await tasksRpc(f, { asserts })
  const seen: string[] = []
  let cursor: string | undefined
  do {
    const page = await tasks.query({
      allProjects: true,
      sessionID: "ses-caller",
      ...(cursor ? { cursor } : {}),
    })
    seen.push(`${page.project?.code}:${page.project?.loaded}`)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  expect(seen).toEqual(["AAA:false", "BBB:false", "CCC:true"])
  const [, b] = f.three.projects
  const taskID = b!.taskIDs[0]!
  const reference = b!.repository.referenceFor(taskID)!
  const found = await tasks.get({ allProjects: true, sessionID: "ses-caller", taskID: reference })
  expect(found).toMatchObject({ status: "found", project: { code: "BBB" } })
  const activity = await tasks.currentActivity({
    sessionID: "ses-caller",
    scope: "all",
    taskIDs: [taskID],
  })
  expect(activity.activities[0]).toMatchObject({ taskID, project: { code: "BBB" } })
  expect(activity.activities[0]?.foreground).toBe("unknown")
  expect(asserts).toEqual([])
})

test("rpc: Tasks reads in all need a calling session of this project", async () => {
  const f = await fixture(() => [])
  const foreign = await tasksRpc(f, { sessionProjectID: "foreign-project" })
  await expect(foreign.query({ allProjects: true, sessionID: "ses-caller" })).rejects.toThrow()
  await expect(
    foreign.get({ allProjects: true, sessionID: "ses-caller", taskID: crypto.randomUUID() }),
  ).rejects.toThrow()
  const own = await tasksRpc(f)
  await expect(own.query({ allProjects: true })).rejects.toThrow()
})

test("agent tools never offer all projects: their schemas have no such field and the reads refuse it", async () => {
  const { AgentGetInput, AgentQueryInput } = await import("../tasks/contract.ts")
  expect(AgentQueryInput.safeParse({ allProjects: true, sessionID: "ses-x" }).success).toBe(false)
  expect(
    AgentGetInput.safeParse({ allProjects: true, sessionID: "ses-x", taskID: crypto.randomUUID() })
      .success,
  ).toBe(false)
  expect(AgentQueryInput.safeParse({ limit: 5 }).success).toBe(true)
  const { three } = await fixture(() => [])
  const reads = new AssociationTaskReads(three.projects[0]!.repository)
  expect(() => reads.query({ allProjects: true, sessionID: "ses-x" })).toThrow(
    "An all-projects query is read with queryAll",
  )
  expect(() =>
    reads.get({ allProjects: true, sessionID: "ses-x", taskID: three.projects[0]!.taskIDs[0] }),
  ).toThrow("An all-projects read is read with getAll")
})
