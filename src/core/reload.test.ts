import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin/effect"
import { acquireLazersCore, coreKey } from "./core.ts"
import type { LazersCoreHandle } from "./core.ts"
import { computeGeneration, moduleGeneration } from "./generation.ts"
import { coreSnapshot } from "./registry.ts"
import { schedulerProjectKey, sharedScheduler } from "../runner/scheduler-coordinator.ts"

const roots: string[] = []
const handles: LazersCoreHandle[] = []

function root() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "lazers-reload-")))
  roots.push(path)
  return path
}

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.release()
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

test("code generation stamp is stable for unchanged sources and changes with edits", () => {
  const source = root()
  writeFileSync(join(source, "a.ts"), "export const a = 1\n")
  const first = computeGeneration(source)
  expect(computeGeneration(source)).toBe(first)
  writeFileSync(join(source, "a.ts"), "export const a = 22\n")
  expect(computeGeneration(source)).not.toBe(first)
  const second = computeGeneration(source)
  mkdirSync(join(source, "nested"))
  writeFileSync(join(source, "nested", "b.tsx"), "export {}\n")
  expect(computeGeneration(source)).not.toBe(second)
  const base = { dataDirectory: root(), projectID: "p", projectDirectory: root() }
  expect(coreKey({ ...base, generation: "one" })).not.toBe(coreKey({ ...base, generation: "two" }))
  expect(coreKey(base)).toBe(coreKey({ ...base, generation: moduleGeneration() }))
})

test("reload with changed code builds a second core; one lease owner; old core drains", async () => {
  const data = root()
  const project = root()
  const acquire = (directory: string, generation: string) => {
    mkdirSync(directory, { recursive: true })
    const ctx = {
      tag: directory,
      app: { version: "test" },
      location: { directory, project: { id: "project-reload", canonical: project } },
      options: {},
    } as unknown as Plugin.Context
    return acquireLazersCore(ctx, {
      dataDirectory: data,
      projectID: "project-reload",
      projectDirectory: project,
      directory,
      options: {},
      generation,
    })
  }
  const old = [project, join(project, "old-1"), join(project, "old-2")].map((directory) =>
    acquire(directory, "old"),
  )
  const fresh = [join(project, "new-0"), join(project, "new-1")].map((directory) =>
    acquire(directory, "new"),
  )
  handles.push(...old, ...fresh)
  const oldCore = old[0]!.core
  const newCore = fresh[0]!.core
  expect(new Set(old.map((handle) => handle.core)).size).toBe(1)
  expect(new Set(fresh.map((handle) => handle.core)).size).toBe(1)
  expect(oldCore).not.toBe(newCore)
  const key = schedulerProjectKey(oldCore.repository.path, project, "project-reload")
  expect(sharedScheduler.projectStatus(key).participants).toBe(2)
  // The durable lease admits exactly one tick owner across both runtimes.
  const store = oldCore.runnerStore
  const oldFence = store.claim(oldCore.runtime.owner)
  expect(oldFence).not.toBeNull()
  expect(store.claim(newCore.runtime.owner)).toBeNull()
  expect(() => store.fenced(newCore.runtime.owner, oldFence!, () => 1)).toThrow("Stale")
  expect(store.fenced(oldCore.runtime.owner, oldFence!, () => 1)).toBe(1)
  // The old core survives until its last old location releases.
  await old[0]!.release()
  await old[1]!.release()
  expect(sharedScheduler.projectStatus(key).participants).toBe(2)
  await old[2]!.release()
  expect(sharedScheduler.projectStatus(key).participants).toBe(1)
  expect(coreSnapshot().filter((entry) => entry.key.includes("project-reload"))).toHaveLength(1)
  // After the old lease expires the surviving core takes over with a newer fence.
  newCore.runnerStore.atomic((db) => db.query("UPDATE runner_leases SET expires_at=0").run())
  const takeover = newCore.runnerStore.claim(newCore.runtime.owner)
  expect(takeover).toBeGreaterThan(oldFence!)
  expect(() => newCore.runnerStore.fenced(oldCore.runtime.owner, oldFence!, () => 1)).toThrow(
    "Stale",
  )
})
