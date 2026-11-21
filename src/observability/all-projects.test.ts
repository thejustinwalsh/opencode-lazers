import { afterEach, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { addAttempt, addPlan, addTask, threeProjects } from "../../test/projects/three-projects.ts"
import { pickUnit, projectUnits } from "../projects/scope.ts"
import { RunnerStore } from "../runner/store.ts"
import { ObservationReads } from "./read.ts"
import { registerObservability } from "./rpc.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const all = { kind: "all" as const, sessionID: "ses-caller" }

type Handlers = Record<string, (input: unknown, context?: unknown) => Effect.Effect<unknown>>
type Page = {
  scope?: { kind: string }
  project?: { key: string; code: string; loaded: boolean }
  nextCursor?: string | null
}

/**
 * The all-projects progress diagnostics read over three projects; `live` decides which project
 * roots have a loaded location. Every permission call is recorded.
 */
async function rpcFixture(
  live: (three: Awaited<ReturnType<typeof threeProjects>>) => string[] = () => [],
  sessionProjectID = "project",
) {
  const three = await threeProjects()
  cleanups.push(() => three.close())
  const [a] = three.projects
  const reads = new ObservationReads(new RunnerStore(a!.repository), "project")
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
  } as unknown as Pick<Plugin.Context, "rpc" | "permission" | "session">
  await Effect.runPromise(
    Effect.scoped(
      registerObservability(ctx, reads, "project", { loaded: () => live(three) }).pipe(
        Effect.asVoid,
      ),
    ),
  )
  const call = (input: unknown) =>
    Effect.runPromise(handlers!.progressDiagnostics!(input)) as Promise<Page>
  const walk = async () => {
    const pages: Page[] = []
    let cursor: string | undefined
    do {
      const page = await call({ scope: all, ...(cursor ? { cursor } : {}) })
      pages.push(page)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    return pages
  }
  return { three, asserts, call, walk }
}

test("all returns each project on its own page with the right code and loaded flag", async () => {
  const f = await rpcFixture((t) => [t.projects[0]!.directory, t.projects[1]!.directory])
  const pages = await f.walk()
  expect(pages.map((page) => [page.project?.code, page.project?.loaded])).toEqual([
    ["AAA", true],
    ["BBB", true],
    ["CCC", false],
  ])
  for (const page of pages) expect(page.scope).toEqual({ kind: "all" })
  expect(pages.at(-1)?.nextCursor).toBeNull()
})

test("a project that is not loaded is still readable, and later pages see a location that loads", async () => {
  let live: string[] = []
  const f = await rpcFixture(() => live)
  const first = await f.call({ scope: all })
  expect(first.project?.loaded).toBe(false)
  live = [f.three.projects[1]!.directory]
  const second = await f.call({ scope: all, cursor: first.nextCursor! })
  expect(second.project).toMatchObject({ code: "BBB", loaded: true })
})

test("a second checkout of one project is its own page under the same project", async () => {
  const f = await rpcFixture()
  const [a] = f.three.projects
  const { mkdirSync } = await import("node:fs")
  const { join } = await import("node:path")
  const second = join(f.three.parent, "alpha-second")
  mkdirSync(second)
  const { registerProject } = await import("../project-key.ts")
  const { TaskRepository } = await import("../storage.ts")
  const repository = new TaskRepository(f.three.path, second)
  cleanups.push(() => repository.close())
  await Bun.spawn(["git", "-C", second, "init", "-q", "-b", "main"]).exited
  await Bun.spawn(["git", "-C", second, "remote", "add", "origin", "git@h.com:o/alpha.git"]).exited
  const registered = await registerProject(repository, {
    directory: second,
    opencodeProjectID: "opencode-alpha",
  })
  expect(registered.key).toBe(a!.key)
  addPlan(repository, [addTask(repository, "second checkout task")])
  const pages = await f.walk()
  expect(pages.map((page) => page.project?.code)).toEqual(["AAA", "AAA", "BBB", "CCC"])
  expect(pages[1]?.project?.key).toBe(a!.key)
})

test("a cursor names a checkout by hash, and a checkout that is gone is refused", async () => {
  const f = await rpcFixture()
  const first = await f.call({ scope: all })
  expect(Buffer.from(first.nextCursor!, "base64url").toString()).not.toContain("/")
  const [a] = f.three.projects
  const without = projectUnits(a!.repository, () => []).filter(
    (unit) => unit.project.code !== "BBB",
  )
  await expect(Promise.resolve().then(() => pickUnit(without, first.nextCursor!))).rejects.toThrow(
    "Invalid project cursor",
  )
})

test("rpc: the all-projects read lists every project and asserts no permission", async () => {
  const f = await rpcFixture()
  expect((await f.walk()).map((page) => page.project?.code)).toEqual(["AAA", "BBB", "CCC"])
  expect(f.asserts).toEqual([])
})

test("rpc: all from a session of another OpenCode project is refused", async () => {
  const f = await rpcFixture(() => [], "foreign-project")
  await expect(f.call({ scope: all })).rejects.toThrow("Observation scope is unavailable")
})

test("all-projects pages are reads: they take no write lock, so a writer elsewhere does not stop them", async () => {
  const f = await rpcFixture()
  const [, b] = f.three.projects
  addAttempt(b!.repository, b!.planIDs[0]!, b!.taskIDs[0]!, "ses-beta-worker")
  const { Database } = await import("bun:sqlite")
  const writer = new Database(f.three.path)
  writer.exec("BEGIN IMMEDIATE")
  try {
    expect(await f.walk()).toHaveLength(3)
  } finally {
    writer.exec("ROLLBACK")
    writer.close()
  }
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
