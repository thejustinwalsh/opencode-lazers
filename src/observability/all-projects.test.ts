import { afterEach, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Stream } from "effect"
import { addAttempt, addPlan, addTask, threeProjects } from "../../test/projects/three-projects.ts"
import { projectUnits } from "../projects/scope.ts"
import type { ProjectUnit } from "../projects/scope.ts"
import { RunnerStore } from "../runner/store.ts"
import { ObservationChangeTracker } from "./changes.ts"
import { SnapshotOutput } from "./contract.ts"
import { ObservationReads } from "./read.ts"
import { registerObservability } from "./rpc.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const secret = new Uint8Array(32).fill(7)
const host = { session: async () => null, status: async () => null }

async function fixture(live: (three: Awaited<ReturnType<typeof threeProjects>>) => string[]) {
  const three = await threeProjects()
  const [a] = three.projects
  const reads = new ObservationReads(new RunnerStore(a!.repository), host, "project", secret)
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
  const result: Awaited<ReturnType<ObservationReads["snapshotAll"]>>[] = []
  let cursor: string | undefined
  do {
    const page = await reads.snapshotAll({ scope: all, ...(cursor ? { cursor } : {}) }, tracker, {
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
    expect(SnapshotOutput.safeParse(page).success).toBe(true)
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
  const first = await reads.snapshotAll({ scope: all }, tracker, { units: units() })
  expect(first.project?.loaded).toBe(false)
  expect(first.plans).toHaveLength(1)
  live = [three.projects[1]!.directory]
  const second = await reads.snapshotAll({ scope: all, cursor: first.nextCursor! }, tracker, {
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
  const project = reads.snapshot({ kind: "project", sessionID: "ses-caller" }, tracker)
  expect(project.scope).toEqual({ kind: "project" })
  expect(project.project).toBeUndefined()
  expect("nextCursor" in project).toBe(false)
  for (const plan of project.plans) expect("project" in plan).toBe(false)
  const session = reads.snapshot({ kind: "session", sessionID: "session-a" }, tracker)
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

test("snapshot and live radar page by project with the same stamp", async () => {
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

test("a cursor names a checkout by hash, and a checkout that is gone is refused", async () => {
  const { reads, tracker, units } = await fixture(() => [])
  const first = await reads.snapshotAll({ scope: all }, tracker, { units: units() })
  expect(Buffer.from(first.nextCursor!, "base64url").toString()).not.toContain("/")
  const without = units().filter((unit) => unit.project.code !== "BBB")
  await expect(
    reads.snapshotAll({ scope: all, cursor: first.nextCursor! }, tracker, { units: without }),
  ).rejects.toThrow("Invalid project cursor")
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
    ["snapshot", {}],
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
  await expect(f.call("snapshot", { scope: all })).rejects.toThrow(
    "Observation scope is unavailable",
  )
})

test("all-projects pages are reads: they take no write lock, so a writer elsewhere does not stop them", async () => {
  const f = await rpcFixture()
  const [a, b] = f.three.projects
  const taskID = b!.taskIDs[0]!
  const reference = b!.repository.referenceFor(taskID)!
  addAttempt(b!.repository, b!.planIDs[0]!, taskID, "ses-beta-worker")
  const { Database } = await import("bun:sqlite")
  const writer = new Database(f.three.path)
  writer.exec("BEGIN IMMEDIATE")
  try {
    for (const [method, extra] of [["snapshot", {}]] as const)
      expect((await f.walk(method, extra)).length).toBe(3)
  } finally {
    writer.exec("ROLLBACK")
    writer.close()
  }
  expect(a).toBeDefined()
}, 30_000)

test("agent tools never offer all projects: their schemas have no such field and the reads refuse it", async () => {
  const { AgentGetInput, AgentQueryInput } = await import("../tasks/contract.ts")
  expect(AgentQueryInput.safeParse({ allProjects: true, sessionID: "ses-x" }).success).toBe(false)
  expect(
    AgentGetInput.safeParse({ allProjects: true, sessionID: "ses-x", taskID: crypto.randomUUID() })
      .success,
  ).toBe(false)
  expect(AgentQueryInput.safeParse({ limit: 5 }).success).toBe(true)
})
