import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerProject } from "../project-key.ts"
import { RunnerStore } from "../runner/store.ts"
import { TaskRepository } from "../storage.ts"
import { effectivePause } from "./pause.ts"
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
