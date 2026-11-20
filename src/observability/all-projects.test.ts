import { afterEach, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Stream } from "effect"
import { addPlan, addTask, threeProjects } from "../../test/projects/three-projects.ts"
import { projectUnits } from "../projects/scope.ts"
import type { ProjectUnit } from "../projects/scope.ts"
import { RunnerStore } from "../runner/store.ts"
import { ObservationChangeTracker } from "./changes.ts"
import { TopologyOutput } from "./contract.ts"
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

function pages(
  reads: ObservationReads,
  tracker: ObservationChangeTracker,
  units: () => ProjectUnit[],
) {
  const result: ReturnType<ObservationReads["topologyAll"]>[] = []
  let cursor: string | undefined
  do {
    const page = reads.topologyAll({ scope: all, ...(cursor ? { cursor } : {}) }, tracker, units())
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
  const result = pages(reads, tracker, units)
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
  const first = reads.topologyAll({ scope: all }, tracker, units())
  expect(first.project?.loaded).toBe(false)
  expect(first.plans).toHaveLength(1)
  live = [three.projects[1]!.directory]
  const second = reads.topologyAll({ scope: all, cursor: first.nextCursor! }, tracker, units())
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
  const result = pages(reads, tracker, units)
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

test("every other observation read refuses the all-projects scope", async () => {
  const { reads, tracker } = await fixture(() => [])
  const signal = new AbortController().signal
  const refusal = "All-projects scope is not available for this read"
  expect(() => reads.snapshot(all, tracker)).toThrow(refusal)
  expect(() => reads.liveGroup({ scope: all, group: "queued" }, signal)).toThrow(refusal)
  expect(() => reads.liveAttempt({ scope: all, sessionID: "s" }, signal)).toThrow(refusal)
  expect(() => reads.liveHistory({ scope: all, sessionID: "s", limit: 5 }, signal)).toThrow(refusal)
  expect(() =>
    reads.liveRadar({ scope: all, includeUnmanagedSessions: false }, tracker, signal, "e"),
  ).toThrow(refusal)
  await expect(
    reads.radar({ scope: all, includeUnmanagedSessions: false }, tracker, signal),
  ).rejects.toThrow()
  await expect(
    reads.trajectory({ scope: all, taskID: crypto.randomUUID(), limit: 5 }, tracker, signal),
  ).rejects.toThrow(refusal)
  await expect(
    reads.trajectoryStatus({ scope: all, taskID: crypto.randomUUID() }, tracker),
  ).rejects.toThrow(refusal)
})

test("a cursor for another unit's directory is refused once that unit is not allowed", async () => {
  const { three, reads, tracker, units } = await fixture(() => [])
  const first = reads.topologyAll({ scope: all }, tracker, units())
  const allowed = units().filter((unit) => unit.project.code !== "BBB")
  expect(() =>
    reads.topologyAll({ scope: all, cursor: first.nextCursor! }, tracker, allowed),
  ).toThrow("Invalid project cursor")
  expect(three.projects).toHaveLength(3)
})

test("tasks across projects carry the project and a reference with its code, paged by project", async () => {
  const { three, units } = await fixture((t) => [t.projects[0]!.directory])
  const [a] = three.projects
  const reads = new AssociationTaskReads(a!.repository)
  const collected: { code: string; reference: string; title: string }[] = []
  let cursor: string | undefined
  let pageCount = 0
  do {
    const page = reads.queryAll(
      { allProjects: true, sessionID: "ses-caller", limit: 2, ...(cursor ? { cursor } : {}) },
      units(),
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
  const page = reads.queryAll(
    { allProjects: true, sessionID: "ses-caller", limit: 10, state: "all" },
    units().filter((unit) => unit.project.code !== "AAA"),
  )
  expect(page.project).toMatchObject({ code: "BBB", loaded: false })
  expect(page.projectDirectory).toBe(three.projects[1]!.directory)
})

type Handlers = {
  topology(input: unknown): Effect.Effect<unknown>
  snapshot(input: unknown): Effect.Effect<unknown>
}
type Page = { project?: { code: string; loaded: boolean }; nextCursor?: string | null }

/** The RPC over three projects; `deny` lists the codes whose checkouts fail the permission check. */
async function rpcFixture(deny: string[], sessionProjectID = "project") {
  const f = await fixture(() => [])
  const denied = new Set(
    f.three.projects.filter((p) => deny.includes(p.code)).map((p) => p.directory),
  )
  let handlers: Handlers | undefined
  const asserts: string[][] = []
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
      assert: (input: { resources: string[] }) => {
        asserts.push(input.resources)
        return input.resources.some((resource) => denied.has(resource))
          ? Effect.fail(new Error("permission denied"))
          : Effect.void
      },
    },
    event: { subscribe: () => Stream.never },
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session" | "event">
  await Effect.runPromise(
    Effect.scoped(
      registerObservability(ctx, f.reads, "project", { loaded: () => [] }).pipe(Effect.asVoid),
    ),
  )
  const call = (cursor?: string) =>
    Effect.runPromise(
      handlers!.topology({ scope: all, ...(cursor ? { cursor } : {}) }),
    ) as Promise<Page>
  return { ...f, handlers: handlers!, asserts, call }
}

test("rpc: all asserts the caller's own project as before and every other project on its checkouts", async () => {
  const f = await rpcFixture([])
  const codes: (string | undefined)[] = []
  let cursor: string | undefined
  do {
    const page = await f.call(cursor)
    codes.push(page.project?.code)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  expect(codes).toEqual(["AAA", "BBB", "CCC"])
  const [a, b, c] = f.three.projects
  expect(f.asserts.slice(0, 3)).toEqual([[a!.directory], [b!.directory], [c!.directory]])
})

test("rpc: a project the caller may not read never appears in a page or a cursor", async () => {
  const f = await rpcFixture(["BBB"])
  const codes: (string | undefined)[] = []
  let cursor: string | undefined
  let afterAlpha: string | undefined
  do {
    const page = await f.call(cursor)
    codes.push(page.project?.code)
    if (page.project?.code === "AAA") afterAlpha = page.nextCursor ?? undefined
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  expect(codes).toEqual(["AAA", "CCC"])
  expect(Buffer.from(afterAlpha!, "base64url").toString()).not.toContain("beta")
  const beta = Buffer.from(
    JSON.stringify({ v: 1, directory: f.three.projects[1]!.directory }),
  ).toString("base64url")
  await expect(f.call(beta)).rejects.toThrow("Invalid project cursor")
})

test("rpc: all from a session of another OpenCode project is refused like the other scopes", async () => {
  const f = await rpcFixture([], "foreign-project")
  await expect(f.call()).rejects.toThrow("Observation scope is unavailable")
})

test("rpc: the other observation reads refuse all before asserting anything", async () => {
  const f = await rpcFixture([])
  await expect(Effect.runPromise(f.handlers.snapshot({ scope: all }))).rejects.toThrow(
    "All-projects scope is not available for this read",
  )
  expect(f.asserts).toEqual([])
})

type TaskHandlers = { query(input: unknown): Effect.Effect<unknown> }

async function tasksRpc(deny: string[], sessionProjectID = "project") {
  const f = await fixture(() => [])
  const denied = new Set(
    f.three.projects.filter((p) => deny.includes(p.code)).map((p) => p.directory),
  )
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
          projectID: sessionProjectID,
          agent: "architect",
          time: {},
        }),
    },
    permission: {
      assert: (input: { resources: string[] }) =>
        input.resources.some((resource) => denied.has(resource))
          ? Effect.fail(new Error("permission denied"))
          : Effect.void,
    },
  } as unknown as Parameters<typeof registerTaskReads>[0]
  const reads = new AssociationTaskReads(f.three.projects[0]!.repository)
  await Effect.runPromise(
    Effect.scoped(
      registerTaskReads(ctx, reads, { projectID: "project" } as never, {
        loaded: () => [f.three.projects[2]!.directory],
      }).pipe(Effect.asVoid),
    ),
  )
  return (input: unknown) =>
    Effect.runPromise(handlers!.query(input)) as Promise<{
      project?: { code: string; loaded: boolean }
      tasks: { project?: { code: string } }[]
      nextCursor: string | null
    }>
}

test("rpc: Tasks query in all lists readable projects only and marks the loaded one", async () => {
  const query = await tasksRpc(["BBB"])
  const seen: string[] = []
  let cursor: string | undefined
  do {
    const page = await query({
      allProjects: true,
      sessionID: "ses-caller",
      ...(cursor ? { cursor } : {}),
    })
    seen.push(`${page.project?.code}:${page.project?.loaded}`)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  expect(seen).toEqual(["AAA:false", "CCC:true"])
})

test("rpc: Tasks query in all needs a calling session of this project and names it", async () => {
  const foreign = await tasksRpc([], "foreign-project")
  await expect(foreign({ allProjects: true, sessionID: "ses-caller" })).rejects.toThrow(
    "Task scope is unavailable",
  )
  const query = await tasksRpc([])
  await expect(query({ allProjects: true })).rejects.toThrow()
})
