import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerProject } from "../project-key.ts"
import { meterRepository } from "../runner/read-meter.fixture.ts"
import { RunnerStore } from "../runner/store.ts"
import { TaskRepository } from "../storage.ts"
import { openStream } from "../streams/client.ts"
import { readerPool } from "../streams/pool.ts"
import { streamColumns } from "../streams/source.ts"
import {
  projectProofsSource,
  projectRevisionsSource,
  projectsGlobalSource,
  projectsListSource,
} from "../streams/sources/projects.ts"
import {
  ensureProjectOverviewSchema,
  setProjectOverviewDefaults,
  type ProjectsDefaults,
} from "./overview-store.ts"
import { globalViewOf, projectViewOf, revisionViewOf } from "./overview-view.ts"
import { acquirePresence } from "./presence.ts"
import { activateRevision } from "./profile-store.ts"
import { projectsOperations } from "./rpc.ts"

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

let fixtures = 0

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lazers-overview-"))
  const path = join(directory, "tasks.sqlite")
  const repositories = ["alpha", "beta", "gamma"].map(
    (name) => new TaskRepository(path, join(directory, name)),
  )
  const [a, b, c] = repositories as [TaskRepository, TaskRepository, TaskRepository]
  const store = new RunnerStore(a)
  for (const repository of [b, c]) new RunnerStore(repository)
  ensureProjectOverviewSchema(a)
  // Resolved with this service's defaults: new ones per fixture, as a new service would bring.
  const defaults: ProjectsDefaults = {
    project: { spendCeilingTokens: 5000 },
    global: { historyCacheMB: 64 + ++fixtures },
  }
  setProjectOverviewDefaults(a, defaults)
  const keys: string[] = []
  for (const [index, repository] of repositories.entries())
    keys.push(
      (
        await registerProject(repository, {
          directory: repository.projectDirectory,
          opencodeProjectID: `p${index}`,
        })
      ).key,
    )
  const presence = acquirePresence(a, a.projectDirectory)
  const pool = readerPool(path, { workers: 1 })
  cleanups.push(async () => {
    presence.release()
    await pool.close()
    for (const repository of repositories) repository.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const loaded = () => [a.projectDirectory]
  const ops = projectsOperations(a, { loaded, defaults })
  return { a, b, c, store, keys, ops, pool, path }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

async function streamed(f: Fixture) {
  const read = async <C extends Parameters<typeof streamColumns>[0]>(source: C, order: string) => {
    const stream = openStream(f.pool, source as never, {
      filter: {},
      order,
      window: 16,
      transport: "copy",
    })
    await stream.ready()
    const columns = Object.keys(streamColumns(source as never, 16))
    const rows = stream.items.map((row) =>
      Object.fromEntries(
        columns.map((column) => [column, (row as Record<string, unknown>)[column]]),
      ),
    )
    stream.close()
    return rows
  }
  const projects = await read(projectsListSource as never, "registry")
  const [global] = await read(projectsGlobalSource as never, "key")
  return {
    projects: projects.map((row) => projectViewOf(row)),
    ...globalViewOf(global!),
  }
}

test("projects.list parity: equals Projects.list (paused, contact paused, active profile, not loaded)", async () => {
  const f = await fixture()
  const [alpha, beta, gamma] = f.keys as [string, string, string]
  f.ops.setPause({ kind: "project", key: beta }, true, "hold it")
  f.ops.setPause({ kind: "global" }, true, "everything")
  f.store.setArchitectContact("paused", "quiet please")
  activateRevision(f.a, {
    projectKey: alpha,
    profile: {
      toolchains: [],
      verify: [{ id: "check", command: "bun test" }],
      fix: [],
      env: [],
      audit: "fallow",
      source: { include: ["src/**"], exclude: [] },
    } as never,
    author: { kind: "owner" },
    reason: "first",
    proofs: [],
  })
  f.ops.setSetting({ kind: "project", key: gamma }, "limit", 3)
  f.ops.setCode(gamma, "GAM")
  const expected = f.ops.list()
  expect(expected.projects.map((project) => project.loaded)).toEqual([true, false, false])
  expect(expected.projects[0]!.profile.state).toBe("active")
  expect(expected.projects[0]!.architectContact).toEqual({ reason: "quiet please" })
  expect(expected.globalPause?.reason).toBe("everything")
  expect(await streamed(f)).toEqual(expected)
})

test("writers: each write updates the stored row in its own transaction", async () => {
  const f = await fixture()
  const [alpha, beta] = f.keys as [string, string]
  const row = (key: string) =>
    f.a.read((db) =>
      db
        .query<Record<string, unknown>, [string]>("SELECT * FROM project_overview WHERE key=?")
        .get(key),
    )
  f.ops.setCode(alpha, "ALP")
  expect(row(alpha)?.code).toBe("ALP")
  f.ops.setPause({ kind: "project", key: alpha }, true, "why")
  expect(row(alpha)).toMatchObject({ paused: 1, pause_reason: "why", pause_by: "owner" })
  f.ops.setPause({ kind: "project", key: alpha }, false, "")
  expect(row(alpha)?.paused).toBe(0)
  f.ops.setSetting({ kind: "project", key: alpha }, "weight", 2)
  expect(JSON.parse(String(row(alpha)?.settings)).weight).toBe(2)
  f.store.setArchitectContact("paused", "later")
  expect(row(alpha)).toMatchObject({ architect_contact: 1, architect_contact_reason: "later" })
  activateRevision(f.a, {
    projectKey: beta,
    profile: {
      toolchains: [],
      verify: [{ id: "check", command: "bun test" }],
      fix: [],
      env: [],
      audit: "fallow",
      source: { include: ["src/**"], exclude: [] },
    } as never,
    author: { kind: "owner" },
    reason: "r",
    proofs: [],
  })
  expect(row(beta)).toMatchObject({ profile_state: "active", profile_revision: 1 })
  // Path registration: a second checkout of alpha.
  f.a.atomic((db) =>
    db
      .query("INSERT INTO lazers_project_paths(path,key,last_seen_at) VALUES(?,?,?)")
      .run("/elsewhere/alpha-2", alpha, new Date().toISOString()),
  )
  expect(JSON.parse(String(row(alpha)?.checkouts))).toEqual([
    f.a.projectDirectory,
    "/elsewhere/alpha-2",
  ])
  const global = f.a.read((db) =>
    db.query<{ settings: string }, []>("SELECT settings FROM project_global").get(),
  )
  f.ops.setSetting({ kind: "global" }, "globalSlots", 4)
  expect(
    f.a.read((db) =>
      db.query<{ settings: string }, []>("SELECT settings FROM project_global").get(),
    )?.settings,
  ).not.toBe(global?.settings)
  // Nothing is left queued.
  expect(
    f.a.read(
      (db) =>
        db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM project_overview_dirty").get()!.n,
    ),
  ).toBe(0)
})

test("presence: acquire writes, release deletes, a new instance clears the old instance's rows", async () => {
  const f = await fixture()
  const rows = () =>
    f.a.read((db) =>
      db
        .query<{ path: string; instance: string }, []>(
          "SELECT path,instance FROM project_presence ORDER BY path",
        )
        .all(),
    )
  expect(rows().map((row) => row.path)).toEqual([f.a.projectDirectory])
  // Refcounted: a second core of the same root (a reload) keeps the row until both release.
  const again = acquirePresence(f.a, f.a.projectDirectory)
  const other = acquirePresence(f.a, f.b.projectDirectory)
  expect(rows().length).toBe(2)
  other.release()
  again.release()
  expect(rows().map((row) => row.path)).toEqual([f.a.projectDirectory])
  expect((await streamed(f)).projects.map((project) => project.loaded)).toEqual([
    true,
    false,
    false,
  ])
  // A row left by another process is cleared by this process's first presence write.
  f.a.atomic((db) =>
    db
      .query("INSERT INTO project_presence(path,canonical,instance,loaded_at) VALUES(?,?,?,?)")
      .run("/stale", "/stale", "another-process", 1),
  )
  const key = Symbol.for("lazers.project-presence.v1")
  const held = (globalThis as unknown as Record<symbol, { cleared: Set<string> }>)[key]!
  held.cleared.delete(f.path)
  const fresh = acquirePresence(f.a, f.c.projectDirectory)
  expect(rows().map((row) => row.path)).toEqual([f.a.projectDirectory, f.c.projectDirectory].sort())
  fresh.release()
})

test("idle: an open Projects stream issues no statement on the main connection", async () => {
  const f = await fixture()
  const meter = meterRepository(f.a)
  let changes = 0
  const stream = openStream(f.pool, projectsListSource, {
    filter: {},
    order: "registry",
    window: 16,
    transport: "copy",
  })
  try {
    await stream.ready()
    stream.on("change", () => changes++)
    await Bun.sleep(300)
    expect(meter.statements).toEqual([])
    expect(changes).toBe(0)
    // Not vacuous: a pause write reaches the open list.
    f.ops.setPause({ kind: "project", key: f.keys[0]! }, true, "now")
    for (let waited = 0; waited < 50 && changes === 0; waited++) await Bun.sleep(20)
    expect(changes).toBeGreaterThan(0)
  } finally {
    stream.close()
    meter.stop()
  }
})

test("projects.revisions and projects.proofs parity: the Verification group's revisions equal the profile read", async () => {
  const f = await fixture()
  const key = f.keys[0]!
  const profile = (command: string) =>
    ({
      toolchains: [],
      verify: [{ id: "check", command }],
      fix: [],
      env: ["API_TOKEN", "HOME_DIR"],
      audit: "fallow",
      source: { include: ["src/**"], exclude: [] },
    }) as never
  const proof = (outcome: "proven" | "failed") => ({
    key: "verify:check",
    command: "bun test",
    outcome,
    exitCode: outcome === "failed" ? 1 : 0,
    timedOut: false,
    durationMs: 12,
    stdoutTail: "ok",
    stderrTail: outcome === "failed" ? "boom" : "",
    ranAt: 5,
    ...(outcome === "failed" ? { reason: "exit 1" } : { toolVersion: "1.4" }),
  })
  activateRevision(f.a, {
    projectKey: key,
    profile: profile("bun test"),
    author: { kind: "owner" },
    reason: "one",
    proofs: [proof("failed")],
  })
  activateRevision(f.a, {
    projectKey: key,
    profile: profile("bun test --bail"),
    author: { kind: "architect", sessionID: "ses-a", agent: "architect" },
    reason: "two",
    proofs: [proof("proven")],
    mapPreview: {
      files: 3,
      names: 4,
      tokens: 5,
      largestFolders: [],
      currentFiles: 3,
      currentTokens: 5,
    },
  })
  const read = async (source: never, filter: unknown, order: string, window: number) => {
    const stream = openStream(f.pool, source, { filter, order, window, transport: "copy" })
    await stream.ready()
    const columns = Object.keys(streamColumns(source, window))
    const rows = stream.items.map((row) =>
      Object.fromEntries(
        columns.map((column) => [column, (row as Record<string, unknown>)[column]]),
      ),
    )
    stream.close()
    return rows
  }
  const [active] = await read(
    projectRevisionsSource as never,
    { key, state: "active" },
    "newest",
    1,
  )
  const proofs = await read(
    projectProofsSource as never,
    { revisionID: active!.id },
    "recorded",
    16,
  )
  const history = await read(
    projectRevisionsSource as never,
    { key, state: "superseded" },
    "newest",
    16,
  )
  const expected = f.ops.profile(key)
  expect(revisionViewOf(active!, proofs)).toEqual(expected.active)
  expect(expected.active?.credentialLikeEnv).toEqual(["API_TOKEN"])
  // The earlier list shows revision, author, time and reason (its document is not read).
  expect(
    history.map((row) => {
      const {
        profile: _profile,
        proofs: _proofs,
        credentialLikeEnv: _env,
        ...shown
      } = revisionViewOf(row, [])!
      return shown
    }),
  ).toEqual(
    expected.history.map(
      ({ profile: _profile, proofs: _proofs, credentialLikeEnv: _env, ...shown }) => shown,
    ),
  )
})
