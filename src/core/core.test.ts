import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin/effect"
import { CapabilityHub, NoCapabilityProviderError } from "./capabilities.ts"
import { acquireLazersCore, coreConstructions, createLazersCore, coreKey } from "./core.ts"
import type { LazersCoreHandle, LazersCoreInfo } from "./core.ts"
import { acquireCore, coreSnapshot } from "./registry.ts"
import { schedulerProjectKey, sharedScheduler } from "../runner/scheduler-coordinator.ts"

const roots: string[] = []
const handles: LazersCoreHandle[] = []

function root() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "lazers-core-")))
  roots.push(path)
  return path
}

function fixture(data: string, project: string, id: string) {
  const location = (directory: string) => {
    mkdirSync(directory, { recursive: true })
    const info: LazersCoreInfo = {
      dataDirectory: data,
      projectID: id,
      projectDirectory: project,
      directory,
      options: {},
    }
    // Only inert fields: the core must not call native capabilities while constructing.
    const ctx = {
      tag: directory,
      app: { version: "test" },
      location: { directory, project: { id, canonical: project } },
      options: {},
    } as unknown as Plugin.Context
    return { ctx, info }
  }
  return location
}

const counts = () => ({ ...coreConstructions })
const delta = (before: Record<string, number>) =>
  Object.fromEntries(
    Object.entries(coreConstructions)
      .map(([name, value]) => [name, value - (before[name] ?? 0)] as const)
      .filter(([, value]) => value !== 0),
  )

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.release()
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

test("N adapters on one project share exactly one of each core object", async () => {
  const project = root()
  const location = fixture(root(), project, "project-a")
  const before = counts()
  const locations = Array.from({ length: 44 }, (_, i) =>
    location(i === 0 ? project : join(project, `wt-${i}`)),
  )
  for (const { ctx, info } of locations) handles.push(acquireLazersCore(ctx, info))
  expect(new Set(handles.map((handle) => handle.core)).size).toBe(1)
  expect(delta(before)).toEqual({
    repository: 1,
    projectIndex: 1,
    runnerStore: 1,
    progress: 1,
    runtime: 1,
    retention: 1,
    schedulerParticipant: 1,
  })
  const { core } = handles[0]!
  expect(
    sharedScheduler.projectStatus(
      schedulerProjectKey(core.repository.path, core.repository.projectDirectory, "project-a"),
    ).participants,
  ).toBe(1)
  expect(coreSnapshot().filter((entry) => entry.refs === 44)).toHaveLength(1)
  // The per-checkout index is lazy and shared per directory.
  expect(core.indexFor(project)).toBe(core.indexFor(project))
  expect(delta(before).projectIndex).toBe(1)
})

test("before: constructing the full stack per location multiplies every object", async () => {
  const project = root()
  const location = fixture(root(), project, "project-legacy")
  const before = counts()
  const built = Array.from({ length: 5 }, (_, i) => {
    const { ctx, info } = location(i === 0 ? project : join(project, `wt-${i}`))
    const hub = new CapabilityHub<Plugin.Context>(`legacy-${i}`, project)
    hub.register(info.directory, ctx)
    return createLazersCore(hub, info)
  })
  expect(delta(before)).toEqual({
    repository: 5,
    projectIndex: 5,
    runnerStore: 5,
    progress: 5,
    runtime: 5,
    retention: 5,
    schedulerParticipant: 5,
  })
  for (const { dispose } of built) await dispose()
})

test("releasing the preferred capability location fails over, last release disposes", async () => {
  const project = root()
  const location = fixture(root(), project, "project-b")
  const rootLocation = location(project)
  const other = location(join(project, "wt"))
  const third = location(join(project, "wt2"))
  const first = acquireLazersCore(other.ctx, other.info)
  const second = acquireLazersCore(rootLocation.ctx, rootLocation.info)
  const last = acquireLazersCore(third.ctx, third.info)
  const hub = first.hub
  const tag = () => (hub.context as unknown as { tag: string }).tag
  expect(tag()).toBe(project)
  expect(hub.contextAt(join(project, "wt")) as unknown).toMatchObject({ tag: join(project, "wt") })
  const key = schedulerProjectKey(first.core.repository.path, project, "project-b")
  await second.release()
  expect(tag()).toBe(join(project, "wt"))
  expect(hub.failovers).toBe(1)
  // A location that is gone falls back to the preferred live one.
  expect((hub.contextAt(project) as unknown as { tag: string }).tag).toBe(join(project, "wt"))
  await first.release()
  expect(tag()).toBe(join(project, "wt2"))
  expect(sharedScheduler.projectStatus(key).participants).toBe(1)
  await last.release()
  expect(coreSnapshot().some((entry) => entry.key === coreKey(rootLocation.info))).toBe(false)
  expect(sharedScheduler.projectStatus(key).status).toBe("absent")
  expect(() => hub.context.location).toThrow(NoCapabilityProviderError)
  await last.release()
})

test("different projects get separate cores and schedulers", async () => {
  const data = root()
  const a = root()
  const b = root()
  const one = fixture(data, a, "project-1")(a)
  const two = fixture(data, b, "project-2")(b)
  const handleA = acquireLazersCore(one.ctx, one.info)
  const handleB = acquireLazersCore(two.ctx, two.info)
  handles.push(handleA, handleB)
  expect(handleA.core).not.toBe(handleB.core)
  expect(handleA.key).not.toBe(handleB.key)
  for (const [handle, id] of [
    [handleA, "project-1"],
    [handleB, "project-2"],
  ] as const)
    expect(
      sharedScheduler.projectStatus(
        schedulerProjectKey(
          handle.core.repository.path,
          handle.core.repository.projectDirectory,
          id,
        ),
      ).participants,
    ).toBe(1)
})

test("registry is keyed structurally across separate module copies", async () => {
  const copy = (name: string) => `./registry.ts?copy=${name}`
  const one = (await import(copy("one"))) as typeof import("./registry.ts")
  const two = (await import(copy("two"))) as typeof import("./registry.ts")
  expect(one.acquireCore).not.toBe(two.acquireCore)
  let created = 0
  let disposed = 0
  const spec = (directory: string) => ({
    key: "structural-key",
    projectDirectory: "/project",
    directory,
    ctx: { directory },
    create: () => {
      created++
      return { core: { id: created }, dispose: () => void disposed++ }
    },
  })
  const a = one.acquireCore(spec("/project"))
  const b = two.acquireCore(spec("/project/wt"))
  expect(a.core).toBe(b.core)
  expect(created).toBe(1)
  expect(one.coreSnapshot()).toEqual(two.coreSnapshot())
  await a.release()
  expect(disposed).toBe(0)
  await b.release()
  expect(disposed).toBe(1)
  expect(acquireCore(spec("/project")).core).not.toBe(a.core)
  expect(created).toBe(2)
  await acquireCore(spec("/project")).release()
})
