import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerProject, resetProjectAliasCache } from "../project-key.ts"
import { RunnerStore } from "../runner/store.ts"
import { TaskRepository } from "../storage.ts"
import { effectivePause } from "./pause.ts"
import { activeProfile } from "./profile-store.ts"
import { projectsOperations } from "./rpc.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function fixture(defaults = {}) {
  const directory = mkdtempSync(join(tmpdir(), "lazers-projects-rpc-"))
  const path = join(directory, "tasks.sqlite")
  const a = new TaskRepository(path, join(directory, "alpha"))
  const b = new TaskRepository(path, join(directory, "beta"))
  cleanups.push(() => {
    a.close()
    b.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const storeA = new RunnerStore(a)
  new RunnerStore(b)
  const keyA = (await registerProject(a, { directory: a.projectDirectory, opencodeProjectID: "a" }))
    .key
  const keyB = (await registerProject(b, { directory: b.projectDirectory, opencodeProjectID: "b" }))
    .key
  const loaded = new Set<string>([a.projectDirectory])
  const ops = projectsOperations(a, { loaded: () => loaded, defaults })
  const planA = crypto.randomUUID()
  a.atomic((db) =>
    db
      .query(
        "INSERT INTO runner_plans(id,project_directory,owner,revision,version,state,body) VALUES(?,?,?,?,?,?,?)",
      )
      .run(planA, a.projectDirectory, "owner", 1, 1, "running", "{}"),
  )
  return { a, b, storeA, keyA, keyB, ops, planA, loaded }
}

test("list returns every project with checkouts, loaded state, pause and settings", async () => {
  const f = await fixture()
  const listing = f.ops.list()
  expect(listing.projects.map((p) => p.key)).toEqual([f.keyA, f.keyB])
  const [alpha, beta] = listing.projects
  expect(alpha).toMatchObject({
    name: "alpha",
    loaded: true,
    pause: null,
    architectContact: null,
    settings: { limit: null, weight: 1, spendCeilingTokens: null },
  })
  expect(alpha!.checkouts).toEqual([f.a.projectDirectory])
  expect(beta!.loaded).toBe(false)
  expect(listing.globalPause).toBeNull()
  expect(listing.globalSettings).toMatchObject({ agingMs: 600_000 })
})

test("a pause set through lz.projects is what effectivePause returns", async () => {
  const f = await fixture()
  expect(f.ops.setPause({ kind: "project", key: f.keyA }, true, " Rebuild ")).toEqual({ ok: true })
  expect(effectivePause(f.a, f.planA)).toMatchObject({
    level: "project",
    reason: "Rebuild",
    by: "owner",
  })
  expect(f.ops.list().projects[0]!.pause).toMatchObject({ reason: "Rebuild", by: "owner" })
  f.ops.setPause({ kind: "project", key: f.keyA }, false, "")
  expect(effectivePause(f.a, f.planA)).toBeUndefined()
  expect(f.ops.list().projects[0]!.pause).toBeNull()
})

test("two projects pause independently; global is separate", async () => {
  const f = await fixture()
  f.ops.setPause({ kind: "project", key: f.keyA }, true, "A")
  f.ops.setPause({ kind: "project", key: f.keyB }, true, "B")
  f.ops.setPause({ kind: "project", key: f.keyA }, false, "")
  const listing = f.ops.list()
  expect(listing.projects.map((p) => p.pause?.reason ?? null)).toEqual([null, "B"])
  expect(listing.globalPause).toBeNull()
  f.ops.setPause({ kind: "global" }, true, "Battery")
  expect(f.ops.list().globalPause).toMatchObject({ reason: "Battery", by: "owner" })
  expect(effectivePause(f.a, f.planA)?.level).toBe("global")
})

test("unpausing wakes the scheduler", async () => {
  const f = await fixture()
  let wakes = 0
  const ops = projectsOperations(f.a, { loaded: () => [], wake: () => void wakes++ })
  ops.setPause({ kind: "project", key: f.keyA }, true, "x")
  expect(wakes).toBe(0)
  ops.setPause({ kind: "project", key: f.keyA }, false, "")
  expect(wakes).toBe(1)
})

test("a code edit is stored; invalid and taken codes are refused and keep the old code", async () => {
  const f = await fixture()
  const before = f.ops.list().projects.map((p) => p.code)
  expect(f.ops.setCode(f.keyA, "ZED")).toEqual({ ok: true })
  expect(f.ops.list().projects[0]!.code).toBe("ZED")
  expect(f.ops.setCode(f.keyA, "bad code")).toMatchObject({
    ok: false,
    refusal: "PROJECT_CODE_INVALID",
  })
  expect(f.ops.setCode(f.keyB, "ZED")).toMatchObject({ ok: false, refusal: "PROJECT_CODE_TAKEN" })
  expect(f.ops.list().projects.map((p) => p.code)).toEqual(["ZED", before[1]!])
  expect(f.ops.setCode("path:missing", "QQ")).toMatchObject({
    ok: false,
    refusal: "PROJECT_MISSING",
  })
})

test("settings save, validate, and clearing falls back to the option default", async () => {
  const f = await fixture({ project: { spendCeilingTokens: 5000 } })
  const key = f.keyA
  const setting = (name: string, value: unknown) =>
    f.ops.setSetting({ kind: "project", key }, name, value)
  expect(f.ops.list().projects[0]!.settings.spendCeilingTokens).toBe(5000)
  expect(setting("limit", 3)).toEqual({ ok: true })
  expect(setting("weight", 2.5)).toEqual({ ok: true })
  expect(setting("spendCeilingTokens", 100)).toEqual({ ok: true })
  expect(f.ops.list().projects[0]!.settings).toMatchObject({
    limit: 3,
    weight: 2.5,
    spendCeilingTokens: 100,
  })
  expect(f.ops.list().projects[1]!.settings.limit).toBeNull()
  expect(setting("limit", 0)).toMatchObject({ ok: false, refusal: "SETTING_INVALID" })
  expect(setting("limit", 1.5)).toMatchObject({ ok: false, refusal: "SETTING_INVALID" })
  expect(setting("nope", 1)).toMatchObject({ ok: false, refusal: "SETTING_INVALID" })
  expect(setting("limit", "3")).toMatchObject({ ok: false, refusal: "SETTING_INVALID" })
  expect(f.ops.list().projects[0]!.settings.limit).toBe(3)
  setting("limit", null)
  setting("spendCeilingTokens", null)
  expect(f.ops.list().projects[0]!.settings).toMatchObject({
    limit: null,
    spendCeilingTokens: 5000,
  })
  expect(f.ops.setSetting({ kind: "project", key: "path:missing" }, "limit", 1)).toMatchObject({
    ok: false,
    refusal: "PROJECT_MISSING",
  })
  expect(f.ops.setSetting({ kind: "global" }, "globalSlots", 4)).toEqual({ ok: true })
  expect(f.ops.list().globalSettings.globalSlots).toBe(4)
})

test("structured and boolean settings save through the RPC and list back", async () => {
  const f = await fixture()
  const project = (name: string, value: unknown) =>
    f.ops.setSetting({ kind: "project", key: f.keyA }, name, value)
  const global = (name: string, value: unknown) => f.ops.setSetting({ kind: "global" }, name, value)
  const external = { kind: "external", providerID: "openrouter", modelID: "x" }
  expect(global("decisionModel", external)).toEqual({ ok: true })
  expect(global("decisionSlicer", "whole")).toEqual({ ok: true })
  expect(project("planningAutoDispatch", false)).toEqual({ ok: true })
  expect(f.ops.list().globalSettings).toMatchObject({
    decisionModel: external,
    decisionSlicer: "whole",
  })
  expect(f.ops.list().projects[0]!.settings.planningAutoDispatch).toBe(false)
  expect(global("decisionModel", { kind: "external" })).toMatchObject({
    ok: false,
    refusal: "SETTING_INVALID",
  })
  expect(project("planningAutoDispatch", "yes")).toMatchObject({
    ok: false,
    refusal: "SETTING_INVALID",
  })
  expect(global("decisionModel", null)).toEqual({ ok: true })
  expect(f.ops.list().globalSettings.decisionModel).toEqual({ kind: "local" })
})

test("a project's Architect-contact pause is shown with its reason", async () => {
  const f = await fixture()
  f.storeA.setArchitectContact("paused", "Fallow run")
  expect(f.ops.list().projects[0]!.architectContact).toEqual({ reason: "Fallow run" })
  expect(f.ops.list().projects[1]!.architectContact).toBeNull()
})

// --- project profile ---

const goodProfile = {
  verify: [{ id: "ok", command: "true" }],
  source: { include: ["*.txt"] },
}

/** A registered project in a real git repository, with a worktree stand-in for the native API. */
async function profileFixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "lazers-profile-rpc-")))
  const directory = join(parent, "project")
  mkdirSync(directory)
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", directory, ...args], { stdout: "pipe", stderr: "pipe" })
  git("init", "-q", "-b", "main")
  git("remote", "add", "origin", "git@h.com:a/p.git")
  writeFileSync(join(directory, "a.txt"), "x\n")
  git("add", "-A")
  git("-c", "user.name=f", "-c", "user.email=f@example.invalid", "commit", "-q", "-m", "base")
  const repository = new TaskRepository(join(parent, "db.sqlite"), directory)
  cleanups.push(() => {
    resetProjectAliasCache()
    repository.close()
    rmSync(parent, { recursive: true, force: true })
  })
  new RunnerStore(repository)
  const { key } = await registerProject(repository, { directory, opencodeProjectID: "p" })
  const other = new TaskRepository(join(parent, "db.sqlite"), join(parent, "other"))
  cleanups.push(() => other.close())
  const otherKey = (
    await registerProject(other, { directory: other.projectDirectory, opencodeProjectID: "o" })
  ).key
  const ops = projectsOperations(repository, {
    loaded: () => [directory],
    dataDirectory: join(parent, "data"),
    proofWorkspace: {
      async create({ base, name }) {
        const target = join(`${directory}.worktrees`, name)
        mkdirSync(`${directory}.worktrees`, { recursive: true })
        git("worktree", "add", "--detach", target, base)
        return target
      },
      async remove(target) {
        git("worktree", "remove", "--force", target)
      },
    },
  })
  cleanups.push(() => rmSync(`${directory}.worktrees`, { recursive: true, force: true }))
  return { repository, directory, key, otherKey, ops }
}

test("profile: no revisions reads as none, and list gains only the profile and dismissal fields", async () => {
  const f = await profileFixture()
  expect(f.ops.profile(f.key)).toEqual({ key: f.key, history: [], setupDismissedAt: null })
  expect(f.ops.list().projects.find((p) => p.key === f.key)).toMatchObject({
    profile: { state: "none" },
    settings: { setupDismissedAt: null },
  })
})

test("profile: a stored repository-map source filter shows as the legacy source", async () => {
  const f = await profileFixture()
  f.repository.atomic((db) =>
    db
      .query("INSERT INTO repo_map_sources VALUES(?,?,?,?)")
      .run(f.directory, JSON.stringify(["src/**/*.ts"]), "[]", 1),
  )
  expect(f.ops.profile(f.key).legacySource).toEqual({ include: ["src/**/*.ts"], exclude: [] })
})

test("a save proves the commands and is the active revision at once; a second save supersedes it", async () => {
  const f = await profileFixture()
  const outcome = await f.ops.saveProfile({ key: f.key, profile: goodProfile, reason: "first" })
  expect(outcome).toMatchObject({ ok: true, revision: 1 })
  if (!outcome.ok) throw new Error("unreachable")
  expect(outcome.proofs.map((p) => `${p.key}:${p.outcome}`)).toEqual(["verify:ok:proven"])
  expect(outcome.changes.every((c) => c.kind === "added")).toBe(true)
  // Active immediately, with no further step.
  expect(f.ops.list().projects.find((p) => p.key === f.key)!.profile).toEqual({
    state: "active",
    revision: 1,
  })
  expect(activeProfile(f.repository, f.directory)?.revision).toBe(1)
  expect(f.ops.profile(f.key).active?.profile).toMatchObject({ verify: [{ id: "ok" }] })
  const second = await f.ops.saveProfile({
    key: f.key,
    profile: { ...goodProfile, verify: [{ id: "ok", command: "true # again" }] },
    reason: "second",
  })
  expect(second).toMatchObject({ ok: true, revision: 2 })
  if (!second.ok) throw new Error("unreachable")
  expect(second.changes).toEqual([
    { field: "verify", kind: "changed", key: "ok", before: "true", after: "true # again" },
  ])
  const view = f.ops.profile(f.key)
  expect(view.active?.revision).toBe(2)
  expect(view.history.map((revision) => [revision.revision, revision.state])).toEqual([
    [1, "superseded"],
  ])
})

test("an invalid profile is refused with its field and stores nothing", async () => {
  const f = await profileFixture()
  const outcome = await f.ops.saveProfile({
    key: f.key,
    profile: { ...goodProfile, verify: [] },
    reason: "bad",
  })
  expect(outcome).toMatchObject({ ok: false, refusal: "PROFILE_INVALID" })
  expect(!outcome.ok && outcome.message).toContain("verify")
  expect(f.ops.profile(f.key).active).toBeUndefined()
})

test("saving for another project's key is refused as not loaded", async () => {
  const f = await profileFixture()
  expect(
    await f.ops.saveProfile({ key: f.otherKey, profile: goodProfile, reason: "x" }),
  ).toMatchObject({ ok: false, refusal: "PROJECT_NOT_LOADED" })
})

test("credential-looking env names are listed with the revision", async () => {
  const f = await profileFixture()
  await f.ops.saveProfile({
    key: f.key,
    profile: { ...goodProfile, env: ["NPM_TOKEN", "CARGO_HOME"] },
    reason: "x",
  })
  expect(f.ops.profile(f.key).active?.credentialLikeEnv).toEqual(["NPM_TOKEN"])
})

// --- setup notice ---

test("setupStatus answers for this project's sessions only, and startSetup opens a prompted session", async () => {
  const f = await profileFixture()
  const calls: { method: string; input: Record<string, any> }[] = []
  const { Effect } = await import("effect")
  const ops = projectsOperations(f.repository, {
    loaded: () => [f.directory],
    sessionOf: async (id) => (id === "mine" ? { id, agent: "architect", archived: false } : null),
    setupSession: {
      create: (input: any) => Effect.sync(() => void calls.push({ method: "create", input })),
      prompt: (input: any) => Effect.sync(() => void calls.push({ method: "prompt", input })),
    } as never,
  })
  expect(await ops.setupStatus("mine")).toMatchObject({
    ok: true,
    key: f.key,
    state: "none",
    dismissed: false,
  })
  expect(await ops.setupStatus("foreign")).toMatchObject({
    ok: false,
    refusal: "PROJECT_NOT_LOADED",
  })
  expect(ops.dismissSetup(f.key)).toEqual({ ok: true })
  expect(await ops.setupStatus("mine")).toMatchObject({ dismissed: true })
  const started = await ops.startSetup("mine")
  expect(started).toMatchObject({ ok: true })
  expect(calls[0]!.input).toMatchObject({
    agent: "architect",
    metadata: { lazersProjectSetup: f.key },
  })
  expect(calls[1]!.input.text.startsWith("## Setting up this project's verification profile")).toBe(
    true,
  )
  expect((await ops.setupStatus("mine")) as never).toMatchObject({ dismissed: false })
  expect(await ops.startSetup("foreign")).toMatchObject({ ok: false })
})

test("a setup session that cannot be prompted leaves the dismissal in place", async () => {
  const f = await profileFixture()
  const { Effect } = await import("effect")
  const ops = projectsOperations(f.repository, {
    loaded: () => [f.directory],
    sessionOf: async (id) => ({ id, agent: "architect", archived: false }),
    setupSession: {
      create: () => Effect.void,
      prompt: () => Effect.fail(new Error("no model")),
    } as never,
  })
  ops.dismissSetup(f.key)
  expect(await ops.startSetup("s")).toMatchObject({ ok: false, refusal: "PROJECT_NOT_LOADED" })
  expect(await ops.setupStatus("s")).toMatchObject({ dismissed: true })
  expect(ops.resumeSetupNotice(f.key)).toEqual({ ok: true })
  expect(await ops.setupStatus("s")).toMatchObject({ dismissed: false })
})

test("setupStatus reports an active profile", async () => {
  const f = await profileFixture()
  const ops = projectsOperations(f.repository, {
    loaded: () => [f.directory],
    sessionOf: async (id) => ({ id, agent: "architect", archived: false }),
    proofWorkspace: undefined as never,
  })
  const withWorkspace = f.ops
  await withWorkspace.saveProfile({ key: f.key, profile: goodProfile, reason: "x" })
  expect(await ops.setupStatus("s")).toMatchObject({ state: "active" })
})

test("saving a profile drops the stored source filter of every checkout, in one transaction", async () => {
  const f = await profileFixture()
  // A second checkout of the same project, with its own stored filter.
  const second = join(f.directory, "..", "second-checkout")
  mkdirSync(second)
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", second, ...args], { stdout: "pipe", stderr: "pipe" })
  git("init", "-q", "-b", "main")
  git("remote", "add", "origin", "git@h.com:a/p.git")
  const other = new TaskRepository(f.repository.path, second)
  const registered = await registerProject(other, { directory: second, opencodeProjectID: "p" })
  other.close()
  expect(registered.key).toBe(f.key)
  const seed = (directory: string) =>
    f.repository.atomic((db) =>
      db
        .query("INSERT INTO repo_map_sources VALUES(?,?,?,?)")
        .run(directory, JSON.stringify(["src/**/*.ts"]), "[]", 1),
    )
  seed(f.directory)
  seed(second)
  const rows = () =>
    f.repository.read(
      (db) => db.query("SELECT COUNT(*) AS n FROM repo_map_sources").get() as { n: number },
    ).n
  expect(rows()).toBe(2)
  await f.ops.saveProfile({ key: f.key, profile: goodProfile, reason: "x" })
  expect(rows()).toBe(0)
})
